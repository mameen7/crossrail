import { Currency } from '../common/currency';

/** ISO 4217 codes the stablecoins are priced against, 1:1. */
export const FIAT_CODES = ['NGN', 'GHS', 'XAF', 'USD', 'EUR'] as const;

export type FiatCode = (typeof FIAT_CODES)[number];

/** Each stablecoin maps 1:1 to its fiat for pricing. */
export const FIAT_OF: Readonly<Record<Currency, FiatCode>> = {
  cNGN: 'NGN',
  cGHS: 'GHS',
  cXAF: 'XAF',
  USDx: 'USD',
  EURx: 'EUR',
};

/**
 * A USD-based rate table: units of each fiat per 1 USD, as decimal strings.
 * The live provider, the `fx_rates` cache and `FALLBACK_RATES` all take this
 * shape, so one cross-rate function serves every tier:
 * `rate(A -> B) = table[FIAT_OF[B]] / table[FIAT_OF[A]]`.
 */
export type UsdRateTable = Readonly<Record<FiatCode, string>>;
