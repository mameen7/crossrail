import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { parseAmount, toAmountString } from '../common/money';
import { requireCurrency } from '../common/require-currency';
import { assertNonZeroDestination, convert } from '../fx/pricing';
import { RatesSource } from '../fx/rates-source';
import {
  IdempotencyRequest,
  IdempotencyService,
  IdempotentResponse,
} from '../idempotency/idempotency.service';
import { hashRequest } from '../idempotency/request-hash';
import { TransactionDto } from '../transactions/dto/transaction.dto';
import { LedgerService } from '../transactions/ledger.service';
import { recordTransaction } from '../transactions/record-transaction';
import { CreateSwapDto } from './dto/create-swap.dto';

@Injectable()
export class SwapsService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    private readonly rates: RatesSource,
  ) {}

  /**
   * Swap inside one wallet: one debit in `from_currency`, one credit in
   * `to_currency`, priced from a single rate snapshot.
   *
   * Order of operations: validate (both currencies supported, from != to;
   * the amount's format and positivity are the DTO's job) → take the rate
   * snapshot → quantize the cross rate to 18 dp → derive the destination as
   * round_down(source × that stored rate, 8 dp) → open the idempotent
   * transaction. The snapshot is taken before the transaction opens, so no
   * network or FX I/O ever runs while balance rows are locked, and the rate
   * computed here is exactly the rate stored and returned.
   *
   * The zero-destination check (422 AMOUNT_TOO_SMALL) is the one pre-check
   * that depends on external state, the current rate, so it runs inside the
   * transaction after the key insert: a replay of a committed swap must win
   * over it, or a retry could report failure for a swap whose balance change
   * is already durable. A fresh key that fails it rolls the key row back.
   *
   * The request hash covers the validated DTO and the lowercased wallet id,
   * not the rate: a retry replays the transaction as it was priced. An
   * unknown wallet (404) and insufficient funds (422) both surface from the
   * ledger inside the transaction, so the key row rolls back with them and
   * the key stays usable for a later retry.
   */
  async swap(
    request: IdempotencyRequest,
    walletId: string,
    input: CreateSwapDto,
  ): Promise<IdempotentResponse<TransactionDto>> {
    const from = requireCurrency(input.from_currency, 'from_currency');
    const to = requireCurrency(input.to_currency, 'to_currency');
    if (from === to) {
      throw ApiError.sameCurrencySwap(from);
    }
    const source = parseAmount(input.amount); // format and > 0 already validated by the DTO
    const sourceString = toAmountString(source);

    const snapshot = await this.rates.getSnapshot();
    const conversion = convert(source, from, to, snapshot);
    const { fxRate, destination } = conversion;
    const requestHash = hashRequest(input, { id: walletId });

    return await recordTransaction(this.idempotency, this.ledger, request, requestHash, () => {
      // Only reached on a fresh key; a stored response has already been returned.
      assertNonZeroDestination(source, from, to, conversion);
      return {
        draft: {
          type: 'swap',
          walletId,
          senderWalletId: null,
          receiverWalletId: null,
          sourceCurrency: from,
          sourceAmount: sourceString,
          destinationCurrency: to,
          destinationAmount: toAmountString(destination),
          fxRate,
          rateSource: snapshot.source,
        },
        entries: [
          { walletId, currency: from, amount: source.negated() },
          { walletId, currency: to, amount: destination },
        ],
      };
    });
  }
}
