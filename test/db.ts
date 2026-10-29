import { DataSource } from 'typeorm';

/** Empties every application table so a suite starts from a known state. */
export async function truncateAll(db: DataSource): Promise<void> {
  await db.query(
    'TRUNCATE TABLE ledger_entries, transactions, idempotency_keys, balances, wallets, fx_rates CASCADE',
  );
}
