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
 * A provider table chosen so every cross rate this suite uses is a short
 * exact decimal, and expectations can be literal digits:
 *   cNGN → USDx  1/1600  = 0.000625                (150000 cNGN → 93.75 USDx)
 *   cGHS → cNGN  1600/11 = 145.454545454545454545… (1 cGHS → 145.45454545, a visible round-down)
 *   cXAF → USDx  1/500   = 0.002                   (0.00000001 cXAF → 2e-11 → rounds to zero)
 */
const STUB_BODY =
  '{"result":"success","base_code":"USD","rates":' +
  '{"USD":1,"EUR":0.8,"NGN":1600,"GHS":11,"XAF":500,"JPY":150}}';
const STUB_TABLE: UsdRateTable = { USD: '1', EUR: '0.8', NGN: '1600', GHS: '11', XAF: '500' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_WALLET = '00000000-0000-4000-8000-000000000000';
const ENDPOINT = 'POST /wallets/:id/swaps';

interface Counts {
  transactions: number;
  ledgerEntries: number;
  idempotencyKeys: number;
}

interface StoredTx {
  source_amount: string;
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

const storedTx = async (db: DataSource, id: string): Promise<StoredTx> => {
  const [row] = await db.query<StoredTx[]>(
    `SELECT source_amount::text, destination_amount::text, fx_rate::text, rate_source
       FROM transactions WHERE id = $1`,
    [id],
  );
  return row!;
};

/** Asserts the stored amounts obey the rule and the DTO rendered exactly the stored row. */
const expectDerivedFromStoredRate = async (
  db: DataSource,
  body: TransactionDto,
): Promise<StoredTx> => {
  const row = await storedTx(db, body.id);
  expect(row.destination_amount).toBe(expectedDestination(row.source_amount, row.fx_rate));
  expect(body.source.amount).toBe(row.source_amount);
  expect(body.destination.amount).toBe(row.destination_amount);
  expect(body.fx_rate).toBe(row.fx_rate);
  expect(body.rate_source).toBe(row.rate_source);
  return row;
};

describe('POST /api/v1/wallets/:id/swaps (e2e)', () => {
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

  const swap = (walletId: string, body: object, key?: string) => {
    const req = api().post(`/api/v1/wallets/${walletId}/swaps`);
    return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
  };

  const balance = async (walletId: string, currency: string): Promise<string> => {
    const res = await api().get(`/api/v1/wallets/${walletId}`).expect(200);
    const balances = (res.body as WalletBalancesDto).balances as unknown as Record<string, string>;
    return balances[currency] ?? 'missing';
  };

  const counts = async (): Promise<Counts> => {
    const [row] = await db.query<Counts[]>(`
      SELECT (SELECT count(*) FROM transactions)::int     AS transactions,
             (SELECT count(*) FROM ledger_entries)::int   AS "ledgerEntries",
             (SELECT count(*) FROM idempotency_keys)::int AS "idempotencyKeys"
    `);
    return row!;
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

  describe('scenario 5: a swap converts at the stored rate', () => {
    it('returns the canonical transaction DTO priced from the live stub table', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '150000');
      const before = Date.now();

      const res = await swap(
        walletId,
        { from_currency: 'cNGN', to_currency: 'USDx', amount: '150000.00' },
        randomUUID(),
      ).expect(201);
      const body = res.body as TransactionDto;

      expect(res.headers['idempotent-replay']).toBeUndefined();
      expect(body).toEqual({
        id: expect.stringMatching(UUID_RE) as string,
        type: 'swap',
        status: 'completed',
        source: { wallet_id: walletId, currency: 'cNGN', amount: '150000.00000000' },
        destination: { wallet_id: walletId, currency: 'USDx', amount: '93.75000000' },
        fx_rate: '0.000625000000000000',
        rate_source: 'live',
        created_at: expect.any(String) as string,
      });
      expect(body.fx_rate).toBe(crossRate(STUB_TABLE, 'cNGN', 'USDx'));
      expect(new Date(body.created_at).toISOString()).toBe(body.created_at);
      expect(new Date(body.created_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(provider.hits()).toBeGreaterThanOrEqual(1);
    });

    it('stores destination = round_down(source × fx_rate, 8), moves both balances and writes two ledger entries', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '150000');
      const key = randomUUID();

      const res = await swap(
        walletId,
        { from_currency: 'cNGN', to_currency: 'USDx', amount: '150000' },
        key,
      ).expect(201);
      const body = res.body as TransactionDto;

      const row = await expectDerivedFromStoredRate(db, body);
      expect(row).toEqual({
        source_amount: '150000.00000000',
        destination_amount: '93.75000000',
        fx_rate: '0.000625000000000000',
        rate_source: 'live',
      });

      expect(await balance(walletId, 'cNGN')).toBe('0.00000000');
      expect(await balance(walletId, 'USDx')).toBe('93.75000000');

      const entries: Record<string, unknown>[] = await db.query(
        `SELECT wallet_id, currency, amount FROM ledger_entries
          WHERE transaction_id = $1 ORDER BY amount`,
        [body.id],
      );
      expect(entries).toEqual([
        { wallet_id: walletId, currency: 'cNGN', amount: '-150000.00000000' },
        { wallet_id: walletId, currency: 'USDx', amount: '93.75000000' },
      ]);
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });

      const keys: Record<string, unknown>[] = await db.query(
        'SELECT endpoint, response_status, transaction_id FROM idempotency_keys WHERE key = $1',
        [key],
      );
      expect(keys).toEqual([{ endpoint: ENDPOINT, response_status: 201, transaction_id: body.id }]);
    });

    it('rounds the destination down at 8 dp and never disagrees with the stored rate', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cGHS', '1');

      const res = await swap(
        walletId,
        { from_currency: 'cGHS', to_currency: 'cNGN', amount: '1' },
        randomUUID(),
      ).expect(201);
      const body = res.body as TransactionDto;

      // 1600/11 = 145.454545…; the 19th decimal is a 4, so the 18 dp rate is exact here,
      // and the 8 dp amount drops the tail rather than rounding it up.
      expect(body.fx_rate).toBe('145.454545454545454545');
      expect(body.destination.amount).toBe('145.45454545');
      await expectDerivedFromStoredRate(db, body);
      expect(await balance(walletId, 'cGHS')).toBe('0.00000000');
      expect(await balance(walletId, 'cNGN')).toBe('145.45454545');
    });
  });

  describe('scenario 6: a swap exceeding the balance', () => {
    it('returns 422 INSUFFICIENT_FUNDS, leaves balances untouched and does not consume the key', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '100');
      const key = randomUUID();
      const body = { from_currency: 'cNGN', to_currency: 'USDx', amount: '150' };

      const res = await swap(walletId, body, key).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'INSUFFICIENT_FUNDS',
          message: expect.any(String) as string,
          details: {
            wallet_id: walletId,
            currency: 'cNGN',
            available: '100.00000000',
            requested: '150.00000000',
          },
        },
      });
      expect(await balance(walletId, 'cNGN')).toBe('100.00000000');
      expect(await balance(walletId, 'USDx')).toBe('0.00000000');
      // Only the funding deposit persisted: no swap row, and no key row for the failed attempt.
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });

      // After a top-up the same key and body go through as a fresh request.
      await deposit(walletId, 'cNGN', '50');
      const retry = await swap(walletId, body, key).expect(201);
      expect(retry.headers['idempotent-replay']).toBeUndefined();
      expect((retry.body as TransactionDto).type).toBe('swap');
      expect(await balance(walletId, 'cNGN')).toBe('0.00000000');
      expect(await balance(walletId, 'USDx')).toBe('0.09375000');
      expect(await counts()).toEqual({ transactions: 3, ledgerEntries: 4, idempotencyKeys: 3 });
    });
  });

  describe('scenario 7: rejected swaps that write nothing', () => {
    it('returns 422 SAME_CURRENCY_SWAP for the same currency on both sides', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '10');

      const res = await swap(
        walletId,
        { from_currency: 'cNGN', to_currency: 'cNGN', amount: '1' },
        randomUUID(),
      ).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'SAME_CURRENCY_SWAP',
          message: expect.any(String) as string,
          details: { currency: 'cNGN' },
        },
      });
      expect(await balance(walletId, 'cNGN')).toBe('10.00000000');
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });
    });

    it('returns 422 AMOUNT_TOO_SMALL when the conversion rounds to zero at 8 dp', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cXAF', '1'); // funded, so this cannot be mistaken for insufficient funds

      const res = await swap(
        walletId,
        { from_currency: 'cXAF', to_currency: 'USDx', amount: '0.00000001' },
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
      expect(await balance(walletId, 'cXAF')).toBe('1.00000000');
      expect(await balance(walletId, 'USDx')).toBe('0.00000000');
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });
    });
  });

  describe('scenario 3 applied to swaps: a replayed swap returns the original transaction once', () => {
    it('returns the stored response with Idempotent-Replay: true and moves the balances once', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '10');
      const key = randomUUID();

      const first = await swap(
        walletId,
        { from_currency: 'cNGN', to_currency: 'USDx', amount: '10' },
        key,
      ).expect(201);
      // Same request, different key order on the wire.
      const second = await swap(
        walletId,
        { amount: '10', to_currency: 'USDx', from_currency: 'cNGN' },
        key,
      ).expect(201);

      expect(first.headers['idempotent-replay']).toBeUndefined();
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);

      expect(await balance(walletId, 'cNGN')).toBe('0.00000000');
      expect(await balance(walletId, 'USDx')).toBe('0.00625000');
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });
    });
  });

  describe('scenario 4 applied to swaps: key misuse', () => {
    it('returns 422 IDEMPOTENCY_KEY_REUSED for the same key with a different body, writing nothing', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '10');
      const key = randomUUID();
      await swap(walletId, { from_currency: 'cNGN', to_currency: 'USDx', amount: '5' }, key).expect(
        201,
      );

      const res = await swap(
        walletId,
        { from_currency: 'cNGN', to_currency: 'USDx', amount: '6' },
        key,
      ).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: expect.any(String) as string,
          details: { key, endpoint: ENDPOINT },
        },
      });
      expect(res.headers['idempotent-replay']).toBeUndefined();
      expect(await balance(walletId, 'cNGN')).toBe('5.00000000');
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });
    });

    it('returns 400 IDEMPOTENCY_KEY_REQUIRED without a key, and writes nothing', async () => {
      const walletId = await createWallet();
      const res = await swap(walletId, {
        from_currency: 'cNGN',
        to_currency: 'USDx',
        amount: '5',
      }).expect(400);
      expect(res.body).toEqual({
        error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: expect.any(String) as string },
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });

    it('returns 404 WALLET_NOT_FOUND for an unknown wallet, and the key is not consumed', async () => {
      const key = randomUUID();
      const body = { from_currency: 'cNGN', to_currency: 'USDx', amount: '1' };
      const res = await swap(UNKNOWN_WALLET, body, key).expect(404);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'WALLET_NOT_FOUND',
        details: { id: UNKNOWN_WALLET },
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });

      // The failed attempt rolled its key row back, so the same key now succeeds elsewhere.
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '1');
      await swap(walletId, body, key).expect(201);
      expect(await balance(walletId, 'cNGN')).toBe('0.00000000');
    });
  });

  describe('validation', () => {
    it.each([
      ['from_currency', { from_currency: 'BTC', to_currency: 'USDx', amount: '1' }],
      ['to_currency', { from_currency: 'cNGN', to_currency: 'BTC', amount: '1' }],
    ])('returns 422 UNSUPPORTED_CURRENCY naming %s', async (field, body) => {
      const walletId = await createWallet();
      const res = await swap(walletId, body, randomUUID()).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'UNSUPPORTED_CURRENCY',
          message: expect.any(String) as string,
          details: { field, value: 'BTC' },
        },
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });

    it('returns 422 VALIDATION_ERROR when to_currency is missing', async () => {
      const walletId = await createWallet();
      const res = await swap(walletId, { from_currency: 'cNGN', amount: '1' }, randomUUID()).expect(
        422,
      );
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'to_currency', messages: expect.any(Array) as string[] }],
      });
      expect((await counts()).idempotencyKeys).toBe(0);
    });

    it.each([
      ['zero', '0'],
      ['more than 8 dp', '1.123456789'],
      ['a JS number', 5],
    ])('returns 422 VALIDATION_ERROR naming amount for %s', async (_label, amount) => {
      const walletId = await createWallet();
      const res = await swap(
        walletId,
        { from_currency: 'cNGN', to_currency: 'USDx', amount },
        randomUUID(),
      ).expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'amount', messages: [expect.any(String)] }],
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });
  });

  describe('scenario 10 applied to swaps: two concurrent identical requests', () => {
    it('yield one transaction, two ledger entries and one replayed response', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '100');
      const key = randomUUID();
      const body = { from_currency: 'cNGN', to_currency: 'USDx', amount: '100' };

      // Hold the cNGN row so both swaps must overlap for real. Locks are taken
      // in byte order, and 'USDx' sorts before 'cNGN', so the first request
      // already holds USDx and waits on cNGN while the second waits on the
      // first's uncommitted idempotency key. Both show up as lock waiters.
      const blocker = db.createQueryRunner();
      await blocker.connect();
      await blocker.startTransaction();
      let responses: request.Response[];
      try {
        await blocker.query(
          'SELECT amount FROM balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
          [walletId, 'cNGN'],
        );

        const inflight = Promise.all([swap(walletId, body, key), swap(walletId, body, key)]);
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

      expect(await balance(walletId, 'cNGN')).toBe('0.00000000');
      expect(await balance(walletId, 'USDx')).toBe('0.06250000');
      expect(await counts()).toEqual({ transactions: 2, ledgerEntries: 3, idempotencyKeys: 2 });
    });
  });

  describe('scenario 9: ten parallel swaps whose total exceeds the balance', () => {
    it('never goes negative: exactly the affordable swaps succeed, the rest are 422 INSUFFICIENT_FUNDS', async () => {
      const walletId = await createWallet();
      await deposit(walletId, 'cNGN', '1000');
      const body = { from_currency: 'cNGN', to_currency: 'USDx', amount: '150' };

      // Ten transactions, ten connections: the whole default pool. Nothing
      // else queries while they run.
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => swap(walletId, body, randomUUID())),
      );

      const successes = responses.filter((r) => r.status === 201);
      const failures = responses.filter((r) => r.status !== 201);
      // The row lock serialises them, so exactly floor(1000 / 150) can go through.
      expect(successes).toHaveLength(6);
      expect(failures).toHaveLength(4);
      for (const res of failures) {
        expect(res.status).toBe(422);
        expect((res.body as ApiErrorBody).error).toMatchObject({
          code: 'INSUFFICIENT_FUNDS',
          details: { wallet_id: walletId, currency: 'cNGN', requested: '150.00000000' },
        });
      }

      // Every success was priced from the stored rate; the credits add up to the USDx balance.
      let credited = new Decimal(0);
      for (const res of successes) {
        const row = await expectDerivedFromStoredRate(db, res.body as TransactionDto);
        expect(row.destination_amount).toBe('0.09375000');
        credited = credited.plus(row.destination_amount);
      }
      expect(await balance(walletId, 'cNGN')).toBe(
        new Decimal(1000).minus(new Decimal(150).times(successes.length)).toFixed(8),
      );
      expect(await balance(walletId, 'cNGN')).toBe('100.00000000');
      expect(await balance(walletId, 'USDx')).toBe(credited.toFixed(8));
      expect(await balance(walletId, 'USDx')).toBe('0.56250000');

      const [negatives] = await db.query<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM balances WHERE amount < 0',
      );
      expect(negatives?.n).toBe(0);
      expect(await counts()).toEqual({ transactions: 7, ledgerEntries: 13, idempotencyKeys: 7 });
    });
  });

  it('still answers 404 NOT_FOUND for an unknown route under the swaps prefix', async () => {
    const walletId = await createWallet();
    const res = await api().get(`/api/v1/wallets/${walletId}/swaps/nope`).expect(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/v1/wallets/:id/swaps with the provider down (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootApp({ url: BLOCKED_URL, timeoutMs: 500 });
    db = app.get(DataSource);
  });

  // The truncate is what makes the fallback tier reachable: it clears the
  // fx_rates rows the live suite's app persisted, which would otherwise
  // price this swap as 'cached'.
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

  it('prices the swap from FALLBACK_RATES and records rate_source "fallback"', async () => {
    const created = await api()
      .post('/api/v1/wallets')
      .send({ email: `${randomUUID()}@example.com` })
      .expect(201);
    const walletId = (created.body as WalletDto).id;
    await api()
      .post(`/api/v1/wallets/${walletId}/deposits`)
      .set('Idempotency-Key', randomUUID())
      .send({ currency: 'cNGN', amount: '150000' })
      .expect(201);

    const res = await api()
      .post(`/api/v1/wallets/${walletId}/swaps`)
      .set('Idempotency-Key', randomUUID())
      .send({ from_currency: 'cNGN', to_currency: 'USDx', amount: '150000' })
      .expect(201);
    const body = res.body as TransactionDto;

    expect(body.rate_source).toBe('fallback');
    expect(body.fx_rate).toBe(crossRate(FALLBACK_RATES, 'cNGN', 'USDx'));
    expect(body.destination.amount).toBe(expectedDestination('150000', body.fx_rate));

    const row = await expectDerivedFromStoredRate(db, body);
    expect(row).toEqual({
      source_amount: '150000.00000000',
      destination_amount: expectedDestination('150000', crossRate(FALLBACK_RATES, 'cNGN', 'USDx')),
      fx_rate: crossRate(FALLBACK_RATES, 'cNGN', 'USDx'),
      rate_source: 'fallback',
    });

    const wallet = await api().get(`/api/v1/wallets/${walletId}`).expect(200);
    const balances = (wallet.body as WalletBalancesDto).balances as unknown as Record<
      string,
      string
    >;
    expect(balances.cNGN).toBe('0.00000000');
    expect(balances.USDx).toBe(body.destination.amount);
  });
});
