import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FxProvider } from './fx-provider';
import { FxRate } from './fx-rate.entity';
import { FxService } from './fx.service';
import { RatesController } from './rates.controller';
import { RatesSource } from './rates-source';

/**
 * Rate consumers inject `RatesSource`; it resolves to the one `FxService`
 * instance, so every consumer shares its in-memory snapshot.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FxRate])],
  controllers: [RatesController],
  providers: [FxProvider, FxService, { provide: RatesSource, useExisting: FxService }],
  exports: [RatesSource],
})
export class FxModule {}
