import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { SwapsController } from './swaps.controller';
import { SwapsService } from './swaps.service';

@Module({
  imports: [IdempotencyModule, TransactionsModule, FxModule],
  controllers: [SwapsController],
  providers: [SwapsService],
})
export class SwapsModule {}
