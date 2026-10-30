import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { CURRENCIES } from '../../common/currency';
import { TRANSACTION_TYPES, TransactionType } from '../transaction.entity';

export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

/**
 * Query strings arrive as strings and implicit conversion is off globally, so
 * `limit` is converted here, and only when it is all digits: `'abc'`, `'1.5'`
 * or `'-1'` stay strings and fail `@IsInt`. `limit` is a page size, not an
 * amount, so a JS number is the right type for it.
 */
const toPageSize = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;

export class ListTransactionsQueryDto {
  @ApiPropertyOptional({ enum: TRANSACTION_TYPES, description: 'Only transactions of this type' })
  @IsOptional()
  @IsIn(TRANSACTION_TYPES)
  type?: TransactionType;

  @ApiPropertyOptional({
    enum: CURRENCIES,
    description:
      'Only transactions whose source or destination currency is this one; anything but a supported stablecoin is 422 UNSUPPORTED_CURRENCY',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  currency?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_HISTORY_LIMIT,
    default: DEFAULT_HISTORY_LIMIT,
    description: 'Page size',
  })
  @IsOptional()
  @Transform(toPageSize)
  @IsInt()
  @Min(1)
  @Max(MAX_HISTORY_LIMIT)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Opaque position to continue from: the next_cursor of the previous page, passed unchanged. Omit for the first page',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cursor?: string;
}
