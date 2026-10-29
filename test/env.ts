/**
 * Runs in every e2e worker before test files load. Forces the dedicated test
 * database so a suite can never touch the development database.
 */
process.env.DB_NAME = 'crossrail_test';
process.env.DB_HOST ??= 'localhost';
process.env.DB_PORT ??= process.env.POSTGRES_PORT ?? '5432';
process.env.DB_USER ??= 'crossrail';
process.env.DB_PASSWORD ??= 'crossrail';

// No e2e suite may reach the real FX provider. Default every app to loopback
// port 9, which is on fetch's blocked-port list: the call fails before any
// socket opens. This overrides any FX_PROVIDER_URL in the shell; suites that
// need another URL set it themselves.
process.env.FX_PROVIDER_URL = 'http://127.0.0.1:9/v6/latest/USD';
process.env.FX_TIMEOUT_MS = '500';
