import Decimal from 'decimal.js';
import { ApiError } from '../common/api-error';
import { CURRENCIES, Currency } from '../common/currency';
import {
  parseAmount,
  parseRate,
  roundDownAmount,
  toAmountString,
  toRateString,
} from '../common/money';
import { FIAT_OF, UsdRateTable } from './fiat';
import { RateSnapshot } from './rates-source';

/**
 * Units of `to` per 1 unit of `from`, from a USD-based table:
 * `table[fiat(to)] / table[fiat(from)]`, computed exactly and quantized to
 * 18 dp once. This 18 dp string is the rate that gets exposed and stored, so
 * anything derived from it is derived from exactly what the client sees.
 */
export function crossRate(table: UsdRateTable, from: Currency, to: Currency): string {
  return toRateString(new Decimal(table[FIAT_OF[to]]).div(table[FIAT_OF[from]]));
}

/** A priced conversion: the rate to store and the amount it yields. */
export interface Conversion {
  /** 18 dp, exactly as stored in `transactions.fx_rate`. */
  readonly fxRate: string;
  /** round_down(source × fxRate, 8 dp); may be zero, see `assertNonZeroDestination`. */
  readonly destination: Decimal;
}

/**
 * The one pricing rule for every converting operation (swaps and
 * cross-currency transfers): quantize the cross rate to 18 dp first, then
 * derive the destination from that stored rate string, so the recorded rate
 * and the recorded amounts can never disagree in the last digit. The source
 * of the price is the snapshot's; the caller records `snapshot.source`.
 */
export function convert(
  source: Decimal,
  from: Currency,
  to: Currency,
  snapshot: RateSnapshot,
): Conversion {
  const fxRate = crossRate(snapshot.table, from, to);
  return { fxRate, destination: roundDownAmount(source.times(parseRate(fxRate))) };
}

/**
 * 422 `AMOUNT_TOO_SMALL` when a conversion rounds to zero at 8 dp. Callers
 * run it inside the idempotent transaction, after the key insert and before
 * any ledger write, so a replay of a committed operation wins over today's
 * rate. The details are keyed by the error code, not by the endpoint: they
 * describe the conversion (`from_currency`, `to_currency`, `amount`,
 * `fx_rate`), so swaps and transfers report it in one shape.
 */
export function assertNonZeroDestination(
  source: Decimal,
  from: Currency,
  to: Currency,
  { fxRate, destination }: Conversion,
): void {
  if (destination.isZero()) {
    throw ApiError.amountTooSmall({
      from_currency: from,
      to_currency: to,
      amount: toAmountString(source),
      fx_rate: fxRate,
    });
  }
}

/**
 * OpenAPI text for the 422 above, shared by every converting endpoint so the
 * documented details shape has one definition too.
 */
export const AMOUNT_TOO_SMALL_422 =
  'AMOUNT_TOO_SMALL: the converted amount rounds to zero at 8 dp; details are ' +
  '{ from_currency, to_currency, amount, fx_rate } describing the conversion, the same shape on every endpoint; ';

export interface PairRate {
  from: Currency;
  to: Currency;
  rate: string;
}

/** All 20 ordered pairs of distinct currencies, in canonical order. */
export function allPairRates(table: UsdRateTable): PairRate[] {
  return CURRENCIES.flatMap((from) =>
    CURRENCIES.filter((to) => to !== from).map((to) => ({
      from,
      to,
      rate: crossRate(table, from, to),
    })),
  );
}

/**
 * Exact USD value of one amount from a USD-based table:
 * `amount * table[USD] / table[fiat(currency)]` at full working precision,
 * so a valuation never shows a last-digit loss (1480 cNGN at 1480/USD is
 * exactly 1 USD).
 */
export function usdValue(table: UsdRateTable, currency: Currency, amount: Decimal): Decimal {
  return amount.times(table.USD).div(table[FIAT_OF[currency]]);
}

export interface PricedBalance {
  currency: Currency;
  amount: string;
}

/**
 * Total USD value of a set of balances as an 8 dp string: every balance is
 * valued exactly, the values are summed, and the total is rounded down once.
 */
export function usdEquivalent(table: UsdRateTable, balances: readonly PricedBalance[]): string {
  const total = balances.reduce(
    (acc, { currency, amount }) => acc.plus(usdValue(table, currency, parseAmount(amount))),
    new Decimal(0),
  );
  return toAmountString(total);
}
