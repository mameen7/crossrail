import { Injectable } from '@nestjs/common';
import { FALLBACK_RATES, FALLBACK_RATES_AS_OF } from './fallback-rates';
import { RateSnapshot, RatesSource } from './rates-source';

/**
 * Serves the in-code `FALLBACK_RATES` constant as a snapshot with
 * `source = 'fallback'`, stamped with the date the constant was written.
 */
@Injectable()
export class FallbackRatesSource extends RatesSource {
  private readonly snapshot: RateSnapshot = {
    table: FALLBACK_RATES,
    source: 'fallback',
    fetchedAt: FALLBACK_RATES_AS_OF,
  };

  getSnapshot(): Promise<RateSnapshot> {
    return Promise.resolve(this.snapshot);
  }
}
