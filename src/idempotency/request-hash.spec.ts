import { canonicalJson, hashRequest } from './request-hash';

const PARAMS = { id: '7f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f' };

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: { d: 1, c: [{ z: 1, y: 2 }] }, a: 'x' })).toBe(
      '{"a":"x","b":{"c":[{"y":2,"z":1}],"d":1}}',
    );
  });

  it('serializes an absent body as null', () => {
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(null)).toBe('null');
  });

  it('keeps amount strings as strings', () => {
    expect(canonicalJson({ amount: '10.50' })).toBe('{"amount":"10.50"}');
  });
});

describe('hashRequest', () => {
  it('is a 64-char hex sha256', () => {
    expect(hashRequest({ currency: 'cNGN', amount: '1' }, PARAMS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes two key orderings of the same request identically, nested too', () => {
    const a = hashRequest({ currency: 'cNGN', amount: '1', meta: { x: 1, y: [1, 2] } }, PARAMS);
    const b = hashRequest({ meta: { y: [1, 2], x: 1 }, amount: '1', currency: 'cNGN' }, PARAMS);
    expect(a).toBe(b);
  });

  it('is the same whatever the order of the params object', () => {
    expect(hashRequest({}, { a: '1', b: '2' })).toBe(hashRequest({}, { b: '2', a: '1' }));
  });

  it('changes when a value, array order or path parameter changes', () => {
    const base = hashRequest({ currency: 'cNGN', amount: '1', tags: ['a', 'b'] }, PARAMS);
    expect(hashRequest({ currency: 'cNGN', amount: '1.0', tags: ['a', 'b'] }, PARAMS)).not.toBe(
      base,
    );
    expect(hashRequest({ currency: 'cNGN', amount: '1', tags: ['b', 'a'] }, PARAMS)).not.toBe(base);
    expect(
      hashRequest(
        { currency: 'cNGN', amount: '1', tags: ['a', 'b'] },
        { id: '00000000-0000-4000-8000-000000000000' },
      ),
    ).not.toBe(base);
  });

  it('distinguishes a missing body from an empty object', () => {
    expect(hashRequest(undefined, PARAMS)).not.toBe(hashRequest({}, PARAMS));
  });
});
