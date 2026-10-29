import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FALLBACK_SNAPSHOT } from './fallback-rates';
import { FIAT_CODES, isFiatCode, parseUsdRateTable } from './fiat';
import { FxProvider } from './fx-provider';
import { FxRate } from './fx-rate.entity';
import { RateSnapshot, RatesSource } from './rates-source';

/** How long a live snapshot is served from memory before the chain runs again. */
export const LIVE_TTL_MS = 60_000;

/**
 * How long a cached or fallback snapshot is held. Short, so a provider that
 * recovers is back in use within seconds, yet long enough that an outage
 * costs one timeout per interval rather than one per request.
 */
export const DEGRADED_TTL_MS = 10_000;

/**
 * Upper bound on each `fx_rates` read or write on the request path. pg sets no
 * connection timeout by default, so without this an unreachable database
 * would stall rate reads that the provider or the fallback could answer.
 */
export const DB_TIMEOUT_MS = 1_000;

/**
 * The live → cached → fallback chain behind every rate consumer.
 *
 * 1. `live`: a fresh provider fetch (3s timeout). On success the whole table
 *    is upserted into `fx_rates` in one transaction.
 * 2. `cached`: the `fx_rates` rows, if all five fiat codes are present.
 * 3. `fallback`: the in-code `FALLBACK_RATES`, which cannot fail.
 *
 * So `getSnapshot` never rejects because the provider or the database is
 * down, and it settles within the FX timeout plus `DB_TIMEOUT_MS`. Live
 * snapshots are held in memory for `LIVE_TTL_MS`, lower tiers for
 * `DEGRADED_TTL_MS`. Concurrent callers on an expired snapshot share one
 * resolution.
 */
@Injectable()
export class FxService extends RatesSource {
  private readonly logger = new Logger(FxService.name);
  private memo: { snapshot: RateSnapshot; expiresAt: number } | null = null;
  private inflight: Promise<RateSnapshot> | null = null;

  constructor(
    private readonly provider: FxProvider,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(FxRate) private readonly fxRates: Repository<FxRate>,
  ) {
    super();
  }

  getSnapshot(): Promise<RateSnapshot> {
    if (this.memo !== null && Date.now() < this.memo.expiresAt) {
      return Promise.resolve(this.memo.snapshot);
    }
    this.inflight ??= this.resolve()
      .then((snapshot) => {
        const ttl = snapshot.source === 'live' ? LIVE_TTL_MS : DEGRADED_TTL_MS;
        this.memo = { snapshot, expiresAt: Date.now() + ttl };
        return snapshot;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async resolve(): Promise<RateSnapshot> {
    try {
      return await this.fetchLive();
    } catch (err) {
      this.logger.warn(`Live FX fetch failed, trying fx_rates: ${describeError(err)}`);
    }
    try {
      return await withTimeout(this.readCached(), DB_TIMEOUT_MS, 'fx_rates read');
    } catch (err) {
      this.logger.warn(`No usable fx_rates, using FALLBACK_RATES: ${describeError(err)}`);
    }
    return FALLBACK_SNAPSHOT;
  }

  private async fetchLive(): Promise<RateSnapshot> {
    const table = await this.provider.fetchTable();
    const snapshot: RateSnapshot = { table, source: 'live', fetchedAt: new Date() };
    await this.persist(snapshot);
    return snapshot;
  }

  /**
   * Best effort and bounded: a failed or slow write never holds back the live
   * rates. A write still running at the deadline is left to finish or fail on
   * its own; it is one transaction, so it lands whole or not at all.
   */
  private async persist({ table, fetchedAt }: RateSnapshot): Promise<void> {
    const rows = FIAT_CODES.map((code) => ({
      baseCurrency: 'USD',
      quoteCurrency: code,
      rate: table[code],
      source: 'live',
      fetchedAt,
    }));
    try {
      await withTimeout(
        this.dataSource.transaction((em) =>
          em.upsert(FxRate, rows, ['baseCurrency', 'quoteCurrency']),
        ),
        DB_TIMEOUT_MS,
        'fx_rates upsert',
      );
    } catch (err) {
      this.logger.warn(`Could not persist live FX rates: ${describeError(err)}`);
    }
  }

  /**
   * Only the five fiat rows count, and `fetchedAt` is the oldest of them, so a
   * snapshot never claims to be fresher than its parts.
   */
  private async readCached(): Promise<RateSnapshot> {
    const rows = (await this.fxRates.findBy({ baseCurrency: 'USD' })).filter((r) =>
      isFiatCode(r.quoteCurrency),
    );
    if (rows.length === 0) {
      throw new Error('fx_rates has no rows for the five fiat codes');
    }
    const table = parseUsdRateTable(Object.fromEntries(rows.map((r) => [r.quoteCurrency, r.rate])));
    const oldest = rows.reduce((a, b) => (b.fetchedAt < a.fetchedAt ? b : a));
    return { table, source: 'cached', fetchedAt: oldest.fetchedAt };
  }
}

/** Rejects if `work` has not settled within `ms`. Does not cancel `work`. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return `${err.name}: ${err.message}${cause}`;
}
