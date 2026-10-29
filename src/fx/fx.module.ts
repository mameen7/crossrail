import { Module } from '@nestjs/common';
import { FallbackRatesSource } from './fallback-rates.source';
import { RatesSource } from './rates-source';

/**
 * Phase 2 binding: every rate consumer injects `RatesSource` and gets the
 * in-code fallback table. Phase 3 replaces the provider here with the live →
 * cached → fallback chain; callers do not change.
 */
@Module({
  providers: [{ provide: RatesSource, useClass: FallbackRatesSource }],
  exports: [RatesSource],
})
export class FxModule {}
