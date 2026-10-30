import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Currency } from '../common/currency';
import { numericString } from '../common/numeric-string.transformer';
import { Transaction } from './transaction.entity';

/**
 * Signed append-only rows: negative is a debit, positive a credit.
 * Invariant: SUM(amount) per (wallet, currency) equals `balances.amount`.
 */
@Entity({ name: 'ledger_entries' })
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ type: 'text' })
  currency!: Currency;

  @Column({ type: 'numeric', precision: 38, scale: 8, transformer: numericString })
  amount!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @ManyToOne(() => Transaction)
  @JoinColumn({ name: 'transaction_id', foreignKeyConstraintName: 'FK_ledger_entries_transaction' })
  transaction?: Transaction;
}
