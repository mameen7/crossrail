import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { FALLBACK_RATES, FALLBACK_RATES_AS_OF, FALLBACK_SNAPSHOT } from './fallback-rates';
import { FxProvider } from './fx-provider';
import { FxRate } from './fx-rate.entity';
import { DB_TIMEOUT_MS, DEGRADED_TTL_MS, FxService, LIVE_TTL_MS } from './fx.service';

const TIMEOUT_MS = 25;

const LIVE_BODY =
  '{"result":"success","base_code":"USD","rates":' +
  '{"USD":1,"EUR":0.85,"NGN":1490.123456789012345678,"GHS":11.5,"XAF":557.56,"JPY":150}}';

const LIVE_TABLE = {
  USD: '1.000000000000000000',
  EUR: '0.850000000000000000',
  NGN: '1490.123456789012345678',
  GHS: '11.500000000000000000',
  XAF: '557.560000000000000000',
};

/** What `fx_rates` returns: numeric(38,18) renders with 18 dp. */
const CACHED_TABLE = {
  USD: '1.000000000000000000',
  EUR: '0.870000000000000000',
  NGN: '1500.000000000000000000',
  GHS: '12.000000000000000000',
  XAF: '570.000000000000000000',
};
const CACHED_AT = new Date('2026-10-28T09:00:00.000Z');

const cachedRows = (table: Record<string, string>, fetchedAt = CACHED_AT): FxRate[] =>
  Object.entries(table).map(([quoteCurrency, rate]) => ({
    baseCurrency: 'USD',
    quoteCurrency,
    rate,
    source: 'live',
    fetchedAt,
  }));

/** A fetch that never answers and rejects only when its signal aborts. */
const hangUntilAborted = (_url: unknown, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error('fetch was called without a timeout signal'));
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error));
  });

