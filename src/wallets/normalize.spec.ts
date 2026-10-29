import { normalizeEmail, normalizePhone } from './normalize';

describe('normalizeEmail', () => {
  it('lowercases', () => {
    expect(normalizeEmail('Ada@Example.COM')).toBe('ada@example.com');
  });

  it('leaves an already-canonical address unchanged', () => {
    expect(normalizeEmail('ada@example.com')).toBe('ada@example.com');
  });
});

describe('normalizePhone', () => {
  it('strips spaces and dashes and keeps the leading plus', () => {
    expect(normalizePhone('+234 800-000-0000')).toBe('+2348000000000');
    expect(normalizePhone('0800 000 0000')).toBe('08000000000');
    expect(normalizePhone('+1-415-555-0100')).toBe('+14155550100');
  });

  it('leaves an already-canonical number unchanged', () => {
    expect(normalizePhone('+2348000000000')).toBe('+2348000000000');
  });

  it('maps the same number written differently to one canonical form', () => {
    const forms = ['+2348000000000', '+234 800 000 0000', '+234-800-000-0000', '+234 800-0000-000'];
    expect(new Set(forms.map(normalizePhone)).size).toBe(1);
  });
});
