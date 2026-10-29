import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RatesDto } from '../src/fx/dto/rates.dto';
import { FALLBACK_RATES, FALLBACK_RATES_AS_OF } from '../src/fx/fallback-rates';
import { UsdRateTable } from '../src/fx/fiat';
import { allPairRates } from '../src/fx/pricing';
import { WalletBalancesDto, WalletDto } from '../src/wallets/dto/wallet.dto';
import { truncateAll } from './db';
import { FxStub, startBlackHole, startFxProvider } from './fx-stub';

/** The provider timeout configured for apps whose provider hangs. */
const DOWN_TIMEOUT_MS = 300;

const CACHED_TABLE: UsdRateTable = {
  USD: '1.000000000000000000',
  EUR: '0.870000000000000000',
  NGN: '1500.000000000000000000',
  GHS: '12.000000000000000000',
  XAF: '570.000000000000000000',
};
const CACHED_AT = '2026-10-28T09:00:00.000Z';

/** Shaped like open.er-api.com; NGN has more digits than a double can hold. */
const LIVE_BODY =
  '{"result":"success","base_code":"USD","rates":' +
  '{"USD":1,"EUR":0.85,"NGN":1490.123456789012345678,"GHS":11.5,"XAF":557.56,"JPY":150}}';

async function bootApp(fx: { url: string; timeoutMs: number }): Promise<INestApplication<App>> {
  process.env.FX_PROVIDER_URL = fx.url;
  process.env.FX_TIMEOUT_MS = String(fx.timeoutMs);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

async function insertFxRows(
  db: DataSource,
  table: Partial<Record<string, string>>,
  fetchedAt: string,
): Promise<void> {
  for (const [code, rate] of Object.entries(table)) {
    await db.query(
      `INSERT INTO fx_rates (base_currency, quote_currency, rate, source, fetched_at)
       VALUES ('USD', $1, $2, 'live', $3)`,
      [code, rate, fetchedAt],
    );
  }
}

/** Creates a wallet holding the given balances, set directly so this suite stays independent of the deposits endpoint. */
async function walletWith(
  app: INestApplication<App>,
  db: DataSource,
  email: string,
  balances: Partial<Record<string, string>>,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/wallets')
    .send({ email })
    .expect(201);
  const { id } = res.body as WalletDto;
  for (const [currency, amount] of Object.entries(balances)) {
    await db.query('UPDATE balances SET amount = $3 WHERE wallet_id = $1 AND currency = $2', [
      id,
      currency,
      amount,
    ]);
  }
  return id;
}

const getRates = async (app: INestApplication<App>): Promise<RatesDto> =>
  (await request(app.getHttpServer()).get('/api/v1/rates').expect(200)).body as RatesDto;

const getWallet = async (app: INestApplication<App>, id: string): Promise<WalletBalancesDto> =>
  (await request(app.getHttpServer()).get(`/api/v1/wallets/${id}`).expect(200))
    .body as WalletBalancesDto;

/** Asserts the full 20-pair matrix, every pair priced from `table` with one source and timestamp. */
function expectMatrix(
  body: RatesDto,
  table: UsdRateTable,
  source: string,
  fetchedAt: string,
): void {
  // Pair order and cross-rate math are unit-tested in pricing.spec.ts.
  const expected = allPairRates(table).map((pair) => ({ ...pair, source, fetched_at: fetchedAt }));
  expect(body.rates).toHaveLength(20);
  expect(body.rates).toEqual(expected);
  for (const { rate } of body.rates) {
    expect(rate).toMatch(/^[0-9]+\.[0-9]{18}$/);
  }
}

describe('GET /api/v1/rates (scenario 12)', () => {
  // A local server that accepts connections and never answers: the provider
  // is "down" in the way that exercises the timeout, with no network involved.
  let blackHole: FxStub;

  beforeAll(async () => {
    blackHole = await startBlackHole();
  });

  afterAll(async () => {
    await blackHole.close();
  });

  describe('with the provider hanging', () => {
    let app: INestApplication<App>;
    let db: DataSource;

    // A fresh app per test, so no in-memory snapshot carries over.
    beforeEach(async () => {
      app = await bootApp({ url: blackHole.url, timeoutMs: DOWN_TIMEOUT_MS });
      db = app.get(DataSource);
      await truncateAll(db);
    });

    afterEach(async () => {
      await truncateAll(db);
      await app.close();
    });

    it('serves all 20 pairs from FALLBACK_RATES when fx_rates is empty, as soon as the timeout fires', async () => {
      const hitsBefore = blackHole.hits();
      const started = Date.now();
      const body = await getRates(app);
      const elapsed = Date.now() - started;

      // The provider was asked and never answered, so only the configured
      // timeout can have ended the wait: not sooner, and not by much later.
      expect(blackHole.hits()).toBe(hitsBefore + 1);
      expect(elapsed).toBeGreaterThanOrEqual(DOWN_TIMEOUT_MS - 10);
      expect(elapsed).toBeLessThan(DOWN_TIMEOUT_MS + 1000);
      expectMatrix(body, FALLBACK_RATES, 'fallback', FALLBACK_RATES_AS_OF.toISOString());
    });

    it('still prices wallet totals, from the same fallback snapshot', async () => {
      const id = await walletWith(app, db, 'fallback@example.com', {
        cNGN: '1480',
        USDx: '2.5',
      });

      const wallet = await getWallet(app, id);

      expect(wallet.total_usd_equivalent).toBe('3.50000000');
      expect(wallet.rate_source).toBe('fallback');
      expect(wallet.rates_refreshed_at).toBe(FALLBACK_RATES_AS_OF.toISOString());
    });

    it('serves fx_rates rows as cached, with their fetched_at, for rates and wallet totals', async () => {
      await insertFxRows(db, CACHED_TABLE, CACHED_AT);
      const id = await walletWith(app, db, 'cached@example.com', { cNGN: '1500', USDx: '2.5' });

      expectMatrix(await getRates(app), CACHED_TABLE, 'cached', CACHED_AT);
      const wallet = await getWallet(app, id);
      expect(wallet.total_usd_equivalent).toBe('3.50000000');
      expect(wallet.rate_source).toBe('cached');
      expect(wallet.rates_refreshed_at).toBe(CACHED_AT);
    });

    it('skips an fx_rates table missing a fiat code and serves the fallback', async () => {
      const { XAF, ...partial } = CACHED_TABLE;
      expect(XAF).toBeDefined();
      await insertFxRows(db, partial, CACHED_AT);

      const body = await getRates(app);
      expect(body.rates.every((r) => r.source === 'fallback')).toBe(true);
    });
  });

  describe('with the provider up (a local stub server; no network)', () => {
    let provider: FxStub;

    beforeAll(async () => {
      provider = await startFxProvider(LIVE_BODY);
    });

    afterAll(async () => {
      await provider.close();
    });

    it('serves live rates, persists the whole table, then serves it as cached once the provider is down', async () => {
      const liveTable: UsdRateTable = {
        USD: '1.000000000000000000',
        EUR: '0.850000000000000000',
        NGN: '1490.123456789012345678',
        GHS: '11.500000000000000000',
        XAF: '557.560000000000000000',
      };

      const live = await bootApp({ url: provider.url, timeoutMs: 1000 });
      const db = live.get(DataSource);
      let fetchedAt: string;
      try {
        await truncateAll(db);
        const before = Date.now();
        const body = await getRates(live);
        fetchedAt = body.rates[0]?.fetched_at ?? '';

        expectMatrix(body, liveTable, 'live', fetchedAt);
        expect(new Date(fetchedAt).getTime()).toBeGreaterThanOrEqual(before);
        expect(provider.hits()).toBe(1);

        // The whole table, with exact digits and one fetched_at, landed in fx_rates.
        const rows: { quote_currency: string; rate: string; source: string; fetched_at: Date }[] =
          await db.query(
            `SELECT quote_currency, rate, source, fetched_at FROM fx_rates
              WHERE base_currency = 'USD' ORDER BY quote_currency`,
          );
        expect(rows.map((r) => [r.quote_currency, r.rate, r.source])).toEqual(
          Object.entries(liveTable)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([code, rate]) => [code, rate, 'live']),
        );
        expect(rows.every((r) => r.fetched_at.toISOString() === fetchedAt)).toBe(true);

        // Within the 60s TTL the snapshot is served from memory.
        expectMatrix(await getRates(live), liveTable, 'live', fetchedAt);
        expect(provider.hits()).toBe(1);
      } finally {
        await live.close();
      }

      const down = await bootApp({ url: blackHole.url, timeoutMs: DOWN_TIMEOUT_MS });
      try {
        expectMatrix(await getRates(down), liveTable, 'cached', fetchedAt);
      } finally {
        await truncateAll(down.get(DataSource));
        await down.close();
      }
    });
  });
});
