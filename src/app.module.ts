import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { DepositsModule } from './deposits/deposits.module';
import { FxModule } from './fx/fx.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { SwapsModule } from './swaps/swaps.module';
import { TransactionsModule } from './transactions/transactions.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    HealthModule,
    FxModule,
    WalletsModule,
    IdempotencyModule,
    TransactionsModule,
    DepositsModule,
    SwapsModule,
  ],
})
export class AppModule {}
