import Decimal from 'decimal.js';
import { CURRENCIES } from '../common/currency';
import { FALLBACK_RATES } from './fallback-rates';
import { UsdRateTable } from './fiat';
import { allPairRates, crossRate, usdEquivalent, usdValue } from './pricing';

const TABLE: UsdRateTable = {
  USD: '1',
  EUR: '0.86',
  NGN: '1480',
  GHS: '11.2',
  XAF: '564.12',
};

describe('cross rates from a USD table', () => {
  describe('crossRate', () => {
    it('divides quote fiat by base fiat, quantized half-up to 18 dp', () => {
      expect(crossRate(TABLE, 'USDx', 'cNGN')).toBe('1480.000000000000000000');
      // 1/1480 = 0.000675675675675675|675...
      expect(crossRate(TABLE, 'cNGN', 'USDx')).toBe('0.000675675675675676');
      // 11.2/1480 = 0.007567567567567567|567...
      expect(crossRate(TABLE, 'cNGN', 'cGHS')).toBe('0.007567567567567568');
      // 1480/11.2 = 132.142857142857142857|142...
      expect(crossRate(TABLE, 'cGHS', 'cNGN')).toBe('132.142857142857142857');
      // 564.12/0.86, two non-USD legs
      expect(crossRate(TABLE, 'EURx', 'cXAF')).toBe('655.953488372093023256');
    });

    it('is exact for same-fiat pairs', () => {
      expect(crossRate(TABLE, 'cNGN', 'cNGN')).toBe('1.000000000000000000');
    });

    it('carries no binary-float error (0.1 + 0.2 style)', () => {
      const table: UsdRateTable = { ...TABLE, EUR: '0.3', GHS: '0.1' };
      // 0.3 / 0.1 is 2.9999999999999996 in floats
      expect(crossRate(table, 'cGHS', 'EURx')).toBe('3.000000000000000000');
    });
  });

  describe('allPairRates', () => {
    it('returns all 20 ordered pairs of distinct currencies, once each, in canonical order', () => {
      const pairs = allPairRates(TABLE);
      expect(pairs).toHaveLength(20);
      expect(pairs.some((p) => p.from === p.to)).toBe(false);
      expect(new Set(pairs.map((p) => `${p.from}>${p.to}`)).size).toBe(20);
      expect(pairs.slice(0, 4).map((p) => p.to)).toEqual(CURRENCIES.filter((c) => c !== 'cNGN'));
      expect(pairs[0]).toEqual({ from: 'cNGN', to: 'cGHS', rate: '0.007567567567567568' });
    });

    it('renders every rate at exactly 18 dp', () => {
      for (const { rate } of allPairRates(TABLE)) {
        expect(rate).toMatch(/^[0-9]+\.[0-9]{18}$/);
      }
    });
  });
});

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
