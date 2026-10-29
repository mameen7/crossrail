import { parseAmount, parseRate, toAmountString, toRateString } from '../common/money';
import { TransactionDto } from './dto/transaction.dto';
import { Transaction } from './transaction.entity';

/**
 * Renders a transaction row as the canonical DTO. Amounts are re-rendered at
 * 8 dp and the rate at 18 dp, so a row written with `'1'` and one read back
 * from Postgres as `'1.000000000000000000'` produce the same response.
 */
export function toTransactionDto(tx: Transaction): TransactionDto {
  const [sourceWalletId, destinationWalletId] = legWallets(tx);
  return {
    id: tx.id,
    type: tx.type,
    status: tx.status,
    source: {
      wallet_id: sourceWalletId,
      currency: tx.sourceCurrency,
      amount: toAmountString(parseAmount(tx.sourceAmount)),
    },
    destination: {
      wallet_id: destinationWalletId,
      currency: tx.destinationCurrency,
      amount: toAmountString(parseAmount(tx.destinationAmount)),
    },
    fx_rate: toRateString(parseRate(tx.fxRate)),
    rate_source: tx.rateSource,
    created_at: tx.createdAt.toISOString(),
  };
}

function legWallets(tx: Transaction): [string | null, string | null] {
  switch (tx.type) {
    case 'deposit':
      return [null, tx.walletId];
    case 'swap':
      return [tx.walletId, tx.walletId];
    case 'transfer':
      return [tx.senderWalletId, tx.receiverWalletId];
  }
}
