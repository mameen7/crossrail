import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Currency, CURRENCY_SQL_LIST } from '../common/currency';
import { numericString } from '../common/numeric-string.transformer';
import { Wallet } from './wallet.entity';

/**
 * One row per (wallet, currency): the lockable, fast-read projection of the
 * ledger. `CHECK (amount >= 0)` is the database-level backstop against
 * overdraft; correct application code never triggers it.
 */
@Entity({ name: 'balances' })
@Check('CHK_balances_currency', `"currency" IN (${CURRENCY_SQL_LIST})`)
@Check('CHK_balances_amount_non_negative', '"amount" >= 0')
export class Balance {
  @PrimaryColumn({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @PrimaryColumn({ type: 'text' })
  currency!: Currency;

  @Column({
    type: 'numeric',
    precision: 38,
    scale: 8,
    default: '0',
    transformer: numericString,
  })
  amount!: string;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @ManyToOne(() => Wallet)
  @JoinColumn({ name: 'wallet_id', foreignKeyConstraintName: 'FK_balances_wallet' })
  wallet?: Wallet;
}
