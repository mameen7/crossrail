import Decimal from 'decimal.js';
import { isAmountString, parseAmount, roundDownAmount, toAmountString } from './money';

describe('money', () => {
  describe('isAmountString (request format)', () => {
    it.each(['0', '1', '150000.00', '0.00000001', '99999999999999999999.12345678'])(
      'accepts %s',
      (value) => {
        expect(isAmountString(value)).toBe(true);
      },
    );

    it.each([
      ['more than 8 dp', '1.123456789'],
      ['more than 20 integer digits', '123456789012345678901'],
      ['negative', '-1'],
      ['exponent notation', '1e5'],
      ['leading plus', '+1'],
      ['surrounding whitespace', ' 1'],
      ['trailing dot', '1.'],
      ['leading dot', '.5'],
      ['hex', '0x10'],
      ['empty', ''],
      ['NaN', 'NaN'],
    ])('rejects %s (%s)', (_label, value) => {
      expect(isAmountString(value)).toBe(false);
    });

    it('rejects JS numbers outright', () => {
      expect(isAmountString(1.5)).toBe(false);
      expect(isAmountString(1)).toBe(false);
    });
  });

  describe('parseAmount (stored values)', () => {
    it('parses any non-negative decimal with at most 8 dp, including 30 integer digits', () => {
      const thirty = '123456789012345678901234567890.12345678';
      expect(parseAmount(thirty).toFixed(8)).toBe(thirty);
      expect(parseAmount('0').isZero()).toBe(true);
      expect(parseAmount('0.00000000').isZero()).toBe(true);
    });

    it.each(['1.123456789', '-1', '1e5', ' 1', '1.', '.5', '', 'NaN', '+1'])(
      'refuses %j',
      (value) => {
        expect(() => parseAmount(value)).toThrow(TypeError);
      },
    );

    it('refuses a JS number even when the type system is bypassed', () => {
      expect(() => parseAmount(1 as unknown as string)).toThrow(TypeError);
    });
  });

  describe('rounding', () => {
    it('rounds amounts DOWN to 8 dp, never up', () => {
      expect(toAmountString(new Decimal('1.999999999'))).toBe('1.99999999');
      expect(toAmountString(new Decimal('0.000000009'))).toBe('0.00000000');
      expect(roundDownAmount(new Decimal('2.123456785')).toString()).toBe('2.12345678');
    });

    it('always renders exactly 8 dp', () => {
      expect(toAmountString(new Decimal('0'))).toBe('0.00000000');
      expect(toAmountString(new Decimal('150000'))).toBe('150000.00000000');
      expect(toAmountString(new Decimal('1.5'))).toBe('1.50000000');
    });

    it('keeps full precision through a large multiplication', () => {
      // 20 integer digits times an 18 dp rate needs more than decimal.js's
      // default 20 significant digits.
      const product = parseAmount('99999999999999999999.12345678').times(
        new Decimal('0.000675100000000000'),
      );
      // 67510000000000000 - 0.87654322 * 0.0006751 = 67509999999999999.999408245672178
      expect(toAmountString(product)).toBe('67509999999999999.99940824');
    });
  });
});
