import { UsdRateTable } from './fiat';
import { RateSource } from './rate-source';

/**
 * A whole USD table taken at one moment from one tier of the fallback chain.
 * Rates are only ever consumed as a snapshot, so every figure derived from
 * one (a wallet's USD total, every pair in `GET /rates`, a transaction's
 * `fx_rate`) carries exactly one `source` and one timestamp.
 */
export interface RateSnapshot {
  readonly table: UsdRateTable;
  readonly source: RateSource;
  readonly fetchedAt: Date;
}

/**
 * Where callers get rates from. Declared as an abstract class so it doubles as
 * the Nest injection token. `FxModule` binds it to `FxService`, the
 * live → cached → fallback chain.
 */
export abstract class RatesSource {
  abstract getSnapshot(): Promise<RateSnapshot>;
}
