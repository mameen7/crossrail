import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/typeorm.config';

const TEST_DB = 'crossrail_test';

/**
 * Jest global setup for e2e: creates the dedicated test database if it does
 * not exist and runs all migrations against it. Requires a reachable Postgres
 * (`docker compose up -d postgres`).
 */
export default async function globalSetup(): Promise<void> {
  // setupFiles do not run for globalSetup, so apply the same env defaults here.
  process.env.DB_HOST ??= 'localhost';
  process.env.DB_PORT ??= process.env.POSTGRES_PORT ?? '5432';
  process.env.DB_USER ??= 'crossrail';
  process.env.DB_PASSWORD ??= 'crossrail';

  const admin = new DataSource({
    ...buildDataSourceOptions({ ...process.env, DB_NAME: 'postgres' }),
    entities: [],
    migrations: [],
  });
  await admin.initialize();
  try {
    const existing: unknown[] = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEST_DB,
    ]);
    if (existing.length === 0) {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    }
  } finally {
    await admin.destroy();
  }

  const test = new DataSource(buildDataSourceOptions({ ...process.env, DB_NAME: TEST_DB }));
  await test.initialize();
  try {
    await test.runMigrations();
  } finally {
    await test.destroy();
  }
}
