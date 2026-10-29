import Decimal from 'decimal.js';
import { Currency } from '../common/currency';
import { toRateString } from '../common/money';

/** ISO 4217 codes the stablecoins are priced against, 1:1. */
export const FIAT_CODES = ['NGN', 'GHS', 'XAF', 'USD', 'EUR'] as const;

export type FiatCode = (typeof FIAT_CODES)[number];

export function isFiatCode(value: unknown): value is FiatCode {
  return typeof value === 'string' && (FIAT_CODES as readonly string[]).includes(value);
}

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

/**
 * Base-10 decimal, optionally with an exponent: the JSON number grammar minus
 * the sign. Checked before `new Decimal`, which would also accept hex, binary
 * and octal strings (`'0x5C8'` is 1480).
 */
const DECIMAL_LITERAL = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/** `numeric(38,18)` holds at most 20 integer digits. */
const RATE_LIMIT = new Decimal('1e20');

/**
 * Builds a `UsdRateTable` from untrusted input (a provider response or
 * `fx_rates` rows), keeping only the five fiat codes. Anything missing or
 * invalid throws, so a partial table can never price anything:
 *
 * - each rate is a base-10 decimal string (never a JS number), range-checked
 *   before it is formatted, so `'1e999999999'` is refused rather than
 *   rendered;
 * - every cross rate the table implies must fit `numeric(38,18)` and stay
 *   non-zero at 18 dp. The extremes are max/min and min/max, so checking
 *   those two covers all 20 pairs.
 */
export function parseUsdRateTable(raw: Readonly<Record<string, unknown>>): UsdRateTable {
  const table = {} as Record<FiatCode, string>;
  const values: Decimal[] = [];
  for (const code of FIAT_CODES) {
    const value = raw[code];
    if (typeof value !== 'string' || !DECIMAL_LITERAL.test(value)) {
      throw new TypeError(`Rate for ${code} is not a decimal string: ${JSON.stringify(value)}`);
    }
    const rate = new Decimal(value);
    if (rate.isZero() || rate.gte(RATE_LIMIT)) {
      throw new TypeError(`Rate for ${code} is out of range: ${value}`);
    }
    const quantized = toRateString(rate);
    if (new Decimal(quantized).isZero()) {
      throw new TypeError(`Rate for ${code} rounds to zero at 18 dp: ${value}`);
    }
    table[code] = quantized;
    values.push(new Decimal(quantized));
  }

  const hi = Decimal.max(...values);
  const lo = Decimal.min(...values);
  if (hi.div(lo).gte(RATE_LIMIT) || new Decimal(toRateString(lo.div(hi))).isZero()) {
    throw new TypeError(
      `Rate table spread is too wide for 18 dp cross rates (${lo.toString()} to ${hi.toString()})`,
    );
  }
  return table;
}
