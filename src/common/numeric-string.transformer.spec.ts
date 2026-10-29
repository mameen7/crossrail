import { numericString } from './numeric-string.transformer';

describe('numericString transformer', () => {
  it('passes strings through unchanged in both directions', () => {
    expect(numericString.to('123.45678901')).toBe('123.45678901');
    expect(numericString.from('0.00000001')).toBe('0.00000001');
  });

  it('passes null through for nullable columns', () => {
    expect(numericString.to(null)).toBeNull();
    expect(numericString.from(null)).toBeNull();
  });

  it('refuses a JS number on write', () => {
    expect(() => {
      numericString.to(1.1);
    }).toThrow(TypeError);
  });

  it('refuses a JS number on read', () => {
    expect(() => {
      numericString.from(100);
    }).toThrow(TypeError);
  });
});
