import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Currency, sqlStringList } from '../common/currency';
import { numericString } from '../common/numeric-string.transformer';
import { RateSource } from '../fx/rate-source';

export const TRANSACTION_TYPES = ['deposit', 'swap', 'transfer'] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

const TRANSACTION_TYPE_SQL_LIST = sqlStringList(TRANSACTION_TYPES);

/**
 * One row per business operation. Deposits and swaps set `walletId`;
 * transfers set `senderWalletId` and `receiverWalletId` instead.
 *
 * The three (wallet, created_at DESC) indexes back newest-first history
 * reads; the migration declares them with explicit DESC ordering.
 */
@Entity({ name: 'transactions' })
@Index('IDX_transactions_wallet_created', ['walletId', 'createdAt'])
@Index('IDX_transactions_sender_created', ['senderWalletId', 'createdAt'])
@Index('IDX_transactions_receiver_created', ['receiverWalletId', 'createdAt'])
@Check('CHK_transactions_type', `"type" IN (${TRANSACTION_TYPE_SQL_LIST})`)
@Check('CHK_transactions_source_amount_positive', '"source_amount" > 0')
@Check('CHK_transactions_destination_amount_positive', '"destination_amount" > 0')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  type!: TransactionType;

  /** Everything is synchronous today; kept for extensibility. */
  @Column({ type: 'text', default: 'completed' })
  status!: string;

  /** Owner for deposit and swap; null for transfers. */
  @Column({ name: 'wallet_id', type: 'uuid', nullable: true })
  walletId!: string | null;

  @Column({ name: 'sender_wallet_id', type: 'uuid', nullable: true })
  senderWalletId!: string | null;

  @Column({ name: 'receiver_wallet_id', type: 'uuid', nullable: true })
  receiverWalletId!: string | null;

  @Column({ name: 'source_currency', type: 'text' })
  sourceCurrency!: Currency;

  @Column({
    name: 'source_amount',
    type: 'numeric',
    precision: 38,
    scale: 8,
    transformer: numericString,
  })
  sourceAmount!: string;

  @Column({ name: 'destination_currency', type: 'text' })
  destinationCurrency!: Currency;

  @Column({
    name: 'destination_amount',
    type: 'numeric',
    precision: 38,
    scale: 8,
    transformer: numericString,
  })
  destinationAmount!: string;

  /** Quantized to 18 dp; `1` for same-currency operations. */
  @Column({
    name: 'fx_rate',
    type: 'numeric',
    precision: 38,
    scale: 18,
    transformer: numericString,
  })
  fxRate!: string;

  @Column({ name: 'rate_source', type: 'text' })
  rateSource!: RateSource;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
