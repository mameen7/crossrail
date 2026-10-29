import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/api-error.dto';
import { UuidPipe } from '../common/uuid.pipe';
import { IdempotencyReq } from '../idempotency/idempotency.interceptor';
import { IdempotencyRequest, IdempotentResponse } from '../idempotency/idempotency.service';
import {
  IDEMPOTENCY_422_CODES,
  IDEMPOTENT_RESPONSE_HEADERS,
  Idempotent,
} from '../idempotency/idempotent.decorator';
import { TransactionDto } from '../transactions/dto/transaction.dto';
import { CreateSwapDto } from './dto/create-swap.dto';
import { SwapsService } from './swaps.service';

@ApiTags('swaps')
@Controller('wallets/:id/swaps')
export class SwapsController {
  constructor(private readonly swaps: SwapsService) {}

  // No @HttpCode: the idempotency interceptor sets the status from the
  // IdempotentResponse, fresh or replayed, so it is decided in one place.
  @Post()
  @Idempotent('POST /wallets/:id/swaps')
  @ApiOperation({
    summary: 'Swap between two currencies inside one wallet',
    description:
      'Debits from_currency and credits to_currency at the current cross rate, quantized to 18 dp and ' +
      'stored as fx_rate; the credited amount is round_down(amount × fx_rate, 8 dp). Records one swap ' +
      'transaction with two ledger entries. Requires an Idempotency-Key; the same key and body returns ' +
      'the original transaction at the rate it was priced.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({
    type: TransactionDto,
    description: 'The swap transaction; replayed for a repeated key and body',
    headers: IDEMPOTENT_RESPONSE_HEADERS,
  })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto, description: 'WALLET_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description:
      'UNSUPPORTED_CURRENCY: from_currency or to_currency is not one of the five stablecoins; ' +
      'SAME_CURRENCY_SWAP: from_currency equals to_currency; ' +
      'AMOUNT_TOO_SMALL: the converted amount rounds to zero at 8 dp; ' +
      'INSUFFICIENT_FUNDS: the from_currency balance is below amount; ' +
      'VALIDATION_ERROR: id is not a UUID, a currency is missing, or amount is not a positive decimal string with at most 8 dp; ' +
      IDEMPOTENCY_422_CODES,
  })
  swap(
    @Param('id', UuidPipe) id: string,
    @Body() body: CreateSwapDto,
    @IdempotencyReq() request: IdempotencyRequest,
  ): Promise<IdempotentResponse<TransactionDto>> {
    return this.swaps.swap(request, id, body);
  }
}
