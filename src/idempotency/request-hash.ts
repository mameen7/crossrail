import { createHash } from 'node:crypto';

/**
 * Serializes a JSON value with every object's keys sorted, recursively, so
 * two wire encodings of the same request serialize identically. Array order
 * is kept: `[a, b]` and `[b, a]` are different requests. `undefined` (no body)
 * serializes as `null`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/**
 * The `idempotency_keys.request_hash` for a request: sha256 (hex) over the
 * canonical serialization of its body and path parameters. Hashing the
 * parameters too means the same key and body on a different wallet is a
 * different request (422 `IDEMPOTENCY_KEY_REUSED`), not a replay.
 */
export function hashRequest(body: unknown, params: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson({ body, params })).digest('hex');
}
