import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ApiErrorBody } from '../src/common/api-error';
import { TransactionDto } from '../src/transactions/dto/transaction.dto';
import { WalletBalancesDto, WalletDto } from '../src/wallets/dto/wallet.dto';
import { assertLedgerMatchesBalances, truncateAll, waitForLockWaiters } from './db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_WALLET = '00000000-0000-4000-8000-000000000000';
const ONE = '1.000000000000000000';

interface Counts {
  transactions: number;
  ledgerEntries: number;
  idempotencyKeys: number;
}

describe('POST /api/v1/wallets/:id/deposits (e2e)', () => {
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

  const deposit = (walletId: string, body: object, key?: string) => {
    const req = api().post(`/api/v1/wallets/${walletId}/deposits`);
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
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
  });

  describe('scenario 2: a deposit credits the balance and writes a transaction plus one ledger entry', () => {
    it('returns the canonical transaction DTO', async () => {
      const walletId = await createWallet();
      const before = Date.now();

      const res = await deposit(
        walletId,
        { currency: 'cNGN', amount: '10.5' },
        randomUUID(),
      ).expect(201);
      const body = res.body as TransactionDto;

      expect(res.headers['idempotent-replay']).toBeUndefined();
      expect(body).toEqual({
        id: expect.stringMatching(UUID_RE) as string,
        type: 'deposit',
        status: 'completed',
        source: { wallet_id: null, currency: 'cNGN', amount: '10.50000000' },
        destination: { wallet_id: walletId, currency: 'cNGN', amount: '10.50000000' },
        fx_rate: ONE,
        rate_source: 'none',
        created_at: expect.any(String) as string,
      });
      expect(new Date(body.created_at).toISOString()).toBe(body.created_at);
      expect(new Date(body.created_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('credits the balance and persists exactly one transaction and one ledger entry', async () => {
      const walletId = await createWallet();
      const res = await deposit(
        walletId,
        { currency: 'USDx', amount: '0.00000001' },
        randomUUID(),
      ).expect(201);
      const tx = res.body as TransactionDto;

      expect(await balance(walletId, 'USDx')).toBe('0.00000001');
      expect(await balance(walletId, 'cNGN')).toBe('0.00000000');

      const transactions: Record<string, unknown>[] = await db.query(
        'SELECT type, wallet_id, sender_wallet_id, receiver_wallet_id, source_currency, source_amount, destination_currency, destination_amount, fx_rate, rate_source FROM transactions',
      );
      expect(transactions).toEqual([
        {
          type: 'deposit',
          wallet_id: walletId,
          sender_wallet_id: null,
          receiver_wallet_id: null,
          source_currency: 'USDx',
          source_amount: '0.00000001',
          destination_currency: 'USDx',
          destination_amount: '0.00000001',
          fx_rate: ONE,
          rate_source: 'none',
        },
      ]);
      const entries: Record<string, unknown>[] = await db.query(
        'SELECT transaction_id, wallet_id, currency, amount FROM ledger_entries',
      );
      expect(entries).toEqual([
        { transaction_id: tx.id, wallet_id: walletId, currency: 'USDx', amount: '0.00000001' },
      ]);
    });

    it('accumulates across deposits and accepts the largest request amount', async () => {
      const walletId = await createWallet();
      await deposit(walletId, { currency: 'EURx', amount: '1' }, randomUUID()).expect(201);
      await deposit(
        walletId,
        { currency: 'EURx', amount: '99999999999999999999.99999999' },
        randomUUID(),
      ).expect(201);
      expect(await balance(walletId, 'EURx')).toBe('100000000000000000000.99999999');
      expect((await counts()).ledgerEntries).toBe(2);
    });
  });

  describe('scenario 3: a replayed deposit returns the original transaction once', () => {
    it('returns the stored response with Idempotent-Replay: true and credits once', async () => {
      const walletId = await createWallet();
      const key = randomUUID();

      const first = await deposit(walletId, { currency: 'cGHS', amount: '20' }, key).expect(201);
      // Same request, different key order on the wire.
      const second = await deposit(walletId, { amount: '20', currency: 'cGHS' }, key).expect(201);

      expect(first.headers['idempotent-replay']).toBeUndefined();
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);

      expect(await balance(walletId, 'cGHS')).toBe('20.00000000');
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });

      const rows: Record<string, unknown>[] = await db.query(
        'SELECT key, endpoint, response_status, transaction_id FROM idempotency_keys',
      );
      expect(rows).toEqual([
        {
          key,
          endpoint: 'POST /wallets/:id/deposits',
          response_status: 201,
          transaction_id: (first.body as TransactionDto).id,
        },
      ]);
    });

    it('replays when the retry adds an unknown property or changes the id casing: the server processes the same request', async () => {
      const walletId = await createWallet();
      const key = randomUUID();

      const first = await deposit(
        walletId.toUpperCase(),
        { currency: 'USDx', amount: '3' },
        key,
      ).expect(201);
      // The response and the stored row carry the canonical lowercase id.
      expect((first.body as TransactionDto).destination.wallet_id).toBe(walletId);

      const retry = await deposit(
        walletId,
        { currency: 'USDx', amount: '3', note: 'client retry' },
        key,
      ).expect(201);
      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(retry.body).toEqual(first.body);

      expect(await balance(walletId, 'USDx')).toBe('3.00000000');
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });
    });

    it('scopes keys per endpoint and wallet: the same key on another wallet is a different request', async () => {
      const a = await createWallet();
      const b = await createWallet();
      const key = randomUUID();
      await deposit(a, { currency: 'cNGN', amount: '1' }, key).expect(201);

      const res = await deposit(b, { currency: 'cNGN', amount: '1' }, key).expect(422);
      expect((res.body as ApiErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balance(b, 'cNGN')).toBe('0.00000000');
    });
  });

  describe('scenario 4: key misuse', () => {
    it('returns 422 IDEMPOTENCY_KEY_REUSED for the same key with a different body, writing nothing', async () => {
      const walletId = await createWallet();
      const key = randomUUID();
      await deposit(walletId, { currency: 'cNGN', amount: '5' }, key).expect(201);

      const res = await deposit(walletId, { currency: 'cNGN', amount: '6' }, key).expect(422);

      expect(res.body).toEqual({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: expect.any(String) as string,
          details: { key, endpoint: 'POST /wallets/:id/deposits' },
        },
      });
      expect(res.headers['idempotent-replay']).toBeUndefined();
      expect(await balance(walletId, 'cNGN')).toBe('5.00000000');
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });
    });

    it('returns 400 IDEMPOTENCY_KEY_REQUIRED without a key, and writes nothing', async () => {
      const walletId = await createWallet();
      const res = await deposit(walletId, { currency: 'cNGN', amount: '5' }).expect(400);
      expect(res.body).toEqual({
        error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: expect.any(String) as string },
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });

    it('treats an empty key as missing', async () => {
      const walletId = await createWallet();
      const res = await deposit(walletId, { currency: 'cNGN', amount: '5' }, '').expect(400);
      expect((res.body as ApiErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('returns 422 VALIDATION_ERROR for a key over 255 characters, and accepts exactly 255', async () => {
      const walletId = await createWallet();
      const res = await deposit(
        walletId,
        { currency: 'cNGN', amount: '5' },
        'k'.repeat(256),
      ).expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'Idempotency-Key', messages: [expect.stringContaining('255')] }],
      });
      expect((await counts()).idempotencyKeys).toBe(0);

      await deposit(walletId, { currency: 'cNGN', amount: '5' }, 'k'.repeat(255)).expect(201);
    });
  });

  describe('validation', () => {
    it.each([
      ['zero', '0'],
      ['more than 8 dp', '1.123456789'],
      ['a JS number', 5],
      ['a non-numeric string', 'abc'],
      ['a negative', '-1'],
      ['missing', undefined],
    ])('returns 422 VALIDATION_ERROR naming amount for %s', async (_label, amount) => {
      const walletId = await createWallet();
      const res = await deposit(walletId, { currency: 'cNGN', amount }, randomUUID()).expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'amount', messages: [expect.any(String)] }],
      });
      expect(await counts()).toEqual({ transactions: 0, ledgerEntries: 0, idempotencyKeys: 0 });
    });

    it('returns 422 UNSUPPORTED_CURRENCY for an unknown currency, and VALIDATION_ERROR when it is missing', async () => {
      const walletId = await createWallet();
      const res = await deposit(walletId, { currency: 'BTC', amount: '1' }, randomUUID()).expect(
        422,
      );
      expect(res.body).toEqual({
        error: {
          code: 'UNSUPPORTED_CURRENCY',
          message: expect.any(String) as string,
          details: { field: 'currency', value: 'BTC' },
        },
      });

      const missing = await deposit(walletId, { amount: '1' }, randomUUID()).expect(422);
      expect((missing.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'currency', messages: expect.any(Array) as string[] }],
      });
      expect((await counts()).idempotencyKeys).toBe(0);
    });

    it('returns 404 WALLET_NOT_FOUND for an unknown wallet, and the key is not consumed', async () => {
      const key = randomUUID();
      const res = await deposit(UNKNOWN_WALLET, { currency: 'cNGN', amount: '1' }, key).expect(404);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'WALLET_NOT_FOUND',
        details: { id: UNKNOWN_WALLET },
      });
      expect((await counts()).idempotencyKeys).toBe(0);

      // The failed attempt rolled its key row back, so the same key now succeeds elsewhere.
      const walletId = await createWallet();
      await deposit(walletId, { currency: 'cNGN', amount: '1' }, key).expect(201);
      expect(await balance(walletId, 'cNGN')).toBe('1.00000000');
    });

    it('returns 422 VALIDATION_ERROR for a wallet id that is not a UUID', async () => {
      const res = await deposit(
        'not-a-uuid',
        { currency: 'cNGN', amount: '1' },
        randomUUID(),
      ).expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'id', messages: ['id must be a UUID'] }],
      });
    });

    it('checks the key before the body: no key and an invalid body is still a 400', async () => {
      const walletId = await createWallet();
      const res = await deposit(walletId, { currency: 'BTC', amount: '0' }).expect(400);
      expect((res.body as ApiErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  describe('scenario 10 applied to deposits: two concurrent identical requests', () => {
    it('yield one transaction, one ledger entry, one credit and one replayed response', async () => {
      const walletId = await createWallet();
      const key = randomUUID();
      const body = { currency: 'cNGN', amount: '100' };

      // Hold the balance row so both deposits must block inside LedgerService
      // and overlap for real: one on this lock, the other on the first's
      // uncommitted idempotency key.
      const blocker = db.createQueryRunner();
      await blocker.connect();
      await blocker.startTransaction();
      let responses: request.Response[];
      try {
        await blocker.query(
          'SELECT amount FROM balances WHERE wallet_id = $1 AND currency = $2 FOR UPDATE',
          [walletId, 'cNGN'],
        );

        const inflight = Promise.all([deposit(walletId, body, key), deposit(walletId, body, key)]);
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

      expect(await balance(walletId, 'cNGN')).toBe('100.00000000');
      expect(await counts()).toEqual({ transactions: 1, ledgerEntries: 1, idempotencyKeys: 1 });
    });
  });

  it('still answers 404 NOT_FOUND for an unknown route under the deposits prefix', async () => {
    const walletId = await createWallet();
    const res = await api().get(`/api/v1/wallets/${walletId}/deposits/nope`).expect(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });
});
