import Decimal from 'decimal.js';
import { Currency } from '../common/currency';
import { parseAmount, toAmountString } from '../common/money';
import { FIAT_OF, UsdRateTable } from './fiat';

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
