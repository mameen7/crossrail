import Decimal from 'decimal.js';
import { FALLBACK_RATES } from './fallback-rates';
import { usdEquivalent, usdValue } from './pricing';

describe('pricing against FALLBACK_RATES', () => {
  describe('usdValue', () => {
    it('values one unit of USD-pegged fiat as exactly 1 USD, with no last-digit loss', () => {
      expect(usdValue(FALLBACK_RATES, 'cNGN', new Decimal('1480')).equals(1)).toBe(true);
      expect(usdValue(FALLBACK_RATES, 'EURx', new Decimal('0.86')).equals(1)).toBe(true);
      expect(usdValue(FALLBACK_RATES, 'cGHS', new Decimal('11.2')).equals(1)).toBe(true);
      expect(usdValue(FALLBACK_RATES, 'cXAF', new Decimal('564.12')).equals(1)).toBe(true);
      expect(usdValue(FALLBACK_RATES, 'USDx', new Decimal('1')).equals(1)).toBe(true);
    });
  });

  describe('usdEquivalent', () => {
    it('is 0.00000000 for five zero balances', () => {
      expect(
        usdEquivalent(FALLBACK_RATES, [
          { currency: 'cNGN', amount: '0.00000000' },
          { currency: 'cGHS', amount: '0.00000000' },
          { currency: 'cXAF', amount: '0.00000000' },
          { currency: 'USDx', amount: '0.00000000' },
          { currency: 'EURx', amount: '0.00000000' },
        ]),
      ).toBe('0.00000000');
    });

    it('sums balances across currencies at the table rates', () => {
      expect(
        usdEquivalent(FALLBACK_RATES, [
          { currency: 'USDx', amount: '2.5' },
          { currency: 'cNGN', amount: '740' }, // 0.5 USD
          { currency: 'EURx', amount: '1.72' }, // 2 USD
        ]),
      ).toBe('5.00000000');
    });

    it('rounds the total DOWN to 8 dp', () => {
      // 1 / 1480 = 0.000675675675..., truncated at 8 dp
      expect(usdEquivalent(FALLBACK_RATES, [{ currency: 'cNGN', amount: '1' }])).toBe('0.00067567');
    });

    it('rounds once on the total, not per balance', () => {
      // Each line is worth 0.000000005 USD; per-line truncation would give 0.
      expect(
        usdEquivalent(FALLBACK_RATES, [
          { currency: 'cNGN', amount: '0.0000074' },
          { currency: 'cNGN', amount: '0.0000074' },
        ]),
      ).toBe('0.00000001');
    });

    it('refuses an amount that is not a valid amount string', () => {
      expect(() => usdEquivalent(FALLBACK_RATES, [{ currency: 'USDx', amount: '1e3' }])).toThrow(
        TypeError,
      );
    });
  });
});
