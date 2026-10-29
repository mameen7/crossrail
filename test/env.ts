/**
 * Runs in every e2e worker before test files load. Forces the dedicated test
 * database so a suite can never touch the development database.
 */
process.env.DB_NAME = 'crossrail_test';
process.env.DB_HOST ??= 'localhost';
process.env.DB_PORT ??= process.env.POSTGRES_PORT ?? '5432';
process.env.DB_USER ??= 'crossrail';
process.env.DB_PASSWORD ??= 'crossrail';
