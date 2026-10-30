import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/typeorm.config';

/**
 * Guards the migrated schema itself: the six tables exist, numeric columns
 * carry the spec's precision, and the database-level constraints reject bad
 * rows regardless of application code.
 */
describe('database schema (e2e)', () => {
  let db: DataSource;

  beforeAll(async () => {
    db = new DataSource(buildDataSourceOptions());
    await db.initialize();
  });

  afterAll(async () => {
    await db.destroy();
  });

  const tableNames = async (): Promise<string[]> => {
    const rows: { tablename: string }[] = await db.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations' ORDER BY 1`,
    );
    return rows.map((r) => r.tablename);
  };

  it('creates the six tables from the spec', async () => {
    expect(await tableNames()).toEqual([
      'balances',
      'fx_rates',
      'idempotency_keys',
      'ledger_entries',
      'transactions',
      'wallets',
    ]);
  });

  it('stores amounts as numeric(38,8) and rates as numeric(38,18)', async () => {
    const rows: { table_name: string; column_name: string; p: number; s: number }[] =
      await db.query(
        `SELECT table_name, column_name, numeric_precision AS p, numeric_scale AS s
           FROM information_schema.columns
          WHERE table_schema = 'public' AND data_type = 'numeric'
          ORDER BY 1, 2`,
      );
    expect(rows).toEqual([
      { table_name: 'balances', column_name: 'amount', p: 38, s: 8 },
      { table_name: 'fx_rates', column_name: 'rate', p: 38, s: 18 },
      { table_name: 'ledger_entries', column_name: 'amount', p: 38, s: 8 },
      { table_name: 'transactions', column_name: 'destination_amount', p: 38, s: 8 },
      { table_name: 'transactions', column_name: 'fx_rate', p: 38, s: 18 },
      { table_name: 'transactions', column_name: 'source_amount', p: 38, s: 8 },
    ]);
  });

  it('declares the three newest-first history indexes on transactions', async () => {
    const rows: { indexdef: string }[] = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'transactions' AND indexname LIKE 'IDX_%' ORDER BY 1`,
    );
    expect(rows.map((r) => r.indexdef)).toEqual([
      'CREATE INDEX "IDX_transactions_receiver_created" ON public.transactions USING btree (receiver_wallet_id, created_at DESC)',
      'CREATE INDEX "IDX_transactions_sender_created" ON public.transactions USING btree (sender_wallet_id, created_at DESC)',
      'CREATE INDEX "IDX_transactions_wallet_created" ON public.transactions USING btree (wallet_id, created_at DESC)',
    ]);
  });

  describe('constraints', () => {
    // transactions has no wallet foreign keys, so these ids need no wallet rows.
    const W1 = '00000000-0000-4000-8000-000000000001';
    const W2 = '00000000-0000-4000-8000-000000000002';

    // Every statement runs in a transaction that is rolled back, so the suite
    // leaves no rows behind. Each statement gets its own savepoint: Postgres
    // aborts the whole transaction after a failed statement, and a savepoint
    // rollback is what lets the next expectation still run.
    const inRolledBackTx = async (
      fn: (run: (sql: string) => Promise<unknown>) => Promise<void>,
    ): Promise<void> => {
      const runner = db.createQueryRunner();
      const run = async (sql: string): Promise<unknown> => {
        await runner.query('SAVEPOINT stmt');
        try {
          const result: unknown = await runner.query(sql);
          await runner.query('RELEASE SAVEPOINT stmt');
          return result;
        } catch (err) {
          await runner.query('ROLLBACK TO SAVEPOINT stmt');
          throw err;
        }
      };
      // release() must run whatever fails above it, or the pooled connection leaks.
      try {
        await runner.connect();
        try {
          await runner.startTransaction();
          await fn(run);
        } finally {
          if (runner.isTransactionActive) {
            await runner.rollbackTransaction();
          }
        }
      } finally {
        await runner.release();
      }
    };

    it('rejects a wallet with neither email nor phone', async () => {
      await inRolledBackTx(async (run) => {
        await expect(run(`INSERT INTO wallets DEFAULT VALUES`)).rejects.toThrow(
          /CHK_wallets_contact/,
        );
      });
    });

    it('rejects duplicate email and duplicate phone, but allows many NULLs', async () => {
      await inRolledBackTx(async (run) => {
        await run(`INSERT INTO wallets (email) VALUES ('a@example.com')`);
        await expect(run(`INSERT INTO wallets (email) VALUES ('a@example.com')`)).rejects.toThrow(
          /UQ_wallets_email/,
        );
      });
      await inRolledBackTx(async (run) => {
        await run(`INSERT INTO wallets (phone) VALUES ('+2348000000000')`);
        await expect(run(`INSERT INTO wallets (phone) VALUES ('+2348000000000')`)).rejects.toThrow(
          /UQ_wallets_phone/,
        );
        // two email-only wallets both have phone NULL; that must not collide
        await run(`INSERT INTO wallets (email) VALUES ('b@example.com')`);
        await run(`INSERT INTO wallets (email) VALUES ('c@example.com')`);
      });
    });

    it('rejects a negative balance and an unsupported currency', async () => {
      await inRolledBackTx(async (run) => {
        await run(
          `INSERT INTO wallets (id, email) VALUES ('00000000-0000-4000-8000-000000000001', 'd@example.com')`,
        );
        await expect(
          run(
            `INSERT INTO balances (wallet_id, currency, amount, updated_at)
             VALUES ('00000000-0000-4000-8000-000000000001', 'cNGN', '-0.00000001', now())`,
          ),
        ).rejects.toThrow(/CHK_balances_amount_non_negative/);
        await expect(
          run(
            `INSERT INTO balances (wallet_id, currency, amount, updated_at)
             VALUES ('00000000-0000-4000-8000-000000000001', 'BTC', '1', now())`,
          ),
        ).rejects.toThrow(/CHK_balances_currency/);
        await expect(
          run(
            `INSERT INTO balances (wallet_id, currency, updated_at)
             VALUES ('00000000-0000-4000-8000-000000000001', 'cNGN', now())`,
          ),
        ).resolves.toBeDefined();
      });
    });

    it('rejects an unknown transaction type and non-positive amounts', async () => {
      const insert = (type: string, source: string, destination: string) =>
        `INSERT INTO transactions
           (type, wallet_id, source_currency, source_amount, destination_currency, destination_amount, fx_rate, rate_source)
         VALUES ('${type}', '${W1}', 'cNGN', '${source}', 'USDx', '${destination}', '0.000675100000000000', 'fallback')`;

      await inRolledBackTx(async (run) => {
        await expect(run(insert('refund', '1', '1'))).rejects.toThrow(/CHK_transactions_type/);
        await expect(run(insert('swap', '0', '1'))).rejects.toThrow(
          /CHK_transactions_source_amount_positive/,
        );
        await expect(run(insert('swap', '1', '0'))).rejects.toThrow(
          /CHK_transactions_destination_amount_positive/,
        );
        await expect(run(insert('swap', '1', '0.00067510'))).resolves.toBeDefined();
      });
    });

    it('rejects a transaction whose wallet columns do not fit its type', async () => {
      const insert = (type: string, wallet: string, sender: string, receiver: string) =>
        `INSERT INTO transactions
           (type, wallet_id, sender_wallet_id, receiver_wallet_id, source_currency, source_amount,
            destination_currency, destination_amount, fx_rate, rate_source)
         VALUES ('${type}', ${wallet}, ${sender}, ${receiver}, 'cNGN', '1', 'cNGN', '1', '1', 'none')`;
      const [w1, w2] = [`'${W1}'`, `'${W2}'`];

      await inRolledBackTx(async (run) => {
        for (const type of ['deposit', 'swap']) {
          await run(insert(type, w1, 'NULL', 'NULL'));
          for (const bad of [
            insert(type, 'NULL', 'NULL', 'NULL'),
            insert(type, w1, w1, 'NULL'),
            insert(type, w1, 'NULL', w2),
          ]) {
            await expect(run(bad)).rejects.toThrow(/CHK_transactions_party_shape/);
          }
        }
        await run(insert('transfer', 'NULL', w1, w2));
        for (const bad of [
          insert('transfer', w1, w1, w2),
          insert('transfer', 'NULL', 'NULL', w2),
          insert('transfer', 'NULL', w1, 'NULL'),
        ]) {
          await expect(run(bad)).rejects.toThrow(/CHK_transactions_party_shape/);
        }
      });
    });

    it('rejects a transfer whose sender is its receiver', async () => {
      await inRolledBackTx(async (run) => {
        await expect(
          run(
            `INSERT INTO transactions
               (type, sender_wallet_id, receiver_wallet_id, source_currency, source_amount,
                destination_currency, destination_amount, fx_rate, rate_source)
             VALUES ('transfer', '${W1}', '${W1}', 'cNGN', '1', 'cNGN', '1', '1', 'none')`,
          ),
        ).rejects.toThrow(/CHK_transactions_distinct_parties/);
      });
    });

    it('rejects a ledger entry whose transaction does not exist', async () => {
      await inRolledBackTx(async (run) => {
        await expect(
          run(
            `INSERT INTO ledger_entries (transaction_id, wallet_id, currency, amount, created_at)
             VALUES ('00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', 'cNGN', '1', now())`,
          ),
        ).rejects.toThrow(/FK_ledger_entries_transaction/);
      });
    });

    it('enforces one idempotency row per (key, endpoint) and one fx row per pair', async () => {
      await inRolledBackTx(async (run) => {
        const idem = `INSERT INTO idempotency_keys (key, endpoint, request_hash, created_at)
                      VALUES ('k1', 'POST /wallets/:id/swaps', 'h', now())`;
        await run(idem);
        await expect(run(idem)).rejects.toThrow(/PK_idempotency_keys/);
        // same key on a different endpoint is a different row
        await run(
          `INSERT INTO idempotency_keys (key, endpoint, request_hash, created_at)
           VALUES ('k1', 'POST /transfers', 'h', now())`,
        );

        const fx = `INSERT INTO fx_rates (base_currency, quote_currency, rate, source, fetched_at)
                    VALUES ('USD', 'NGN', '1480', 'live', now())`;
        await run(fx);
        await expect(run(fx)).rejects.toThrow(/PK_fx_rates/);
      });
    });
  });
});
