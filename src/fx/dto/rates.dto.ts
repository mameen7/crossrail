import { ApiProperty } from '@nestjs/swagger';
import { CURRENCIES, Currency } from '../../common/currency';
import { RATE_SOURCES, RateSource } from '../rate-source';

export class PairRateDto {
  @ApiProperty({ enum: CURRENCIES, example: 'cNGN' })
  from!: Currency;

  @ApiProperty({ enum: CURRENCIES, example: 'USDx' })
  to!: Currency;

  @ApiProperty({
    example: '0.000675675675675676',
    description: 'Units of `to` per 1 unit of `from`, decimal string, always 18 dp',
  })
  rate!: string;

  @ApiProperty({ enum: RATE_SOURCES.filter((s) => s !== 'none'), example: 'live' })
  source!: RateSource;

  @ApiProperty({
    example: '2026-10-29T12:00:00.000Z',
    description: 'When the snapshot was fetched; for fallback, when the constant was authored',
  })
  fetched_at!: string;
}

export class RatesDto {
  @ApiProperty({
    type: [PairRateDto],
    description: 'All 20 ordered pairs, from one snapshot, so source and fetched_at are uniform',
  })
  rates!: PairRateDto[];
}