describe('FxService', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let upsert: jest.Mock;
  let transaction: jest.Mock;
  let findBy: jest.Mock;
  let service: FxService;

  beforeEach(() => {
    // Any fetch a test does not stub fails, so no test can reach the network.
    fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    upsert = jest.fn().mockResolvedValue(undefined);
    transaction = jest.fn((fn: (em: EntityManager) => Promise<unknown>) =>
      fn({ upsert } as unknown as EntityManager),
    );
    findBy = jest.fn().mockResolvedValue([]);

    const config = {
      get: (key: string) => ({ FX_TIMEOUT_MS: String(TIMEOUT_MS) })[key],
    } as unknown as ConfigService;
    service = new FxService(
      new FxProvider(config),
      { transaction } as unknown as DataSource,
      { findBy } as unknown as Repository<FxRate>,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('live tier', () => {
    it('serves a fresh fetch as live, stamped with the fetch time', async () => {
      fetchMock.mockResolvedValue(new Response(LIVE_BODY));
      const before = Date.now();

      const snapshot = await service.getSnapshot();

      expect(snapshot.source).toBe('live');
      expect(snapshot.table).toEqual(LIVE_TABLE);
      expect(snapshot.fetchedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(snapshot.fetchedAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(findBy).not.toHaveBeenCalled();
    });

    it('upserts the whole table into fx_rates in one transaction', async () => {
      fetchMock.mockResolvedValue(new Response(LIVE_BODY));

      const snapshot = await service.getSnapshot();

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledTimes(1);
      const [entity, rows, conflictPaths] = upsert.mock.calls[0] as [unknown, FxRate[], string[]];
      expect(entity).toBe(FxRate);
      expect(conflictPaths).toEqual(['baseCurrency', 'quoteCurrency']);
      expect(rows).toHaveLength(5);
      expect(rows).toEqual(expect.arrayContaining(cachedRows(LIVE_TABLE, snapshot.fetchedAt)));
    });

    it('still serves live rates when persisting them fails', async () => {
      fetchMock.mockResolvedValue(new Response(LIVE_BODY));
      transaction.mockRejectedValue(new Error('database is down'));

      const snapshot = await service.getSnapshot();

      expect(snapshot.source).toBe('live');
      expect(snapshot.table).toEqual(LIVE_TABLE);
    });
  });

  describe('falling back to fx_rates (cached)', () => {
    beforeEach(() => {
      findBy.mockResolvedValue(cachedRows(CACHED_TABLE));
    });

    it('when the provider times out', async () => {
      fetchMock.mockImplementation(hangUntilAborted);
      const started = Date.now();

      const snapshot = await service.getSnapshot();

      expect(snapshot).toEqual({ table: CACHED_TABLE, source: 'cached', fetchedAt: CACHED_AT });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(findBy).toHaveBeenCalledWith({ baseCurrency: 'USD' });
    });

    it('when the provider returns a 5xx', async () => {
      fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));
      expect((await service.getSnapshot()).source).toBe('cached');
    });

    it('when the network fails', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      expect((await service.getSnapshot()).source).toBe('cached');
    });

    it('when the live response is missing one of the five fiat codes, without persisting it', async () => {
      fetchMock.mockResolvedValue(
        new Response('{"rates":{"USD":1,"EUR":0.85,"NGN":1490,"GHS":11.5}}'),
      );

      const snapshot = await service.getSnapshot();

      expect(snapshot.source).toBe('cached');
      expect(upsert).not.toHaveBeenCalled();
    });

    it("stamps the snapshot with the oldest row's fetched_at", async () => {
      const rows = cachedRows(CACHED_TABLE);
      const older = new Date('2026-10-27T00:00:00.000Z');
      rows[2] = { ...rows[2]!, fetchedAt: older };
      findBy.mockResolvedValue(rows);
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      expect((await service.getSnapshot()).fetchedAt).toEqual(older);
    });

    it('ignores rows outside the five fiat codes, for the table and for fetched_at', async () => {
      const stale = cachedRows({ JPY: '150.000000000000000000' }, new Date('2026-09-01T00:00:00Z'));
      findBy.mockResolvedValue([...cachedRows(CACHED_TABLE), ...stale]);
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      expect(await service.getSnapshot()).toEqual({
        table: CACHED_TABLE,
        source: 'cached',
        fetchedAt: CACHED_AT,
      });
    });
  });

  describe('falling back to FALLBACK_RATES', () => {
    beforeEach(() => {
      fetchMock.mockImplementation(hangUntilAborted);
    });

    const expectFallback = async (): Promise<void> => {
      expect(await service.getSnapshot()).toEqual({
        table: FALLBACK_RATES,
        source: 'fallback',
        fetchedAt: FALLBACK_RATES_AS_OF,
      });
    };

    it('when fx_rates holds only codes outside the five fiat', async () => {
      findBy.mockResolvedValue(cachedRows({ JPY: '150.000000000000000000' }));
      await expectFallback();
    });

    it('when the provider times out and fx_rates is empty', async () => {
      findBy.mockResolvedValue([]);
      await expectFallback();
    });

    it('when fx_rates is missing one of the five fiat codes', async () => {
      findBy.mockResolvedValue(cachedRows(CACHED_TABLE).filter((r) => r.quoteCurrency !== 'XAF'));
      await expectFallback();
    });

    it('when fx_rates cannot be read at all', async () => {
      findBy.mockRejectedValue(new Error('connection refused'));
      await expectFallback();
    });
  });

  describe('a slow or unreachable database', () => {
    const never = (): Promise<never> => new Promise<never>(() => undefined);

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not hold back live rates while the fx_rates upsert hangs', async () => {
      fetchMock.mockResolvedValue(new Response(LIVE_BODY));
      transaction.mockImplementation(never);

      const pending = service.getSnapshot();
      await jest.advanceTimersByTimeAsync(DB_TIMEOUT_MS);

      expect((await pending).source).toBe('live');
    });

    it('falls through to FALLBACK_RATES while the fx_rates read hangs', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      findBy.mockImplementation(never);

      const pending = service.getSnapshot();
      await jest.advanceTimersByTimeAsync(DB_TIMEOUT_MS);

      expect(await pending).toBe(FALLBACK_SNAPSHOT);
    });
  });

  describe('in-memory snapshot', () => {
    it('serves a live snapshot for 60s, then runs the chain again', async () => {
      const now = jest.spyOn(Date, 'now');
      const t0 = 1_800_000_000_000;
      fetchMock.mockImplementation(() => Promise.resolve(new Response(LIVE_BODY)));

      now.mockReturnValue(t0);
      const first = await service.getSnapshot();
      expect(LIVE_TTL_MS).toBe(60_000);
      now.mockReturnValue(t0 + LIVE_TTL_MS - 1);
      expect(await service.getSnapshot()).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now.mockReturnValue(t0 + LIVE_TTL_MS);
      expect(await service.getSnapshot()).not.toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('holds a degraded snapshot only briefly: one timeout per interval, and quick recovery', async () => {
      const now = jest.spyOn(Date, 'now');
      const t0 = 1_800_000_000_000;
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      now.mockReturnValue(t0);
      expect((await service.getSnapshot()).source).toBe('fallback');
      now.mockReturnValue(t0 + DEGRADED_TTL_MS - 1);
      expect((await service.getSnapshot()).source).toBe('fallback');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The provider is back; the next resolution after the short hold sees it.
      fetchMock.mockImplementation(() => Promise.resolve(new Response(LIVE_BODY)));
      now.mockReturnValue(t0 + DEGRADED_TTL_MS);
      expect((await service.getSnapshot()).source).toBe('live');
      expect(DEGRADED_TTL_MS).toBeLessThan(LIVE_TTL_MS);
    });

    it('shares one in-flight fetch between concurrent callers', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response(LIVE_BODY)));

      const [a, b, c] = await Promise.all([
        service.getSnapshot(),
        service.getSnapshot(),
        service.getSnapshot(),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(b).toBe(a);
      expect(c).toBe(a);
    });
  });
});
