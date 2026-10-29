import { ApiProperty } from '@nestjs/swagger';
import { RATE_SOURCES, RateSource } from '../../fx/rate-source';

export class WalletDto {
  @ApiProperty({ format: 'uuid', example: '7f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f' })
  id!: string;

  @ApiProperty({ nullable: true, type: String, example: 'ada@example.com' })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '+2348000000000' })
  phone!: string | null;

  @ApiProperty({ example: '2026-10-29T12:00:00.000Z' })
  created_at!: string;
}

const AMOUNT = { example: '0.00000000', description: 'Decimal string, always 8 dp' };

export class BalancesDto {
  @ApiProperty(AMOUNT) cNGN!: string;
  @ApiProperty(AMOUNT) cGHS!: string;
  @ApiProperty(AMOUNT) cXAF!: string;
  @ApiProperty(AMOUNT) USDx!: string;
  @ApiProperty(AMOUNT) EURx!: string;
}

export class WalletBalancesDto extends WalletDto {
  @ApiProperty({ type: BalancesDto })
  balances!: BalancesDto;

  @ApiProperty({
    example: '0.00000000',
    description: 'Sum of all balances priced in USD at the current rate snapshot, 8 dp',
  })
  total_usd_equivalent!: string;

  @ApiProperty({ enum: RATE_SOURCES, example: 'fallback' })
  rate_source!: RateSource;

  @ApiProperty({ example: '2026-10-29T12:00:00.000Z' })
  rates_refreshed_at!: string;
}
