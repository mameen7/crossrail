import { ApiError } from '../common/api-error';

/**
 * A keyset position in a wallet's history: the last row of the previous page.
 * `createdAt` keeps Postgres's full microsecond precision (a JS `Date` would
 * truncate it to milliseconds and the next page could skip rows created
 * within the same millisecond); `id` breaks ties between rows sharing a
 * timestamp.
 */
export interface HistoryCursor {
  /** UTC, exactly `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  readonly createdAt: string;
  /** Lowercase UUID, as Postgres renders it. */
  readonly id: string;
}

/**
 * SQL rendering a row's `created_at` in exactly the format `createdAt` takes:
 * UTC, microseconds, `Z`. The one place that format is produced.
 */
export const CURSOR_TS_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SEPARATOR = '_';

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opaque to clients: base64url of `<createdAt>_<id>`. */
export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.createdAt}${SEPARATOR}${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * The inverse of `encodeCursor`, and the only gate between a client-supplied
 * cursor and SQL. Anything `encodeCursor` could not have produced is 422
 * `VALIDATION_ERROR`, so a tampered cursor never reaches Postgres as an
 * invalid timestamp or uuid (which would surface as a 500).
 */
export function decodeCursor(value: string): HistoryCursor {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const [createdAt, id, ...rest] = decoded.split(SEPARATOR);
  if (
    createdAt === undefined ||
    id === undefined ||
    rest.length > 0 ||
    !isTimestamp(createdAt) ||
    !UUID_RE.test(id)
  ) {
    throw malformed();
  }
  const cursor = { createdAt, id };
  // Base64url decoding skips characters outside its alphabet, so also demand
  // the canonical spelling: no junk, padding or trailing bits survive.
  if (encodeCursor(cursor) !== value) {
    throw malformed();
  }
  return cursor;
}

/**
 * The format, plus a real calendar instant Postgres will accept: `Date`
 * normalizes Feb 30 or 24:00 into another day, so a round trip through it
 * catches both, and Postgres has no year 0.
 */
function isTimestamp(value: string): boolean {
  if (!TIMESTAMP_RE.test(value) || value.startsWith('0000')) {
    return false;
  }
  const millis = `${value.slice(0, 23)}Z`;
  const date = new Date(millis);
  return !Number.isNaN(date.getTime()) && date.toISOString() === millis;
}

function malformed(): ApiError {
  return ApiError.validation('Request validation failed', [
    { field: 'cursor', messages: ['cursor is malformed; pass a next_cursor value unchanged'] },
  ]);
}
