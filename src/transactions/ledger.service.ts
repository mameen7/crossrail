import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { ApiError } from '../common/api-error';
import { Currency } from '../common/currency';
import { parseAmount, toAmountString, toLedgerAmountString } from '../common/money';
import { Balance } from '../wallets/balance.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { Transaction } from './transaction.entity';

/** A signed delta on one (wallet, currency): negative debits, positive credits. */
export interface LedgerEntryDraft {
  readonly walletId: string;
  readonly currency: Currency;
  readonly amount: Decimal;
}

/** Everything about a transaction except what the database generates. */
export type TransactionDraft = Pick<
  Transaction,
  | 'type'
  | 'walletId'
  | 'senderWalletId'
  | 'receiverWalletId'
  | 'sourceCurrency'
  | 'sourceAmount'
  | 'destinationCurrency'
  | 'destinationAmount'
  | 'fxRate'
  | 'rateSource'
>;

interface BalanceKey {
  readonly walletId: string;
  readonly currency: Currency;
}

interface LockedBalance extends BalanceKey {
  readonly current: Decimal;
  readonly delta: Decimal;
}

/**
 * The one place balances change (hard rules 2 and 4). Every mutation, whatever
 * its type, is a transaction row plus signed ledger entries whose per-(wallet,
 * currency) sums are applied to `balances`:
 *
 * 1. validate: every entry is non-zero and at most 8 dp, and is rendered to
 *    its ledger string once; deltas are summed per row and the rows are put
 *    in one global order;
 * 2. lock: each row is read with `SELECT ... FOR UPDATE` in that order, so two
 *    operations touching the same rows can never deadlock. A missing row is
 *    404 `WALLET_NOT_FOUND`: wallet creation inserts all five rows atomically
 *    and nothing deletes them, so no row means no wallet;
 * 3. verify: no row may go negative (422 `INSUFFICIENT_FUNDS`), checked before
 *    anything is written;
 * 4. apply: balances are updated, the transaction row is inserted, then its
 *    ledger entries.
 *
 * The caller owns the transaction: `em` must come from `dataSource.transaction`
 * (in practice from `IdempotencyService.execute`), so a failure anywhere rolls
 * back the balances, the transaction row, the ledger entries and the
 * idempotency key together. A deposit is the degenerate case: one credit.
 */
@Injectable()
export class LedgerService {
  async apply(
    em: EntityManager,
    draft: TransactionDraft,
    entries: readonly LedgerEntryDraft[],
  ): Promise<Transaction> {
    const rows = entries.map((entry) => ({
      walletId: entry.walletId,
      currency: entry.currency,
      amount: toLedgerAmountString(entry.amount), // throws on zero or more than 8 dp
    }));
    const deltas = sumDeltas(entries);

    const locked: LockedBalance[] = [];
    for (const [key, delta] of deltas) {
      const row = await em.findOne(Balance, {
        where: { walletId: key.walletId, currency: key.currency },
        lock: { mode: 'pessimistic_write' },
      });
      if (row === null) {
        throw ApiError.walletNotFound(key.walletId);
      }
      locked.push({ ...key, current: parseAmount(row.amount), delta });
    }

    for (const { walletId, currency, current, delta } of locked) {
      if (current.plus(delta).isNegative()) {
        throw ApiError.insufficientFunds(
          walletId,
          currency,
          toAmountString(current),
          toAmountString(delta.abs()),
        );
      }
    }

    for (const { walletId, currency, current, delta } of locked) {
      await em.update(
        Balance,
        { walletId, currency },
        { amount: toAmountString(current.plus(delta)), updatedAt: () => 'now()' },
      );
    }

    const tx = await em.save(em.create(Transaction, { ...draft, status: 'completed' }));
    await em.insert(
      LedgerEntry,
      rows.map((row) => ({ ...row, transactionId: tx.id })),
    );
    return tx;
  }
}

/**
 * Sums deltas per (wallet, currency) and returns them in the global lock
 * order: by wallet id, then currency, compared byte-wise so the order is the
 * same in every process and locale.
 */
export function sumDeltas(entries: readonly LedgerEntryDraft[]): [BalanceKey, Decimal][] {
  if (entries.length === 0) {
    throw new Error('A transaction must write at least one ledger entry');
  }
  const byKey = new Map<string, [BalanceKey, Decimal]>();
  for (const entry of entries) {
    const id = `${entry.walletId}\u0000${entry.currency}`;
    const current = byKey.get(id);
    if (current === undefined) {
      byKey.set(id, [{ walletId: entry.walletId, currency: entry.currency }, entry.amount]);
    } else {
      current[1] = current[1].plus(entry.amount);
    }
  }
  return [...byKey.values()].sort(([a], [b]) => compareKeys(a, b));
}

function compareKeys(a: BalanceKey, b: BalanceKey): number {
  if (a.walletId !== b.walletId) {
    return a.walletId < b.walletId ? -1 : 1;
  }
  if (a.currency !== b.currency) {
    return a.currency < b.currency ? -1 : 1;
  }
  return 0;
}
