import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per attempted mutation, keyed by (key, endpoint). Inserted as the
 * first statement of the operation's transaction and completed with the
 * response at the end, so it commits or rolls back with its effects.
 */
@Entity({ name: 'idempotency_keys' })
export class IdempotencyKey {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  /** e.g. `POST /wallets/:id/swaps` */
  @PrimaryColumn({ type: 'text' })
  endpoint!: string;

  /** sha256 of canonical JSON body plus path params. */
  @Column({ name: 'request_hash', type: 'text' })
  requestHash!: string;

  @Column({ name: 'response_status', type: 'int', nullable: true })
  responseStatus!: number | null;

  /** The response DTO as stored; NULL only while the inserting transaction is open. */
  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody!: object | null;

  @Column({ name: 'transaction_id', type: 'uuid', nullable: true })
  transactionId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
