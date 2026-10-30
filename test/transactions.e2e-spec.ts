import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ApiErrorBody } from '../src/common/api-error';
import { TransactionHistoryDto } from '../src/transactions/dto/transaction-history.dto';
import { TransactionDto } from '../src/transactions/dto/transaction.dto';
import { CURSOR_TS_SQL, encodeCursor } from '../src/transactions/history-cursor';
import { WalletDto } from '../src/wallets/dto/wallet.dto';
import { bootApp } from './app';
import { assertLedgerMatchesBalances, truncateAll } from './db';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const CURRENCIES = ['cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx'];
const TYPES = ['deposit', 'swap', 'transfer'];

type Query = Record<string, string | number>;

interface Walk {
  items: TransactionDto[];
  pages: TransactionHistoryDto[];
}

interface Counts {
  transactions: number;
  ledgerEntries: number;
  idempotencyKeys: number;
}

const ids = (items: readonly TransactionDto[]): string[] => items.map((tx) => tx.id);

const touches = (tx: TransactionDto, currency: string): boolean =>
  tx.source.currency === currency || tx.destination.currency === currency;

/**
 * Every app in this file keeps env.ts's blocked provider URL, so FX fails at
 * once with no network and swaps and transfers are priced from FALLBACK_RATES.
 * History does not care which tier priced a row.
 */
