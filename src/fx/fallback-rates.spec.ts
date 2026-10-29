import Decimal from 'decimal.js';
import { CURRENCIES } from '../common/currency';
import { FALLBACK_RATES } from './fallback-rates';
import { FIAT_CODES, FIAT_OF, parseUsdRateTable } from './fiat';

describe('FALLBACK_RATES', () => {
  it('covers the fiat of all five supported currencies and nothing else', () => {
    const needed = CURRENCIES.map((c) => FIAT_OF[c]).sort();
    expect(Object.keys(FALLBACK_RATES).sort()).toEqual(needed);
    expect(needed).toEqual([...FIAT_CODES].sort());
  });

  it('holds every rate as a string that parses to a finite positive decimal', () => {
    for (const currency of CURRENCIES) {
      const raw = FALLBACK_RATES[FIAT_OF[currency]];
      expect(typeof raw).toBe('string');

      const rate = new Decimal(raw);
      expect(rate.isFinite()).toBe(true);
      expect(rate.isPositive()).toBe(true);
      expect(rate.isZero()).toBe(false);
    }
  });

  it('is USD-based: USD is exactly 1', () => {
    expect(new Decimal(FALLBACK_RATES.USD).equals(1)).toBe(true);
  });

  it('passes the same validation as a live or cached table', () => {
    expect(() => parseUsdRateTable(FALLBACK_RATES)).not.toThrow();
  });
});
