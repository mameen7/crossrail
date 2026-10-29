import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, InsertResult } from 'typeorm';
import { ApiError } from '../common/api-error';
import { IdempotencyKey } from './idempotency-key.entity';

/** Identifies one attempted mutation; built by the interceptor from the request. */
export interface IdempotencyRequest {
  readonly key: string;
  /** e.g. `POST /wallets/:id/deposits` */
  readonly endpoint: string;
}

/** What an operation hands back from inside the transaction. */
export interface WorkResult<T> {
  status: number;
  body: T;
  transactionId: string | null;
}

/** What the controller returns; the interceptor turns it into the HTTP response. */
export interface IdempotentResponse<T> {
  status: number;
  body: T;
  /** True when `body` is the stored response of an earlier identical request. */
  replayed: boolean;
}

/**
 * The single entry point for every idempotent mutation (hard rule 3).
 *
 * `execute` owns the database transaction. Its first statement inserts the
 * key row with `ON CONFLICT DO NOTHING`; the operation then runs inside the
 * same transaction and its response is written onto the row before commit, so
 * a key only ever becomes visible together with its effects. A business
 * failure thrown from `work` rolls everything back, key row included, so the
 * key is not consumed: idempotency here is at-most-once success.
 *
 * `requestHash` is the caller's sha256 of its validated input plus path
 * params (see request-hash.ts), so what is compared is what the server would
 * process, not the raw bytes on the wire.
 *
 * There is no in-flight state. A concurrent duplicate blocks inside its
 * INSERT on the first transaction's uncommitted row until that transaction
 * ends, then either sees the committed row (replay) or, after a rollback,
 * inserts its own and proceeds.
 */
@Injectable()
export class IdempotencyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  execute<T extends object>(
    request: IdempotencyRequest,
    requestHash: string,
    work: (em: EntityManager) => Promise<WorkResult<T>>,
  ): Promise<IdempotentResponse<T>> {
    const { key, endpoint } = request;
    return this.dataSource.transaction(async (em) => {
      const inserted = await em
        .createQueryBuilder()
        .insert()
        .into(IdempotencyKey)
        .values({ key, endpoint, requestHash })
        .orIgnore()
        .returning('key')
        .updateEntity(false)
        .execute();

      if (insertedRowCount(inserted) === 0) {
        const existing = await em.findOneBy(IdempotencyKey, { key, endpoint });
        return replay<T>(existing, request, requestHash);
      }

      const result = await work(em);
      await em.update(
        IdempotencyKey,
        { key, endpoint },
        {
          responseStatus: result.status,
          responseBody: result.body,
          transactionId: result.transactionId,
        },
      );
      return { status: result.status, body: result.body, replayed: false };
    });
  }
}

/** With `RETURNING`, pg hands back one row per inserted row and none on conflict. */
function insertedRowCount(result: InsertResult): number {
  const rows: unknown = result.raw;
  if (!Array.isArray(rows)) {
    throw new Error('Expected the idempotency INSERT ... RETURNING to yield a row array');
  }
  return rows.length;
}

function replay<T extends object>(
  existing: IdempotencyKey | null,
  { key, endpoint }: IdempotencyRequest,
  requestHash: string,
): IdempotentResponse<T> {
  if (existing === null) {
    // The INSERT conflicted with a row this statement cannot see: not possible
    // under READ COMMITTED once the conflicting transaction has ended.
    throw new Error(`Idempotency row ${endpoint} ${key} conflicted but cannot be read`);
  }
  if (existing.requestHash !== requestHash) {
    throw ApiError.idempotencyKeyReused(key, endpoint);
  }
  if (existing.responseStatus === null || existing.responseBody === null) {
    // Rows are only ever committed with their response, so this is corruption.
    throw new Error(`Idempotency row ${endpoint} ${key} has no stored response`);
  }
  return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
}