describe('transaction history and lookup (e2e)', () => {
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

  const post = async (path: string, body: object): Promise<TransactionDto> => {
    const res = await api()
      .post(`/api/v1${path}`)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    return res.body as TransactionDto;
  };

  const deposit = (walletId: string, currency: string, amount: string) =>
    post(`/wallets/${walletId}/deposits`, { currency, amount });

  const swap = (walletId: string, from: string, to: string, amount: string) =>
    post(`/wallets/${walletId}/swaps`, { from_currency: from, to_currency: to, amount });

  const transfer = (sender: string, receiver: string, from: string, amount: string, to: string) =>
    post('/transfers', {
      sender_wallet_id: sender,
      receiver_wallet_id: receiver,
      source_currency: from,
      source_amount: amount,
      destination_currency: to,
    });

  const history = (walletId: string, query: Query = {}) =>
    api().get(`/api/v1/wallets/${walletId}/transactions`).query(query);

  /** Follows next_cursor from the first page to the last. */
  const walk = async (walletId: string, query: Query = {}): Promise<Walk> => {
    const pages: TransactionHistoryDto[] = [];
    let cursor: string | null = null;
    do {
      const res = await history(walletId, cursor === null ? query : { ...query, cursor }).expect(
        200,
      );
      const page = res.body as TransactionHistoryDto;
      pages.push(page);
      cursor = page.next_cursor;
      if (pages.length > 500) {
        throw new Error('pagination did not terminate');
      }
    } while (cursor !== null);
    return { items: pages.flatMap((p) => p.items), pages };
  };

  /** Every page but the last is full; the last is non-empty unless the whole set is. */
  const expectPageShape = ({ items, pages }: Walk, limit: number): void => {
    expect(pages).toHaveLength(Math.max(1, Math.ceil(items.length / limit)));
    pages.forEach((page, i) => {
      const isLast = i === pages.length - 1;
      expect(page.next_cursor === null).toBe(isLast);
      if (!isLast) {
        expect(page.items).toHaveLength(limit);
      }
    });
  };

  /** The wallet's whole history straight from the table, in the spec's order. */
  const tableIds = async (walletId: string): Promise<string[]> => {
    const rows = await db.query<{ id: string }[]>(
      `SELECT id FROM transactions
        WHERE $1 IN (wallet_id, sender_wallet_id, receiver_wallet_id)
        ORDER BY created_at DESC, id DESC`,
      [walletId],
    );
    return rows.map((r) => r.id);
  };

  const counts = async (): Promise<Counts> => {
    const [row] = await db.query<Counts[]>(`
      SELECT (SELECT count(*) FROM transactions)::int     AS transactions,
             (SELECT count(*) FROM ledger_entries)::int   AS "ledgerEntries",
             (SELECT count(*) FROM idempotency_keys)::int AS "idempotencyKeys"
    `);
    return row!;
  };

  const expectValidationError = (res: request.Response, field: string): void => {
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String) as string,
        // A non-numeric limit fails @IsInt, @Min and @Max at once, so only non-empty is asserted.
        details: [{ field, messages: expect.arrayContaining([expect.any(String)]) as string[] }],
      },
    });
  };

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DataSource);
  });

  // The spec's invariant holds after every test, successful or not.
  afterEach(async () => {
    await assertLedgerMatchesBalances(db);
  });

  afterAll(async () => {
    await truncateAll(db);
    await app.close();
  });

  describe('scenario 11 over a seeded mixed history', () => {
    let a: string;
    let b: string;
    let c: string;
    /** Transfers from a to b converting USDx to EURx. */
    const crossToB: TransactionDto[] = [];
    let seeded: number;

    // Read-only tests share one seed: 29 transactions across three wallets,
    // created through the real endpoints so the ledger invariant holds.
    beforeAll(async () => {
      await truncateAll(db);
      [a, b, c] = [await createWallet(), await createWallet(), await createWallet()];
      await deposit(a, 'cNGN', '1000000');
      await deposit(a, 'USDx', '500');
      await deposit(b, 'cGHS', '1000');
      await deposit(b, 'EURx', '300');
      await deposit(c, 'cXAF', '100000');
      for (let round = 0; round < 3; round++) {
        await swap(a, 'cNGN', 'USDx', '10000');
        await transfer(a, b, 'cNGN', '5000', 'cNGN');
        crossToB.push(await transfer(a, b, 'USDx', '10', 'EURx'));
        await transfer(b, a, 'cGHS', '20', 'cNGN');
        await swap(a, 'USDx', 'EURx', '5');
        await transfer(c, a, 'cXAF', '1000', 'cXAF');
        await swap(b, 'cGHS', 'cXAF', '10');
        await deposit(a, 'EURx', '1');
      }
      seeded = (await counts()).transactions;
    });

    it('seeds the expected mix', async () => {
      expect(seeded).toBe(29);
      expect(await tableIds(a)).toHaveLength(23);
      expect(await tableIds(b)).toHaveLength(14);
      expect(await tableIds(c)).toHaveLength(4);
    });

    it.each([1, 7, 23, 100])(
      'walks each wallet history exactly once, in table order, at limit %i',
      async (limit) => {
        for (const wallet of [a, b, c]) {
          const result = await walk(wallet, { limit });
          const expected = await tableIds(wallet);
          expect(ids(result.items)).toEqual(expected);
          expect(new Set(ids(result.items)).size).toBe(expected.length);
          expectPageShape(result, limit);
        }
      },
    );

    it('returns 20 items by default, newest first, with a cursor to the rest', async () => {
      const first = (await history(a).expect(200)).body as TransactionHistoryDto;
      expect(first.items).toHaveLength(20);
      expect(first.next_cursor).toEqual(expect.any(String));

      const rest = (await history(a, { cursor: first.next_cursor! }).expect(200))
        .body as TransactionHistoryDto;
      expect(rest.items).toHaveLength(3);
      expect(rest.next_cursor).toBeNull();

      const all = [...first.items, ...rest.items];
      expect(ids(all)).toEqual(await tableIds(a));
      const times = all.map((tx) => tx.created_at);
      expect(times).toEqual([...times].sort().reverse());
      // The last deposit is the newest row of a's history; its first deposit the oldest.
      expect(all[0]).toMatchObject({ type: 'deposit', destination: { currency: 'EURx' } });
      expect(all[all.length - 1]).toMatchObject({
        type: 'deposit',
        destination: { wallet_id: a, currency: 'cNGN', amount: '1000000.00000000' },
      });
    });

    it('renders every item exactly as the lookup endpoint does', async () => {
      const { items } = await walk(a, { limit: 100 });
      for (const item of items) {
        const res = await api().get(`/api/v1/transactions/${item.id}`).expect(200);
        expect(res.body).toEqual(item);
      }
    });

    it("shows a transfer in both the sender's and the receiver's history, identically", async () => {
      const fromA = (await walk(a, { limit: 100 })).items;
      const fromB = (await walk(b, { limit: 100 })).items;
      for (const sent of crossToB) {
        expect(fromA.find((tx) => tx.id === sent.id)).toEqual(sent);
        expect(fromB.find((tx) => tx.id === sent.id)).toEqual(sent);
      }
      const shared = ids(fromA).filter((id) => ids(fromB).includes(id));
      expect(shared).toHaveLength(9); // three transfers a→b, three a→b converting, three b→a
      expect(fromA.filter((tx) => tx.type === 'transfer')).toHaveLength(12);
    });

    it.each(TYPES)('filters by type=%s, paginating the filtered set', async (type) => {
      for (const wallet of [a, b]) {
        const all = (await walk(wallet, { limit: 100 })).items;
        const expected = all.filter((tx) => tx.type === type);
        expect(expected.length).toBeGreaterThan(0);

        const filtered = await walk(wallet, { type, limit: 2 });
        expect(ids(filtered.items)).toEqual(ids(expected));
        expectPageShape(filtered, 2);
      }
    });

    it.each(CURRENCIES)(
      'filters by currency=%s on either side, paginating the filtered set',
      async (currency) => {
        const all = (await walk(a, { limit: 100 })).items;
        const expected = all.filter((tx) => touches(tx, currency));
        expect(expected.length).toBeGreaterThan(0);
        expect(expected.length).toBeLessThan(all.length);

        const filtered = await walk(a, { currency, limit: 3 });
        expect(ids(filtered.items)).toEqual(ids(expected));
        expectPageShape(filtered, 3);
      },
    );

    it.each([
      ['transfer', 'cNGN'],
      ['swap', 'EURx'],
      ['deposit', 'USDx'],
      ['transfer', 'cXAF'],
    ])('combines type=%s with currency=%s', async (type, currency) => {
      const all = (await walk(a, { limit: 100 })).items;
      const expected = all.filter((tx) => tx.type === type && touches(tx, currency));
      expect(expected.length).toBeGreaterThan(0);

      const filtered = await walk(a, { type, currency, limit: 2 });
      expect(ids(filtered.items)).toEqual(ids(expected));
    });

    it('matches a cross-currency transfer from the receiver side by the currency it received', async () => {
      // b received EURx for a's USDx: its EURx transfers are exactly those three.
      const received = await walk(b, { type: 'transfer', currency: 'EURx' });
      expect(ids(received.items)).toEqual(ids([...crossToB].reverse()));
      for (const tx of received.items) {
        expect(tx.source).toMatchObject({ wallet_id: a, currency: 'USDx' });
        expect(tx.destination).toMatchObject({ wallet_id: b, currency: 'EURx' });
      }
      // The sent side matches too, for both wallets; an unrelated currency matches neither.
      expect(ids((await walk(b, { type: 'transfer', currency: 'USDx' })).items)).toEqual(
        ids(received.items),
      );
      const sent = (await walk(a, { type: 'transfer', currency: 'USDx' })).items;
      expect(ids(sent)).toEqual(ids(received.items));
      const unrelated = (await walk(b, { currency: 'cXAF' })).items;
      expect(unrelated.every((tx) => tx.type === 'swap')).toBe(true);
    });

    it('returns an empty last page for a filter nothing matches', async () => {
      const res = await history(c, { type: 'swap' }).expect(200);
      expect(res.body).toEqual({ items: [], next_cursor: null });
    });

    it('treats a well-formed cursor as a position, even one no row has', async () => {
      const all = (await walk(a, { limit: 100 })).items;
      const middle = all[10]!;
      const [row] = await db.query<{ ts: string }[]>(
        `SELECT ${CURSOR_TS_SQL} AS ts FROM transactions WHERE id = $1`,
        [middle.id],
      );
      // `middle`'s exact timestamp with an id above every real one: the page starts at `middle`.
      const cursor = encodeCursor({
        createdAt: row!.ts,
        id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      });
      const res = await history(a, { cursor, limit: 100 }).expect(200);
      expect(ids((res.body as TransactionHistoryDto).items)).toEqual(ids(all.slice(10)));
    });

    it('reads without an Idempotency-Key and writes nothing', async () => {
      const before = await counts();
      await walk(a, { limit: 5 });
      await api().get(`/api/v1/transactions/${crossToB[0]!.id}`).expect(200);
      expect(await counts()).toEqual(before);
    });
  });

  describe('a row naming the wallet in more than one role', () => {
    beforeEach(async () => {
      await truncateAll(db);
    });

    it('appears once and the page stays full, though the app never writes such a row', async () => {
      const wallet = await createWallet();
      const other = await createWallet();
      await deposit(wallet, 'cNGN', '10');
      const odd = await transfer(wallet, other, 'cNGN', '1', 'cNGN');
      await deposit(wallet, 'cNGN', '1');
      // Only the application forbids this (no CHECK constraint): the wallet as
      // owner, sender and receiver at once. Ledger entries are untouched.
      await db.query(
        'UPDATE transactions SET wallet_id = $1, receiver_wallet_id = $1 WHERE id = $2',
        [wallet, odd.id],
      );

      const expected = await tableIds(wallet);
      expect(expected).toHaveLength(3);
      for (const limit of [1, 2, 3]) {
        const result = await walk(wallet, { limit });
        expect(ids(result.items)).toEqual(expected);
        expectPageShape(result, limit);
      }
    });
  });

  describe('rows sharing a created_at', () => {
    beforeEach(async () => {
      await truncateAll(db);
    });

    it('paginate by the id tiebreaker with no skips or duplicates, at microsecond precision', async () => {
      const wallet = await createWallet();
      const made: string[] = [];
      for (let i = 0; i < 9; i++) {
        made.push((await deposit(wallet, 'cNGN', `${i + 1}`)).id);
      }
      // Five rows share one timestamp exactly; two more sit in the same
      // millisecond, a microsecond on either side, which a millisecond cursor
      // would lose; one older and one newer row frame them.
      const stamps = [
        '2026-10-30T12:00:00.000000Z',
        '2026-10-30T12:00:00.123455Z',
        '2026-10-30T12:00:00.123456Z',
        '2026-10-30T12:00:00.123456Z',
        '2026-10-30T12:00:00.123456Z',
        '2026-10-30T12:00:00.123456Z',
        '2026-10-30T12:00:00.123456Z',
        '2026-10-30T12:00:00.123457Z',
        '2026-10-30T12:00:01.000000Z',
      ];
      for (const [i, id] of made.entries()) {
        await db.query('UPDATE transactions SET created_at = $1 WHERE id = $2', [stamps[i], id]);
      }

      const expected = await tableIds(wallet);
      expect(new Set(expected)).toEqual(new Set(made));
      const tied = made.slice(2, 7);
      // The tied rows come out by id, descending.
      expect(expected.slice(2, 7)).toEqual([...tied].sort().reverse());

      for (const limit of [1, 2, 3, 4]) {
        const result = await walk(wallet, { limit });
        expect(ids(result.items)).toEqual(expected);
        expectPageShape(result, limit);
      }
    });
  });

  describe('request validation', () => {
    let wallet: string;

    beforeAll(async () => {
      await truncateAll(db);
      wallet = await createWallet();
      for (let i = 0; i < 3; i++) {
        await deposit(wallet, 'USDx', '1');
      }
    });

    it('returns an empty page for a wallet with no transactions', async () => {
      const fresh = await createWallet();
      const res = await history(fresh).expect(200);
      expect(res.body).toEqual({ items: [], next_cursor: null });
    });

    it.each([1, 100])('accepts limit=%i', async (limit) => {
      const res = await history(wallet, { limit }).expect(200);
      expect((res.body as TransactionHistoryDto).items).toHaveLength(Math.min(limit, 3));
    });

    it.each(['0', '101', '1000', 'abc', '1.5', '-1', '1e2', ' 5', ''])(
      'returns 422 VALIDATION_ERROR on limit for %p',
      async (limit) => {
        expectValidationError(await history(wallet, { limit }), 'limit');
      },
    );

    it('returns 422 VALIDATION_ERROR for a repeated limit', async () => {
      const res = await api().get(`/api/v1/wallets/${wallet}/transactions?limit=1&limit=2`);
      expectValidationError(res, 'limit');
    });

    it.each(['refund', 'DEPOSIT', ''])(
      'returns 422 VALIDATION_ERROR on type for %p',
      async (type) => {
        expectValidationError(await history(wallet, { type }), 'type');
      },
    );

    it('returns 422 UNSUPPORTED_CURRENCY for an unknown currency', async () => {
      const res = await history(wallet, { currency: 'BTC' }).expect(422);
      expect(res.body).toEqual({
        error: {
          code: 'UNSUPPORTED_CURRENCY',
          message: expect.any(String) as string,
          details: { field: 'currency', value: 'BTC' },
        },
      });
    });

    it('returns 422 VALIDATION_ERROR for an empty currency', async () => {
      expectValidationError(await history(wallet, { currency: '' }), 'currency');
    });

    const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

    it.each([
      ['garbage', 'not-a-cursor'],
      ['empty', ''],
      ['base64url of arbitrary text', b64('hello world')],
      [
        'an impossible date Postgres would reject',
        b64(`2026-02-30T00:00:00.000000Z_${UNKNOWN_ID}`),
      ],
      ['year 0, which Postgres rejects', b64(`0000-01-01T00:00:00.000000Z_${UNKNOWN_ID}`)],
      ['a malformed uuid', b64('2026-10-30T12:00:00.000000Z_not-a-uuid')],
      ['SQL in the id', b64("2026-10-30T12:00:00.000000Z_' OR 1=1 --")],
    ])('returns 422 VALIDATION_ERROR on cursor for %s, never a 500', async (_label, cursor) => {
      expectValidationError(await history(wallet, { cursor }), 'cursor');
    });

    it('returns 422 for a real next_cursor with characters appended', async () => {
      const page = (await history(wallet, { limit: 1 }).expect(200)).body as TransactionHistoryDto;
      expect(page.next_cursor).not.toBeNull();
      expectValidationError(await history(wallet, { cursor: `${page.next_cursor}x` }), 'cursor');
      await history(wallet, { cursor: page.next_cursor! }).expect(200);
    });

    it('returns 404 WALLET_NOT_FOUND for an unknown wallet, with or without filters', async () => {
      const queries: Query[] = [{}, { type: 'deposit', currency: 'cNGN', limit: 5 }];
      for (const query of queries) {
        const res = await history(UNKNOWN_ID, query).expect(404);
        expect(res.body).toEqual({
          error: {
            code: 'WALLET_NOT_FOUND',
            message: expect.any(String) as string,
            details: { id: UNKNOWN_ID },
          },
        });
      }
    });

    it('returns 422 VALIDATION_ERROR on id for a malformed wallet id', async () => {
      expectValidationError(await history('not-a-uuid'), 'id');
    });

    it('accepts an uppercased wallet id', async () => {
      const lower = (await history(wallet).expect(200)).body as TransactionHistoryDto;
      const upper = (await history(wallet.toUpperCase()).expect(200)).body as TransactionHistoryDto;
      expect(upper).toEqual(lower);
    });
  });

  describe('GET /transactions/:id', () => {
    beforeEach(async () => {
      await truncateAll(db);
    });

    it('returns the same canonical DTO the deposit, swap and transfer endpoints returned', async () => {
      const sender = await createWallet();
      const receiver = await createWallet();
      const created = [
        await deposit(sender, 'cNGN', '200000'),
        await swap(sender, 'cNGN', 'USDx', '150000'),
        await transfer(sender, receiver, 'USDx', '1', 'EURx'),
        await transfer(sender, receiver, 'cNGN', '100', 'cNGN'),
      ];
      expect(created.map((tx) => tx.type)).toEqual(['deposit', 'swap', 'transfer', 'transfer']);

      for (const tx of created) {
        const res = await api().get(`/api/v1/transactions/${tx.id}`).expect(200);
        expect(res.body).toEqual(tx);
        const upper = await api().get(`/api/v1/transactions/${tx.id.toUpperCase()}`).expect(200);
        expect(upper.body).toEqual(tx);
      }
    });

    it('returns 404 TRANSACTION_NOT_FOUND for an unknown id', async () => {
      const res = await api().get(`/api/v1/transactions/${UNKNOWN_ID}`).expect(404);
      expect(res.body).toEqual({
        error: {
          code: 'TRANSACTION_NOT_FOUND',
          message: expect.any(String) as string,
          details: { id: UNKNOWN_ID },
        },
      });
    });

    it('returns 422 VALIDATION_ERROR on id for a malformed id', async () => {
      expectValidationError(await api().get('/api/v1/transactions/not-a-uuid'), 'id');
    });

    it('answers 404 NOT_FOUND for GET /transactions with no id', async () => {
      const res = await api().get('/api/v1/transactions').expect(404);
      expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
    });
  });
});
