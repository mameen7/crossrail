import { INestApplication } from '@nestjs/common';
import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ApiErrorBody } from '../src/common/api-error';
import { FALLBACK_RATES } from '../src/fx/fallback-rates';
import { UsdRateTable } from '../src/fx/fiat';
import { crossRate } from '../src/fx/pricing';
import { TransactionDto } from '../src/transactions/dto/transaction.dto';
import { WalletBalancesDto, WalletDto } from '../src/wallets/dto/wallet.dto';
import { bootApp } from './app';
import { assertLedgerMatchesBalances, truncateAll, waitForLockWaiters } from './db';
import { FxStub, startFxProvider } from './fx-stub';

/** env.ts points every app at a blocked port (fails at once, no network); captured before bootApp overrides it. */
const BLOCKED_URL = process.env.FX_PROVIDER_URL ?? 'http://127.0.0.1:9/v6/latest/USD';

/**
 * The swaps suite's provider table, so cross rates are short exact decimals:
 *   cNGN → USDx  1/1600  = 0.000625                (150000 cNGN → 93.75 USDx)
 *   cGHS → cNGN  1600/11 = 145.454545454545454545… (1 cGHS → 145.45454545, a visible round-down)
 *   cXAF → USDx  1/500   = 0.002                   (0.00000001 cXAF → 2e-11 → rounds to zero)
 */
const STUB_BODY =
  '{"result":"success","base_code":"USD","rates":' +
  '{"USD":1,"EUR":0.8,"NGN":1600,"GHS":11,"XAF":500,"JPY":150}}';
