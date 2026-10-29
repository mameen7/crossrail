import Decimal from 'decimal.js';

/**
 * The one place amounts are parsed, rounded and formatted (hard rule 1).
 *
 * Amounts are decimal strings everywhere outside this file: in JSON, in the
 * database and in entities. Arithmetic happens on `Decimal` instances and the
 * result is rendered back through `toAmountString`, which rounds DOWN to 8 dp.
 */

/** Significant digits for every Decimal operation in the process. The default
 *  of 20 is too few to multiply a 38-digit amount by an 18 dp rate exactly. */
Decimal.set({ precision: 80 });

export const AMOUNT_SCALE = 8;

/**
 * Request-side amount format from SPEC.md: up to 20 integer digits and up to
 * 8 decimals. It admits zero on purpose; "greater than zero" is a separate
 * check that mutating endpoints apply after the format check.
 */
export const AMOUNT_PATTERN = /^[0-9]{1,20}(\.[0-9]{1,8})?$/;

export function isAmountString(value: unknown): value is string {
  return typeof value === 'string' && AMOUNT_PATTERN.test(value);
}

/**
 * Any non-negative decimal with at most 8 dp, with no cap on integer digits:
 * `numeric(38,8)` holds up to 30 of them, so this is what stored balances
 * are parsed with. Everything else (a JS number, exponent notation, a sign,
 * whitespace, more than 8 dp) is refused rather than coerced.
 */
const STORED_AMOUNT_PATTERN = /^[0-9]+(\.[0-9]{1,8})?$/;

export function parseAmount(value: string): Decimal {
  if (typeof value !== 'string' || !STORED_AMOUNT_PATTERN.test(value)) {
    throw new TypeError(`Invalid amount string: ${JSON.stringify(value)}`);
  }
  return new Decimal(value);
}

/** Rounds DOWN to 8 dp. */
export function roundDownAmount(value: Decimal): Decimal {
  return value.toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_DOWN);
}

/** Renders an amount as a fixed 8 dp string, rounding DOWN. */
export function toAmountString(value: Decimal): string {
  return roundDownAmount(value).toFixed(AMOUNT_SCALE);
}
