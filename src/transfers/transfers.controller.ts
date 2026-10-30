import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/api-error.dto';
import { AMOUNT_TOO_SMALL_422 } from '../fx/pricing';
import { IdempotencyReq } from '../idempotency/idempotency.interceptor';
import { IdempotencyRequest, IdempotentResponse } from '../idempotency/idempotency.service';
import {
  IDEMPOTENCY_422_CODES,
  IDEMPOTENT_RESPONSE_HEADERS,
  Idempotent,
} from '../idempotency/idempotent.decorator';
import { TransactionDto } from '../transactions/dto/transaction.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransfersService } from './transfers.service';

@ApiTags('transfers')
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  // No @HttpCode: the idempotency interceptor sets the status from the
  // IdempotentResponse, fresh or replayed, so it is decided in one place.
  @Post()
  @Idempotent('POST /transfers')
  @ApiOperation({
    summary: 'Send from one wallet to another, converting when the currencies differ',
    description:
      'Debits source_amount of source_currency from the sender and credits the receiver in ' +
      'destination_currency (default: source_currency). Same-currency transfers move the amount ' +
      'unchanged at fx_rate 1 with rate_source "none"; otherwise the current cross rate is quantized ' +
      'to 18 dp and stored as fx_rate, and the credited amount is round_down(source_amount × fx_rate, 8 dp). ' +
      'Records one transfer transaction with a ledger entry on each wallet. Requires an ' +
      'Idempotency-Key; the same key and body returns the original transaction at the rate it was priced.',
  })
  @ApiCreatedResponse({
    type: TransactionDto,
    description: 'The transfer transaction; replayed for a repeated key and body',
    headers: IDEMPOTENT_RESPONSE_HEADERS,
  })
  @ApiNotFoundResponse({
    type: ApiErrorResponseDto,
    description:
      'WALLET_NOT_FOUND: the sender or the receiver does not exist (details.id names it)',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description:
      'UNSUPPORTED_CURRENCY: source_currency or destination_currency is not one of the five stablecoins; ' +
      'SELF_TRANSFER: sender_wallet_id equals receiver_wallet_id; ' +
      AMOUNT_TOO_SMALL_422 +
      "INSUFFICIENT_FUNDS: the sender's source_currency balance is below source_amount; " +
      'VALIDATION_ERROR: a wallet id is missing or not a UUID; source_currency is missing, empty or not a string; ' +
      'destination_currency is present but empty or not a string; or source_amount is not a positive decimal string ' +
      'with at most 20 integer digits and 8 dp; ' +
      IDEMPOTENCY_422_CODES,
  })
  transfer(
    @Body() body: CreateTransferDto,
    @IdempotencyReq() request: IdempotencyRequest,
  ): Promise<IdempotentResponse<TransactionDto>> {
    return this.transfers.transfer(request, body);
  }
}
