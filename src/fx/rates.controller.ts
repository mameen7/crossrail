import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PairRateDto, RatesDto } from './dto/rates.dto';
import { allPairRates } from './pricing';
import { RateSnapshot, RatesSource } from './rates-source';

@ApiTags('rates')
@Controller('rates')
export class RatesController {
  constructor(private readonly rates: RatesSource) {}

  @Get()
  @ApiOperation({
    summary: 'Get the conversion matrix',
    description:
      'All 20 ordered currency pairs from one rate snapshot (live, then cached, then fallback). ' +
      'Answers with a lower tier when the provider is down; never a 5xx for that.',
  })
  @ApiOkResponse({ type: RatesDto })
  async list(): Promise<RatesDto> {
    return toRatesDto(await this.rates.getSnapshot());
  }
}

export function toRatesDto(snapshot: RateSnapshot): RatesDto {
  const fetchedAt = snapshot.fetchedAt.toISOString();
  return {
    rates: allPairRates(snapshot.table).map((pair): PairRateDto => ({
      ...pair,
      source: snapshot.source,
      fetched_at: fetchedAt,
    })),
  };
}
