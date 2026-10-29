import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';

@Module({
  imports: [IdempotencyModule, TransactionsModule],
  controllers: [DepositsController],
  providers: [DepositsService],
})
export class DepositsModule {}
