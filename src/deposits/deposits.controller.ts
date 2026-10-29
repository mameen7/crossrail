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
import { DepositsService } from './deposits.service';
import { CreateDepositDto } from './dto/create-deposit.dto';

@ApiTags('deposits')
@Controller('wallets/:id/deposits')
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  // No @HttpCode: the idempotency interceptor sets the status from the
  // IdempotentResponse, fresh or replayed, so it is decided in one place.
  @Post()
  @Idempotent('POST /wallets/:id/deposits')
  @ApiOperation({
    summary: 'Deposit simulated stablecoins into a wallet',
    description:
      'Credits the balance and records a deposit transaction with one ledger entry. ' +
      'Requires an Idempotency-Key; the same key and body returns the original transaction.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({
    type: TransactionDto,
    description: 'The deposit transaction; replayed for a repeated key and body',
    headers: IDEMPOTENT_RESPONSE_HEADERS,
  })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto, description: 'WALLET_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description:
      'UNSUPPORTED_CURRENCY: currency is not one of the five stablecoins; ' +
      'VALIDATION_ERROR: id is not a UUID, currency missing, or amount not a positive decimal string with at most 8 dp; ' +
      IDEMPOTENCY_422_CODES,
  })
  deposit(
    @Param('id', UuidPipe) id: string,
    @Body() body: CreateDepositDto,
    @IdempotencyReq() request: IdempotencyRequest,
  ): Promise<IdempotentResponse<TransactionDto>> {
    return this.deposits.deposit(request, id, body);
  }
}
