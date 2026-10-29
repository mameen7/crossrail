import { ApiProperty } from '@nestjs/swagger';
import { CURRENCIES, Currency } from '../../common/currency';
import { RATE_SOURCES, RateSource } from '../../fx/rate-source';
import { TRANSACTION_TYPES, TransactionType } from '../transaction.entity';

/** One side of a transaction: where the money came from or went to. */
export class TransactionLegDto {
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    example: '7f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
    description: 'Null on the source side of a deposit (money enters from outside)',
  })
  wallet_id!: string | null;

  @ApiProperty({ enum: CURRENCIES, example: 'cNGN' })
  currency!: Currency;

  @ApiProperty({ example: '150000.00000000', description: 'Decimal string, always 8 dp' })
  amount!: string;
}

/**
 * The canonical transaction shape, returned by every endpoint that produces
 * or reads a transaction. Deposits have `source.wallet_id: null`; swaps carry
 * the same wallet on both sides; transfers carry two different wallets.
 */
export class TransactionDto {
  @ApiProperty({ format: 'uuid', example: 'c91d4f2a-8b3e-4d1c-9f6a-2e7b5c8d9a0f' })
  id!: string;

  @ApiProperty({ enum: TRANSACTION_TYPES, example: 'deposit' })
  type!: TransactionType;

  @ApiProperty({ example: 'completed' })
  status!: string;

  @ApiProperty({ type: TransactionLegDto })
  source!: TransactionLegDto;

  @ApiProperty({ type: TransactionLegDto })
  destination!: TransactionLegDto;

  @ApiProperty({
    example: '1.000000000000000000',
    description:
      'Units of destination currency per 1 unit of source currency, decimal string, always 18 dp; 1 for same-currency operations',
  })
  fx_rate!: string;

  @ApiProperty({
    enum: RATE_SOURCES,
    example: 'none',
    description: 'Which FX tier priced the transaction; `none` for same-currency operations',
  })
  rate_source!: RateSource;

  @ApiProperty({ example: '2026-10-29T12:00:00.000Z' })
  created_at!: string;
}
