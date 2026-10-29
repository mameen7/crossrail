/** The five supported stablecoins. Order is the canonical display order. */
export const CURRENCIES = ['cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx'] as const;

export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/** Quoted, comma-separated SQL list for `CHECK (col IN (...))` constraints. */
export function sqlStringList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

/** SQL fragment for CHECK constraints: `'cNGN', 'cGHS', ...` */
export const CURRENCY_SQL_LIST = sqlStringList(CURRENCIES);
