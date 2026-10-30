import { ApiError } from '../common/api-error';
import { decodeCursor, encodeCursor } from './history-cursor';

const CURSOR = {
  createdAt: '2026-10-29T12:00:00.123456Z',
  id: 'c91d4f2a-8b3e-4d1c-9f6a-2e7b5c8d9a0f',
};

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

function expectMalformed(value: string): void {
  let thrown: unknown;
  try {
    decodeCursor(value);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  const error = thrown as ApiError;
  expect(error.getStatus()).toBe(422);
  expect(error.toBody()).toEqual({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ field: 'cursor', messages: [expect.any(String)] }],
    },
  });
}

describe('history cursor', () => {
  it('round-trips (created_at, id) through an opaque base64url string', () => {
    const encoded = encodeCursor(CURSOR);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(CURSOR);
  });

  it('keeps microseconds, so two rows in the same millisecond get different cursors', () => {
    const a = encodeCursor(CURSOR);
    const b = encodeCursor({ ...CURSOR, createdAt: '2026-10-29T12:00:00.123457Z' });
    expect(a).not.toBe(b);
    expect(decodeCursor(b).createdAt).toBe('2026-10-29T12:00:00.123457Z');
  });

  it('accepts the earliest and latest instants Postgres accepts in this format', () => {
    for (const createdAt of ['0001-01-01T00:00:00.000000Z', '9999-12-31T23:59:59.999999Z']) {
      expect(decodeCursor(encodeCursor({ ...CURSOR, createdAt }))).toEqual({
        ...CURSOR,
        createdAt,
      });
    }
  });

  it.each([
    ['empty', ''],
    ['not base64url text', 'not a cursor!'],
    ['base64url of arbitrary text', b64('hello')],
    ['no separator', b64(`${CURSOR.createdAt}${CURSOR.id}`)],
    ['an extra field', b64(`${CURSOR.createdAt}_${CURSOR.id}_x`)],
    ['fields swapped', b64(`${CURSOR.id}_${CURSOR.createdAt}`)],
    ['millisecond precision', b64(`2026-10-29T12:00:00.123Z_${CURSOR.id}`)],
    ['an offset instead of Z', b64(`2026-10-29T12:00:00.123456+01:00_${CURSOR.id}`)],
    ['month 13', b64(`2026-13-01T00:00:00.000000Z_${CURSOR.id}`)],
    ['February 30 (Postgres: out of range)', b64(`2026-02-30T00:00:00.000000Z_${CURSOR.id}`)],
    ['hour 24 (Postgres would roll it over)', b64(`2026-01-01T24:00:00.000000Z_${CURSOR.id}`)],
    ['year 0 (Postgres: out of range)', b64(`0000-01-01T00:00:00.000000Z_${CURSOR.id}`)],
    ['a malformed uuid', b64(`${CURSOR.createdAt}_c91d4f2a-8b3e-4d1c-9f6a-2e7b5c8d9a0`)],
    ['an uppercase uuid', b64(`${CURSOR.createdAt}_${CURSOR.id.toUpperCase()}`)],
    ['SQL in the id', b64(`${CURSOR.createdAt}_' OR 1=1 --`)],
  ])('rejects %s as 422 VALIDATION_ERROR on cursor', (_label, value) => {
    expectMalformed(value);
  });

  it.each([
    ['a junk character appended', (c: string) => `${c}!`],
    ['base64 padding appended', (c: string) => `${c}==`],
    ['standard base64 alphabet', (c: string) => Buffer.from(c, 'base64url').toString('base64')],
    ['a character dropped', (c: string) => c.slice(0, -1)],
  ])('rejects a valid cursor with %s', (_label, tamper) => {
    // The id ends so that standard base64 differs from base64url (+ or /) or adds padding.
    const encoded = encodeCursor({ ...CURSOR, id: 'ffffffff-ffff-4fff-bfff-fffffffffffe' });
    expect(tamper(encoded)).not.toBe(encoded);
    expectMalformed(tamper(encoded));
  });
});
