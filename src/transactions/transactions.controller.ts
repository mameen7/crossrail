import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/api-error.dto';
import { UuidPipe } from '../common/uuid.pipe';
import { ListTransactionsQueryDto, MAX_HISTORY_LIMIT } from './dto/list-transactions-query.dto';
import { TransactionHistoryDto } from './dto/transaction-history.dto';
import { TransactionDto } from './dto/transaction.dto';
import { TransactionsService } from './transactions.service';

/** Read-only: no Idempotency-Key, nothing written. */
@ApiTags('transactions')
@Controller()
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get('wallets/:id/transactions')
  @ApiOperation({
    summary: "List a wallet's transactions, newest first",
    description:
      'Every deposit and swap the wallet owns and every transfer it sent or received. ' +
      'Filters combine; currency matches either side, so a cross-currency transfer is found by ' +
      'what was sent or what was received. Pages are keyset-paginated: pass next_cursor back as ' +
      'cursor until it is null.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TransactionHistoryDto })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto, description: 'WALLET_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description:
      'UNSUPPORTED_CURRENCY: currency is not one of the five stablecoins; ' +
      `VALIDATION_ERROR: id is not a UUID, type is not deposit, swap or transfer, limit is not an integer from 1 to ${MAX_HISTORY_LIMIT}, ` +
      'or cursor is not a next_cursor value this API returned',
  })
  history(
    @Param('id', UuidPipe) id: string,
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionHistoryDto> {
    return this.transactions.history(id, query);
  }

  @Get('transactions/:id')
  @ApiOperation({ summary: 'Get one transaction' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TransactionDto })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto, description: 'TRANSACTION_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR: id is not a UUID',
  })
  get(@Param('id', UuidPipe) id: string): Promise<TransactionDto> {
    return this.transactions.get(id);
  }
}
