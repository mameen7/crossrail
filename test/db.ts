import { DataSource } from 'typeorm';

/** Empties every application table so a suite starts from a known state. */
export async function truncateAll(db: DataSource): Promise<void> {
  await db.query(
    'TRUNCATE TABLE ledger_entries, transactions, idempotency_keys, balances, wallets, fx_rates CASCADE',
  );
}

export interface LedgerMismatch {
  wallet_id: string;
  currency: string;
  balance: string | null;
  ledger_sum: string | null;
}

/**
 * The spec's invariant: `SUM(ledger_entries.amount)` per (wallet, currency)
 * equals `balances.amount`. A FULL JOIN with COALESCE on both sides also
 * catches a ledger sum with no balance row and a non-zero balance with no
 * ledger rows. Returns the offending rows; the assertion below expects none.
 */
export async function ledgerMismatches(db: DataSource): Promise<LedgerMismatch[]> {
  return db.query(`
    SELECT COALESCE(b.wallet_id, l.wallet_id) AS wallet_id,
           COALESCE(b.currency, l.currency)   AS currency,
           b.amount::text                     AS balance,
           l.sum::text                        AS ledger_sum
      FROM balances b
      FULL JOIN (
        SELECT wallet_id, currency, SUM(amount) AS sum
          FROM ledger_entries
         GROUP BY wallet_id, currency
      ) l ON l.wallet_id = b.wallet_id AND l.currency = b.currency
     WHERE COALESCE(b.amount, 0) IS DISTINCT FROM COALESCE(l.sum, 0)
     ORDER BY 1, 2
  `);
}

export async function assertLedgerMatchesBalances(db: DataSource): Promise<void> {
  expect(await ledgerMismatches(db)).toEqual([]);
}

/**
 * Polls pg_stat_activity until `n` other backends on this database are
 * waiting on a lock. Same role, so their rows are visible. Fails loudly after
 * 5s so a test that never produced the overlap cannot pass by accident.
 */
export async function waitForLockWaiters(db: DataSource, n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [row] = await db.query<{ waiting: number }[]>(`
      SELECT count(*)::int AS waiting
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()
    `);
    if ((row?.waiting ?? 0) >= n) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Expected ${n} backends blocked on a lock; saw ${row?.waiting ?? 0}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
