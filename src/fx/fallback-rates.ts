import { UsdRateTable } from './fiat';

/**
 * Last-resort pricing tier: approximate late-2026 mid-rates as a USD-based
 * table keyed by fiat code, the same shape the live provider returns
 * (`open.er-api.com/v6/latest/USD`), so all three tiers share one cross-rate
 * function (see `UsdRateTable`).
 *
 * This constant lives in code on purpose and is never written to `fx_rates`,
 * so a live upsert cannot overwrite it. Transactions priced from it record
 * `rate_source = 'fallback'`.
 */
export const FALLBACK_RATES: UsdRateTable = {
  USD: '1',
  EUR: '0.86',
  NGN: '1480',
  GHS: '11.2',
  XAF: '564.12', // pegged to EUR at 655.957; 0.86 * 655.957
};

/**
 * When the table above was written. Reported as the snapshot timestamp
 * whenever the fallback tier prices something, so a client never mistakes
 * the hardcoded table for a recent fetch.
 */
export const FALLBACK_RATES_AS_OF = new Date('2026-10-29T00:00:00.000Z');
