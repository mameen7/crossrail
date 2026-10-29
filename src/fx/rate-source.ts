/**
 * Which tier of the fallback chain priced a transaction or rate response.
 * `none` is reserved for same-currency operations, which carry rate 1.
 */
export const RATE_SOURCES = ['live', 'cached', 'fallback', 'none'] as const;

export type RateSource = (typeof RATE_SOURCES)[number];
