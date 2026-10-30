import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletsModule } from '../wallets/wallets.module';
import { LedgerService } from './ledger.service';
import { Transaction } from './transaction.entity';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

/**
 * Owns the transaction and ledger entities, the `LedgerService` every
 * mutation goes through, and the read side: wallet history and lookup by id.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Transaction]), WalletsModule],
  controllers: [TransactionsController],
  providers: [LedgerService, TransactionsService],
  exports: [LedgerService],
})
export class TransactionsModule {}
