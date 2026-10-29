import { HttpStatus, Injectable } from '@nestjs/common';
import { parseAmount, toAmountString } from '../common/money';
import { requireCurrency } from '../common/require-currency';
import {
  IdempotencyRequest,
  IdempotencyService,
  IdempotentResponse,
} from '../idempotency/idempotency.service';
import { hashRequest } from '../idempotency/request-hash';
import { TransactionDto } from '../transactions/dto/transaction.dto';
import { LedgerService } from '../transactions/ledger.service';
import { toTransactionDto } from '../transactions/transaction.mapper';
import { CreateDepositDto } from './dto/create-deposit.dto';

@Injectable()
export class DepositsService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Simulated deposit: one credit, no debit, rate 1 from no FX source. The
   * request hash covers the validated DTO (unknown properties already
   * stripped) and the lowercased wallet id. An unknown wallet surfaces from
   * the ledger's row lock as 404 inside the transaction, so the key row rolls
   * back and the key stays usable.
   */
  async deposit(
    request: IdempotencyRequest,
    walletId: string,
    input: CreateDepositDto,
  ): Promise<IdempotentResponse<TransactionDto>> {
    const currency = requireCurrency(input.currency, 'currency');
    const amount = parseAmount(input.amount); // format and > 0 already validated by the DTO
    const amountString = toAmountString(amount);
    const requestHash = hashRequest(input, { id: walletId });

    return await this.idempotency.execute(request, requestHash, async (em) => {
      const tx = await this.ledger.apply(
        em,
        {
          type: 'deposit',
          walletId,
          senderWalletId: null,
          receiverWalletId: null,
          sourceCurrency: currency,
          sourceAmount: amountString,
          destinationCurrency: currency,
          destinationAmount: amountString,
          fxRate: '1',
          rateSource: 'none',
        },
        [{ walletId, currency, amount }],
      );

      return { status: HttpStatus.CREATED, body: toTransactionDto(tx), transactionId: tx.id };
    });
  }
}
