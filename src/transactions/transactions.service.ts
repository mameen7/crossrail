import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ApiError } from '../common/api-error';
import { Currency } from '../common/currency';
import { requireCurrency } from '../common/require-currency';
import { WalletsService } from '../wallets/wallets.service';
import { DEFAULT_HISTORY_LIMIT, ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { TransactionHistoryDto } from './dto/transaction-history.dto';
import { TransactionDto } from './dto/transaction.dto';
import { CURSOR_TS_SQL, decodeCursor, encodeCursor, HistoryCursor } from './history-cursor';
import { Transaction, TransactionType } from './transaction.entity';
import { toTransactionDto } from './transaction.mapper';

/**
 * One branch per way a wallet takes part in a transaction, each walking its
 * own (column, created_at DESC) index. Later branches exclude rows an earlier
 * branch already matches, so the branches are disjoint by construction rather
 * than by the application rules that keep them so today (deposits and swaps
 * set only `wallet_id`; transfers only sender and receiver, which differ):
 * a row breaking those rules still appears once, not twice.
 */
const BRANCHES = [
  'wallet_id = $1',
  'sender_wallet_id = $1 AND wallet_id IS DISTINCT FROM $1',
  'receiver_wallet_id = $1 AND sender_wallet_id IS DISTINCT FROM $1 AND wallet_id IS DISTINCT FROM $1',
] as const;

/** The page's keys in order; the rows themselves are loaded through the entity. */
interface PageKey {
  id: string;
  cursor_ts: string;
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Transaction) private readonly transactions: Repository<Transaction>,
    private readonly wallets: WalletsService,
  ) {}

  async get(id: string): Promise<TransactionDto> {
    const tx = await this.transactions.findOneBy({ id });
    if (tx === null) {
      throw ApiError.transactionNotFound(id);
    }
    return toTransactionDto(tx);
  }

  /**
   * One page of every transaction the wallet owns, sent or received, newest
   * first, ordered by `(created_at DESC, id DESC)` so rows sharing a
   * timestamp still have one total order and keyset pages never skip or
   * repeat a row.
   *
   * Request validation (currency, cursor) comes before the wallet lookup, as
   * on every other endpoint. The wallet is only looked up when the page is
   * empty: any row already proves it exists.
   */
  async history(walletId: string, query: ListTransactionsQueryDto): Promise<TransactionHistoryDto> {
    const currency =
      query.currency === undefined ? undefined : requireCurrency(query.currency, 'currency');
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;

    const keys = await this.pageKeys(walletId, query.type, currency, cursor, limit + 1);
    if (keys.length === 0) {
      await this.wallets.assertExists(walletId);
      return { items: [], next_cursor: null };
    }

    const kept = keys.slice(0, limit);
    const rows = await this.transactions.findBy({ id: In(kept.map((k) => k.id)) });
    const byId = new Map(rows.map((tx) => [tx.id, tx]));
    const items = kept.map(({ id }) => {
      const tx = byId.get(id);
      if (tx === undefined) {
        // Transactions are never deleted, so a key without its row is an integrity failure.
        throw new Error(`Transaction ${id} vanished between history queries`);
      }
      return toTransactionDto(tx);
    });

    const last = kept[kept.length - 1];
    return {
      items,
      next_cursor:
        keys.length > limit && last !== undefined
          ? encodeCursor({ createdAt: last.cursor_ts, id: last.id })
          : null,
    };
  }

  /**
   * The ids of up to `take` rows from the cursor down, with the cursor
   * timestamp of each. Each branch stops after `take` rows of its index; the
   * outer sort merges at most `3 × take` and formats timestamps only for the
   * rows it keeps. An OR across the three columns would instead collect every
   * matching row of the wallet and sort them all for each page. Fetching one
   * row more than the page says whether another page exists without a count.
   */
  private pageKeys(
    walletId: string,
    type: TransactionType | undefined,
    currency: Currency | undefined,
    cursor: HistoryCursor | undefined,
    take: number,
  ): Promise<PageKey[]> {
    const params: unknown[] = [walletId];
    const param = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const filters: string[] = [];
    if (type !== undefined) {
      filters.push(`type = ${param(type)}`);
    }
    if (currency !== undefined) {
      const p = param(currency);
      filters.push(`(source_currency = ${p} OR destination_currency = ${p})`);
    }
    if (cursor !== undefined) {
      // Equivalent to (created_at, id) < (ts, id), spelled so that
      // `created_at <= ts` alone is an index condition on every branch.
      const ts = `${param(cursor.createdAt)}::timestamptz`;
      const id = `${param(cursor.id)}::uuid`;
      filters.push(`created_at <= ${ts} AND (created_at < ${ts} OR id < ${id})`);
    }
    const limit = param(take);

    const branches = BRANCHES.map(
      (party) => `(
        SELECT id, created_at
          FROM transactions
         WHERE ${[party, ...filters].join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit}
      )`,
    );
    return this.dataSource.query<PageKey[]>(
      `SELECT id, ${CURSOR_TS_SQL} AS cursor_ts
         FROM (${branches.join(' UNION ALL ')}) history
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}`,
      params,
    );
  }
}
