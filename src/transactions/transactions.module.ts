import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

/**
 * Owns the transaction and ledger entities and the `LedgerService` every
 * mutation goes through. The history and lookup controller arrives in phase 7.
 */
@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class TransactionsModule {}