const STUB_TABLE: UsdRateTable = { USD: '1', EUR: '0.8', NGN: '1600', GHS: '11', XAF: '500' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Sorts before and after every random v4 id, so a missing row is met first or last in lock order. */
const UNKNOWN_LOW = '00000000-0000-4000-8000-000000000000';
const UNKNOWN_HIGH = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const ENDPOINT = 'POST /transfers';
const ONE = '1.000000000000000000';

interface Counts {
  transactions: number;
  ledgerEntries: number;
  idempotencyKeys: number;
}

interface StoredTx {
  type: string;
  wallet_id: string | null;
  sender_wallet_id: string;
  receiver_wallet_id: string;
  source_currency: string;
  source_amount: string;
  destination_currency: string;
  destination_amount: string;
  fx_rate: string;
  rate_source: string;
}

/**
 * The spec's rule, recomputed here from scratch (not through the Money
 * utility): destination = round_down(source × stored 18 dp rate, 8 dp).
 */
const expectedDestination = (source: string, fxRate: string): string =>
  new Decimal(source).times(new Decimal(fxRate)).toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(8);

describe('POST /api/v1/transfers (e2e)', () => {
  let provider: FxStub;
  let app: INestApplication<App>;
  let db: DataSource;

  const api = () => request(app.getHttpServer());

  const createWallet = async (): Promise<string> => {
    const res = await api()
      .post('/api/v1/wallets')
      .send({ email: `${randomUUID()}@example.com` })
      .expect(201);
    return (res.body as WalletDto).id;
  };

  /** Funding always goes through the deposits endpoint so the ledger invariant keeps holding. */
  const deposit = (walletId: string, currency: string, amount: string) =>
    api()
      .post(`/api/v1/wallets/${walletId}/deposits`)
      .set('Idempotency-Key', randomUUID())
      .send({ currency, amount })
      .expect(201);

  const transfer = (body: object, key?: string) => {
    const req = api().post('/api/v1/transfers');
    return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
  };

  const balances = async (walletId: string): Promise<Record<string, string>> => {
    const res = await api().get(`/api/v1/wallets/${walletId}`).expect(200);
    return (res.body as WalletBalancesDto).balances as unknown as Record<string, string>;
  };

  const balance = async (walletId: string, currency: string): Promise<string> =>
    (await balances(walletId))[currency] ?? 'missing';

  const ZERO_BALANCES = {
    cNGN: '0.00000000',
    cGHS: '0.00000000',
    cXAF: '0.00000000',
    USDx: '0.00000000',
    EURx: '0.00000000',
  };

  const counts = async (): Promise<Counts> => {
    const [row] = await db.query<Counts[]>(`
      SELECT (SELECT count(*) FROM transactions)::int     AS transactions,
             (SELECT count(*) FROM ledger_entries)::int   AS "ledgerEntries",
             (SELECT count(*) FROM idempotency_keys)::int AS "idempotencyKeys"
    `);
    return row!;
  };

  const storedTx = async (id: string): Promise<StoredTx> => {
    const [row] = await db.query<StoredTx[]>(
      `SELECT type, wallet_id, sender_wallet_id, receiver_wallet_id,
              source_currency, source_amount::text, destination_currency,
              destination_amount::text, fx_rate::text, rate_source
         FROM transactions WHERE id = $1`,
      [id],
    );
    return row!;
  };

  const ledgerEntries = (transactionId: string): Promise<Record<string, unknown>[]> =>
    db.query(
      `SELECT wallet_id, currency, amount FROM ledger_entries
        WHERE transaction_id = $1 ORDER BY amount`,
      [transactionId],
    );

  /** Asserts the stored amounts obey the rule and the DTO rendered exactly the stored row. */
  const expectDerivedFromStoredRate = async (body: TransactionDto): Promise<StoredTx> => {
    const row = await storedTx(body.id);
    expect(row.destination_amount).toBe(expectedDestination(row.source_amount, row.fx_rate));
    expect(body.source).toEqual({
      wallet_id: row.sender_wallet_id,
      currency: row.source_currency,
      amount: row.source_amount,
    });
    expect(body.destination).toEqual({
      wallet_id: row.receiver_wallet_id,
      currency: row.destination_currency,
      amount: row.destination_amount,
    });
    expect(body.fx_rate).toBe(row.fx_rate);
    expect(body.rate_source).toBe(row.rate_source);
    return row;
  };

  beforeAll(async () => {
    provider = await startFxProvider(STUB_BODY);
    app = await bootApp({ url: provider.url, timeoutMs: 1000 });
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  // The spec's invariant holds after every test, successful or not.
  afterEach(async () => {
    await assertLedgerMatchesBalances(db);
  });

  afterAll(async () => {
    await truncateAll(db);
    await app.close();
    await provider.close();
  });

  describe('scenario 8: transfers, same- and cross-currency', () => {
    it('moves a same-currency amount unchanged at rate 1, source "none", and writes a ledger entry on each wallet', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'cNGN', '100');
      const before = Date.now();

      const res = await transfer(
        {
          sender_wallet_id: sender,
          receiver_wallet_id: receiver,
          source_currency: 'cNGN',
          source_amount: '40.5',
          destination_currency: 'cNGN',
        },
        randomUUID(),
      ).expect(201);
      const body = res.body as TransactionDto;

      expect(res.headers['idempotent-replay']).toBeUndefined();
      expect(body).toEqual({
        id: expect.stringMatching(UUID_RE) as string,
        type: 'transfer',
        status: 'completed',
        source: { wallet_id: sender, currency: 'cNGN', amount: '40.50000000' },
        destination: { wallet_id: receiver, currency: 'cNGN', amount: '40.50000000' },
        fx_rate: ONE,
        rate_source: 'none',
        created_at: expect.any(String) as string,
      });
      expect(new Date(body.created_at).toISOString()).toBe(body.created_at);
      expect(new Date(body.created_at).getTime()).toBeGreaterThanOrEqual(before - 1000);

      expect(await storedTx(body.id)).toEqual({
        type: 'transfer',
        wallet_id: null,
        sender_wallet_id: sender,
        receiver_wallet_id: receiver,
        source_currency: 'cNGN',
        source_amount: '40.50000000',
        destination_currency: 'cNGN',
        destination_amount: '40.50000000',
        fx_rate: ONE,
        rate_source: 'none',
      });
      expect(await ledgerEntries(body.id)).toEqual([
        { wallet_id: sender, currency: 'cNGN', amount: '-40.50000000' },
        { wallet_id: receiver, currency: 'cNGN', amount: '40.50000000' },
      ]);
      expect(await balances(sender)).toEqual({ ...ZERO_BALANCES, cNGN: '59.50000000' });
      expect(await balances(receiver)).toEqual({ ...ZERO_BALANCES, cNGN: '40.50000000' });
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });
    });

    it('defaults an omitted destination_currency to the source currency', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'EURx', '5');

      const res = await transfer(
        {
          sender_wallet_id: sender,
          receiver_wallet_id: receiver,
          source_currency: 'EURx',
          source_amount: '5',
        },
        randomUUID(),
      ).expect(201);
      const body = res.body as TransactionDto;

      expect(body.source).toEqual({ wallet_id: sender, currency: 'EURx', amount: '5.00000000' });
      expect(body.destination).toEqual({
        wallet_id: receiver,
        currency: 'EURx',
        amount: '5.00000000',
      });
      expect(body.fx_rate).toBe(ONE);
      expect(body.rate_source).toBe('none');
      expect(await balance(sender, 'EURx')).toBe('0.00000000');
      expect(await balances(receiver)).toEqual({ ...ZERO_BALANCES, EURx: '5.00000000' });
    });

    it('converts across currencies at the stored rate and credits the receiver the converted amount', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'cNGN', '150000');
      const key = randomUUID();

      const res = await transfer(
        {
          sender_wallet_id: sender,
          receiver_wallet_id: receiver,
          source_currency: 'cNGN',
          source_amount: '150000.00',
          destination_currency: 'USDx',
        },
        key,
      ).expect(201);
      const body = res.body as TransactionDto;

      expect(body).toEqual({
        id: expect.stringMatching(UUID_RE) as string,
        type: 'transfer',
        status: 'completed',
        source: { wallet_id: sender, currency: 'cNGN', amount: '150000.00000000' },
        destination: { wallet_id: receiver, currency: 'USDx', amount: '93.75000000' },
        fx_rate: '0.000625000000000000',
        rate_source: 'live',
        created_at: expect.any(String) as string,
      });
      expect(body.fx_rate).toBe(crossRate(STUB_TABLE, 'cNGN', 'USDx'));
      const row = await expectDerivedFromStoredRate(body);
      expect(row).toMatchObject({ type: 'transfer', wallet_id: null });

      expect(await ledgerEntries(body.id)).toEqual([
        { wallet_id: sender, currency: 'cNGN', amount: '-150000.00000000' },
        { wallet_id: receiver, currency: 'USDx', amount: '93.75000000' },
      ]);
      expect(await balances(sender)).toEqual(ZERO_BALANCES);
      expect(await balances(receiver)).toEqual({ ...ZERO_BALANCES, USDx: '93.75000000' });
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });

      const keys: Record<string, unknown>[] = await db.query(
        'SELECT endpoint, response_status, transaction_id FROM idempotency_keys WHERE key = $1',
        [key],
      );
      expect(keys).toEqual([{ endpoint: ENDPOINT, response_status: 201, transaction_id: body.id }]);
    });

    it('rounds the converted amount down at 8 dp and never disagrees with the stored rate', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'cGHS', '1');

      const res = await transfer(
        {
          sender_wallet_id: sender,
          receiver_wallet_id: receiver,
          source_currency: 'cGHS',
          source_amount: '1',
          destination_currency: 'cNGN',
        },
        randomUUID(),
      ).expect(201);
      const body = res.body as TransactionDto;

      expect(body.fx_rate).toBe('145.454545454545454545');
      expect(body.destination.amount).toBe('145.45454545');
      await expectDerivedFromStoredRate(body);
      expect(await balance(sender, 'cGHS')).toBe('0.00000000');
      expect(await balance(receiver, 'cNGN')).toBe('145.45454545');
    });

    it('returns 422 SELF_TRANSFER when sender equals receiver, comparing the lowercased ids', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '10');

      const res = await transfer(
        {
          sender_wallet_id: walletId.toUpperCase(),
          receiver_wallet_id: walletId,
          source_currency: 'cNGN',
          source_amount: '1',
        },
        randomUUID(),
      ).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'SELF_TRANSFER',
          message: expect.any(String) as string,
          details: { wallet_id: walletId },
        },
      });
      expect(await balance(walletId, 'cNGN')).toBe('10.00000000');
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });
    });
  });

  describe('failures that leave both wallets untouched', () => {
    it('returns 422 INSUFFICIENT_FUNDS, moves nothing on either wallet and does not consume the key', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'cNGN', '100');
      await deposit(receiver, 'USDx', '7');
      const key = randomUUID();
      const body = {
        sender_wallet_id: sender,
        receiver_wallet_id: receiver,
        source_currency: 'cNGN',
        source_amount: '150',
        destination_currency: 'USDx',
      };

      const res = await transfer(body, key).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'INSUFFICIENT_FUNDS',
          message: expect.any(String) as string,
          details: {
            wallet_id: sender,
            currency: 'cNGN',
            available: '100.00000000',
            requested: '150.00000000',
          },
        },
      });
      expect(await balances(sender)).toEqual({ ...ZERO_BALANCES, cNGN: '100.00000000' });
      expect(await balances(receiver)).toEqual({ ...ZERO_BALANCES, USDx: '7.00000000' });
      // Only the two funding deposits persisted: no transfer row, no key row for the failed attempt.
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 2, idempotencyKeys: 2 });

      // After a top-up the same key and body go through as a fresh request.
      await deposit(sender, 'cNGN', '50');
      const retry = await transfer(body, key).expect(201);
      expect(retry.headers['idempotent-replay']).toBeUndefined();
      expect((retry.body as TransactionDto).type).toBe('transfer');
      expect(await balance(sender, 'cNGN')).toBe('0.00000000');
      expect(await balance(receiver, 'USDx')).toBe('7.09375000');
      expect(await counts()).toEqual({ transactions: 4, ledgerEntries: 5, idempotencyKeys: 4 });
    });

    it('returns 422 AMOUNT_TOO_SMALL when the conversion rounds to zero at 8 dp', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'cXAF', '1'); // funded, so this cannot be mistaken for insufficient funds

      const res = await transfer(
        {
          sender_wallet_id: sender,
          receiver_wallet_id: receiver,
          source_currency: 'cXAF',
          source_amount: '0.00000001',
          destination_currency: 'USDx',
        },
        randomUUID(),
      ).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'AMOUNT_TOO_SMALL',
          message: expect.any(String) as string,
          details: {
            from_currency: 'cXAF',
            to_currency: 'USDx',
            amount: '0.00000001',
            fx_rate: '0.002000000000000000',
          },
        },
      });
      expect(await balance(sender, 'cXAF')).toBe('1.00000000');
      expect(await balances(receiver)).toEqual(ZERO_BALANCES);
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });
    });

    it.each([
      ['first', UNKNOWN_LOW],
      ['last', UNKNOWN_HIGH],
    ])(
      'returns 404 WALLET_NOT_FOUND naming an unknown sender met %s in lock order; the key is not consumed',
      async (_order, unknown) => {
        const receiver = await createWallet();
        const key = randomUUID();

        const res = await transfer(
          {
            sender_wallet_id: unknown,
            receiver_wallet_id: receiver,
            source_currency: 'cNGN',
            source_amount: '1',
          },
          key,
        ).expect(404);
        expect((res.body as ApiErrorBody).error).toMatchObject({
          code: 'WALLET_NOT_FOUND',
          details: { id: unknown },
        });
        expect(await balances(receiver)).toEqual(ZERO_BALANCES);
        expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });

        // The failed attempt rolled its key row back, so the same key now succeeds.
        const sender = await createWallet();
        await deposit(sender, 'cNGN', '1');
        await transfer(
          {
            sender_wallet_id: sender,
            receiver_wallet_id: receiver,
            source_currency: 'cNGN',
            source_amount: '1',
          },
          key,
        ).expect(201);
        expect(await balance(receiver, 'cNGN')).toBe('1.00000000');
      },
    );

    it.each([
      ['first', UNKNOWN_LOW],
      ['last', UNKNOWN_HIGH],
    ])(
      'returns 404 WALLET_NOT_FOUND naming an unknown receiver met %s in lock order; the sender keeps its funds',
      async (_order, unknown) => {
        const sender = await createWallet();
        await deposit(sender, 'cNGN', '10');

        const res = await transfer(
          {
            sender_wallet_id: sender,
            receiver_wallet_id: unknown,
            source_currency: 'cNGN',
            source_amount: '1',
            destination_currency: 'USDx',
          },
          randomUUID(),
        ).expect(404);
        expect((res.body as ApiErrorBody).error).toMatchObject({
          code: 'WALLET_NOT_FOUND',
          details: { id: unknown },
        });
        expect(await balances(sender)).toEqual({ ...ZERO_BALANCES, cNGN: '10.00000000' });
        expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });
      },
    );
  });

  describe('idempotency', () => {
    it('replays the stored response for the same key and request, even with reordered fields, uppercased ids and the default spelled out', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'cNGN', '10');
      const key = randomUUID();

      const first = await transfer(
        {
          sender_wallet_id: sender,
          receiver_wallet_id: receiver,
          source_currency: 'cNGN',
          source_amount: '4',
        },
        key,
      ).expect(201);
      const second = await transfer(
        {
          destination_currency: 'cNGN',
          source_amount: '4',
          source_currency: 'cNGN',
          receiver_wallet_id: receiver.toUpperCase(),
          sender_wallet_id: sender.toUpperCase(),
        },
        key,
      ).expect(201);

      expect(first.headers['idempotent-replay']).toBeUndefined();
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);

      expect(await balance(sender, 'cNGN')).toBe('6.00000000');
      expect(await balance(receiver, 'cNGN')).toBe('4.00000000');
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });
    });

    it('returns 422 IDEMPOTENCY_KEY_REUSED for the same key with a different body, writing nothing', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'cNGN', '10');
      const key = randomUUID();
      const body = {
        sender_wallet_id: sender,
        receiver_wallet_id: receiver,
        source_currency: 'cNGN',
        source_amount: '5',
      };
      await transfer(body, key).expect(201);

      const res = await transfer({ ...body, destination_currency: 'USDx' }, key).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: expect.any(String) as string,
          details: { key, endpoint: ENDPOINT },
        },
      });
      expect(res.headers['idempotent-replay']).toBeUndefined();
      expect(await balance(sender, 'cNGN')).toBe('5.00000000');
      expect(await balances(receiver)).toEqual({ ...ZERO_BALANCES, cNGN: '5.00000000' });
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });
    });

    it('returns 400 IDEMPOTENCY_KEY_REQUIRED without a key, and writes nothing', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      const res = await transfer({
        sender_wallet_id: sender,
        receiver_wallet_id: receiver,
        source_currency: 'cNGN',
        source_amount: '5',
      }).expect(400);
      expect(res.body).toEqual({
        error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: expect.any(String) as string },
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });
  });

  describe('validation', () => {
    it.each([
      ['source_currency', { source_currency: 'BTC', destination_currency: 'USDx' }],
      ['source_currency', { source_currency: 'BTC' }],
      ['destination_currency', { source_currency: 'cNGN', destination_currency: 'BTC' }],
    ])('returns 422 UNSUPPORTED_CURRENCY naming %s', async (field, currencies) => {
      const sender = await createWallet();
      const receiver = await createWallet();
      const res = await transfer(
        {
          sender_wallet_id: sender,
          receiver_wallet_id: receiver,
          source_amount: '1',
          ...currencies,
        },
        randomUUID(),
      ).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'UNSUPPORTED_CURRENCY',
          message: expect.any(String) as string,
          details: { field, value: 'BTC' },
        },
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });

    it('checks currencies before the self-transfer rule', async () => {
      const walletId = await createWallet();
      const res = await transfer(
        {
          sender_wallet_id: walletId,
          receiver_wallet_id: walletId,
          source_currency: 'BTC',
          source_amount: '1',
        },
        randomUUID(),
      ).expect(422);
      expect((res.body as ApiErrorBody).error.code).toBe('UNSUPPORTED_CURRENCY');
    });

    it.each([
      ['sender_wallet_id', 'not-a-uuid'],
      ['receiver_wallet_id', 'not-a-uuid'],
      ['sender_wallet_id', undefined],
      ['receiver_wallet_id', 42],
    ])('returns 422 VALIDATION_ERROR naming %s for %p', async (field, value) => {
      const other = await createWallet();
      const res = await transfer(
        {
          sender_wallet_id: other,
          receiver_wallet_id: other,
          source_currency: 'cNGN',
          source_amount: '1',
          [field]: value,
        },
        randomUUID(),
      ).expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field, messages: [expect.stringContaining('UUID')] }],
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });

    it.each([
      ['zero', '0'],
      ['more than 8 dp', '1.123456789'],
      ['a JS number', 5],
      ['missing', undefined],
    ])('returns 422 VALIDATION_ERROR naming source_amount for %s', async (_label, amount) => {
      const sender = await createWallet();
      const receiver = await createWallet();
      const res = await transfer(
        {
          sender_wallet_id: sender,
          receiver_wallet_id: receiver,
          source_currency: 'cNGN',
          source_amount: amount,
        },
        randomUUID(),
      ).expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'source_amount', messages: [expect.any(String)] }],
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });

    it('returns 422 VALIDATION_ERROR when source_currency is missing', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      const res = await transfer(
        { sender_wallet_id: sender, receiver_wallet_id: receiver, source_amount: '1' },
        randomUUID(),
      ).expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'source_currency', messages: expect.any(Array) as string[] }],
      });
    });
  });

  describe('scenario 10 applied to transfers: two concurrent identical requests', () => {
    it('yield one transaction, two ledger entries and one replayed response', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      await deposit(sender, 'cNGN', '100');
      const key = randomUUID();
      const body = {
        sender_wallet_id: sender,
        receiver_wallet_id: receiver,
        source_currency: 'cNGN',
        source_amount: '100',
        destination_currency: 'USDx',
      };

      // Hold the sender's cNGN row so both transfers must overlap for real:
      // the first blocks on this lock inside the ledger, the second on the
      // first's uncommitted idempotency key. Both show up as lock waiters.
      const blocker = db.createQueryRunner();
      await blocker.connect();
      await blocker.startTransaction();
      let responses: request.Response[];
      try {
        await blocker.query(
          'SELECT amount FROM balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
          [sender, 'cNGN'],
        );

        const inflight = Promise.all([transfer(body, key), transfer(body, key)]);
        await waitForLockWaiters(db, 2);

        await blocker.rollbackTransaction();
        responses = await inflight;
      } finally {
        if (blocker.isTransactionActive) {
          await blocker.rollbackTransaction();
        }
        await blocker.release();
      }

      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      expect(responses[0]!.body).toEqual(responses[1]!.body);
      const replays = responses.filter((r) => r.headers['idempotent-replay'] === 'true');
      expect(replays).toHaveLength(1);

      expect(await balances(sender)).toEqual(ZERO_BALANCES);
      expect(await balances(receiver)).toEqual({ ...ZERO_BALANCES, USDx: '0.06250000' });
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });
    });
  });

  describe('crossing transfers: A to B and B to A at once', () => {
    const send = (from: string, to: string, amount: string) =>
      transfer(
        {
          sender_wallet_id: from,
          receiver_wallet_id: to,
          source_currency: 'cNGN',
          source_amount: amount,
        },
        randomUUID(),
      );

    it('both complete when each would lock its own sender first: the ledger locks in one global order', async () => {
      const [first, second] = [await createWallet(), await createWallet()];
      const [low, high] = first < second ? [first, second] : [second, first];
      await deposit(low, 'cNGN', '100');
      await deposit(high, 'cNGN', '100');

      // Hold the lower-sorted row, then queue low→high ahead of high→low. In
      // sender-first order, high→low would hold the high row while waiting
      // here, and once released low→high would take the low row and wait on
      // high: a deadlock. In sorted order both wait here holding nothing.
      const blocker = db.createQueryRunner();
      await blocker.connect();
      await blocker.startTransaction();
      let responses: request.Response[];
      try {
        await blocker.query(
          'SELECT amount FROM balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
          [low, 'cNGN'],
        );

        const lowToHigh = send(low, high, '30').then((res) => res);
        await waitForLockWaiters(db, 1);
        const highToLow = send(high, low, '20').then((res) => res);
        await waitForLockWaiters(db, 2);

        await blocker.rollbackTransaction();
        responses = await Promise.all([lowToHigh, highToLow]);
      } finally {
        if (blocker.isTransactionActive) {
          await blocker.rollbackTransaction();
        }
        await blocker.release();
      }

      expect(responses.map((r) => [r.status, (r.body as TransactionDto).type])).toEqual([
        [201, 'transfer'],
        [201, 'transfer'],
      ]);
      expect(await balance(low, 'cNGN')).toBe('90.00000000');
      expect(await balance(high, 'cNGN')).toBe('110.00000000');
      expect(await counts()).toEqual({ transactions: 4, ledgerEntries: 6, idempotencyKeys: 4 });
    });

    it('ten interleaved crossing transfers each end in 201 or a clean 422, and money is conserved', async () => {
      const a = await createWallet();
      const b = await createWallet();
      await deposit(a, 'cNGN', '100');
      await deposit(b, 'cNGN', '100');

      // Ten transactions, ten connections: the whole default pool. Nothing
      // else queries while they run.
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? send(a, b, '60') : send(b, a, '60'))),
      );

      for (const res of responses) {
        if (res.status !== 201) {
          expect(res.status).toBe(422);
          expect((res.body as ApiErrorBody).error).toMatchObject({
            code: 'INSUFFICIENT_FUNDS',
            details: { currency: 'cNGN', requested: '60.00000000' },
          });
        }
      }
      const succeeded = (from: string) =>
        responses.filter(
          (r) => r.status === 201 && (r.body as TransactionDto).source.wallet_id === from,
        ).length;
      const net = new Decimal(60).times(succeeded(b) - succeeded(a));

      expect(await balance(a, 'cNGN')).toBe(new Decimal(100).plus(net).toFixed(8));
      expect(await balance(b, 'cNGN')).toBe(new Decimal(100).minus(net).toFixed(8));
      const [negatives] = await db.query<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM balances WHERE amount < 0',
      );
      expect(negatives?.n).toBe(0);
      const successes = responses.filter((r) => r.status === 201).length;
      expect(await counts()).toEqual({
        transactions: 2 + successes,
        ledgerEntries: 2 + 2 * successes,
        idempotencyKeys: 2 + successes,
      });
    });
  });

  it('still answers 404 NOT_FOUND for an unknown route under the transfers prefix', async () => {
    const res = await api().get('/api/v1/transfers/nope').expect(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/v1/transfers with the provider down (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootApp({ url: BLOCKED_URL, timeoutMs: 500 });
    db = app.get(DataSource);
  });

  // Clears the fx_rates rows the live suite's app persisted, which would
  // otherwise price this transfer as 'cached'.
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterEach(async () => {
    await assertLedgerMatchesBalances(db);
  });

  afterAll(async () => {
    await truncateAll(db);
    await app.close();
  });

  it('prices a cross-currency transfer from FALLBACK_RATES and records rate_source "fallback"', async () => {
    const wallet = async () =>
      (
        (
          await api()
            .post('/api/v1/wallets')
            .send({ email: `${randomUUID()}@example.com` })
            .expect(201)
        ).body as WalletDto
      ).id;
    const sender = await wallet();
    const receiver = await wallet();
    await api()
      .post(`/api/v1/wallets/${sender}/deposits`)
      .set('Idempotency-Key', randomUUID())
      .send({ currency: 'cNGN', amount: '150000' })
      .expect(201);

    const res = await api()
      .post('/api/v1/transfers')
      .set('Idempotency-Key', randomUUID())
      .send({
        sender_wallet_id: sender,
        receiver_wallet_id: receiver,
        source_currency: 'cNGN',
        source_amount: '150000',
        destination_currency: 'USDx',
      })
      .expect(201);
    const body = res.body as TransactionDto;

    const fxRate = crossRate(FALLBACK_RATES, 'cNGN', 'USDx');
    expect(body.rate_source).toBe('fallback');
    expect(body.fx_rate).toBe(fxRate);
    expect(body.destination).toEqual({
      wallet_id: receiver,
      currency: 'USDx',
      amount: expectedDestination('150000', fxRate),
    });
  });
});
