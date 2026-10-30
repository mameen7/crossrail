import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [IdempotencyModule, TransactionsModule, FxModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
