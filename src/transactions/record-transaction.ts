import { HttpStatus } from '@nestjs/common';
import {
  IdempotencyRequest,
  IdempotencyService,
  IdempotentResponse,
} from '../idempotency/idempotency.service';
import { TransactionDto } from './dto/transaction.dto';
import { LedgerEntryDraft, LedgerService, TransactionDraft } from './ledger.service';
import { toTransactionDto } from './transaction.mapper';

/** What one operation books: its transaction row and the signed entries behind it. */
export interface LedgerPosting {
  readonly draft: TransactionDraft;
  readonly entries: readonly LedgerEntryDraft[];
}

/**
 * The shared tail of every balance-moving endpoint (deposits, swaps,
 * transfers): open the idempotent transaction, book the posting through the
 * ledger, and answer 201 with the canonical DTO, which is also what the key
 * row stores for replays.
 *
 * `prepare` runs inside the transaction, after the key insert, and only on a
 * fresh key: a replay returns the stored response without calling it. That
 * is where checks belong that must lose to a replay, such as the zero
 * destination of a conversion priced at today's rate; anything it throws
 * rolls the key row back with the rest.
 */
export function recordTransaction(
  idempotency: IdempotencyService,
  ledger: LedgerService,
  request: IdempotencyRequest,
  requestHash: string,
  prepare: () => LedgerPosting,
): Promise<IdempotentResponse<TransactionDto>> {
  return idempotency.execute(request, requestHash, async (em) => {
    const { draft, entries } = prepare();
    const tx = await ledger.apply(em, draft, entries);
    return { status: HttpStatus.CREATED, body: toTransactionDto(tx), transactionId: tx.id };
  });
}
