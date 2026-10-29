import Decimal from 'decimal.js';
import { CURRENCIES, Currency } from '../common/currency';
import { parseAmount, toAmountString, toRateString } from '../common/money';
import { FIAT_OF, UsdRateTable } from './fiat';

/**
 * Units of `to` per 1 unit of `from`, from a USD-based table:
 * `table[fiat(to)] / table[fiat(from)]`, computed exactly and quantized to
 * 18 dp once. This 18 dp string is the rate that gets exposed and stored, so
 * anything derived from it is derived from exactly what the client sees.
 */
export function crossRate(table: UsdRateTable, from: Currency, to: Currency): string {
  return toRateString(new Decimal(table[FIAT_OF[to]]).div(table[FIAT_OF[from]]));
}

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
