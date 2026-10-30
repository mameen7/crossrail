import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ApiError } from '../common/api-error';
import { Currency } from '../common/currency';
import { parseAmount, toAmountString, UNIT_RATE } from '../common/money';
import { requireCurrency } from '../common/require-currency';
import { assertNonZeroDestination, Conversion, convert } from '../fx/pricing';
import { RateSource } from '../fx/rate-source';
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
import { CreateTransferDto } from './dto/create-transfer.dto';

interface Pricing extends Conversion {
  readonly rateSource: RateSource;
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    private readonly rates: RatesSource,
  ) {}

  /**
   * Wallet-to-wallet send: one debit on the sender in `source_currency`, one
   * credit on the receiver in `destination_currency` (default: the source
   * currency), booked by a single ledger call.
   *
   * Order of operations: validate (both currencies supported, sender !=
   * receiver on the lowercased ids; the ids' UUID format and the amount's
   * format and positivity are the DTO's job) → price → open the idempotent
   * transaction. A same-currency transfer takes no rate snapshot: it moves
   * the amount unchanged at rate 1 from source `none`, so it never waits on
   * the FX chain. A cross-currency one follows the swap exactly, through the
   * same `convert`: snapshot before the transaction, cross rate quantized to
   * 18 dp, destination derived from that stored rate, and the zero check
   * inside the transaction after the key insert, so a replay of a committed
   * transfer wins over today's rate.
   *
   * Both balance rows are locked by the ledger in its global (wallet_id,
   * currency) order, which is what keeps crossing transfers (A to B and B to
   * A at once) deadlock-free. An unknown sender or receiver is the ledger's
   * 404 naming the wallet whose row was missing, and insufficient funds its
   * 422; both roll the key row back.
   *
   * There are no path params, so the hash covers the DTO alone. Two fields
   * are normalized before hashing: the wallet ids are lowercased (by the
   * DTO) and `destination_currency` is filled in, so omitting it and sending
   * the source currency explicitly are the same request. `source_amount` is
   * hashed as sent, as amounts are on every endpoint: "10" and "10.00" are
   * different requests.
   */
  async transfer(
    request: IdempotencyRequest,
    input: CreateTransferDto,
  ): Promise<IdempotentResponse<TransactionDto>> {
    const from = requireCurrency(input.source_currency, 'source_currency');
    const to = requireCurrency(
      input.destination_currency ?? input.source_currency,
      'destination_currency',
    );
    const sender = input.sender_wallet_id; // lowercased by the DTO
    const receiver = input.receiver_wallet_id;
    if (sender === receiver) {
      throw ApiError.selfTransfer(sender);
    }
    const source = parseAmount(input.source_amount); // format and > 0 already validated by the DTO

    const pricing = await this.price(source, from, to);
    const requestHash = hashRequest({ ...input, destination_currency: to }, {});

    return await recordTransaction(this.idempotency, this.ledger, request, requestHash, () => {
      // Only reached on a fresh key; a stored response has already been returned.
      assertNonZeroDestination(source, from, to, pricing);
      return {
        draft: {
          type: 'transfer',
          walletId: null,
          senderWalletId: sender,
          receiverWalletId: receiver,
          sourceCurrency: from,
          sourceAmount: toAmountString(source),
          destinationCurrency: to,
          destinationAmount: toAmountString(pricing.destination),
          fxRate: pricing.fxRate,
          rateSource: pricing.rateSource,
        },
        entries: [
          { walletId: sender, currency: from, amount: source.negated() },
          { walletId: receiver, currency: to, amount: pricing.destination },
        ],
      };
    });
  }

  private async price(source: Decimal, from: Currency, to: Currency): Promise<Pricing> {
    if (from === to) {
      return { fxRate: UNIT_RATE, destination: source, rateSource: 'none' };
    }
    const snapshot = await this.rates.getSnapshot();
    return { ...convert(source, from, to, snapshot), rateSource: snapshot.source };
  }
}
