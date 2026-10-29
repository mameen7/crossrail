import { Transaction } from './transaction.entity';
import { toTransactionDto } from './transaction.mapper';

const CREATED_AT = new Date('2026-10-29T12:00:00.000Z');

const base: Transaction = {
  id: 'tx-1',
  type: 'deposit',
  status: 'completed',
  walletId: 'w-1',
  senderWalletId: null,
  receiverWalletId: null,
  sourceCurrency: 'cNGN',
  sourceAmount: '10.5',
  destinationCurrency: 'cNGN',
  destinationAmount: '10.5',
  fxRate: '1',
  rateSource: 'none',
  createdAt: CREATED_AT,
};

describe('toTransactionDto', () => {
  it('renders a deposit with a null source wallet, 8 dp amounts and an 18 dp rate', () => {
    expect(toTransactionDto(base)).toEqual({
      id: 'tx-1',
      type: 'deposit',
      status: 'completed',
      source: { wallet_id: null, currency: 'cNGN', amount: '10.50000000' },
      destination: { wallet_id: 'w-1', currency: 'cNGN', amount: '10.50000000' },
      fx_rate: '1.000000000000000000',
      rate_source: 'none',
      created_at: '2026-10-29T12:00:00.000Z',
    });
  });

  it('renders the same for a row read back from Postgres at full scale', () => {
    const fromDb = {
      ...base,
      sourceAmount: '10.50000000',
      destinationAmount: '10.50000000',
      fxRate: '1.000000000000000000',
    };
    expect(toTransactionDto(fromDb)).toEqual(toTransactionDto(base));
  });

  it('puts the one wallet on both sides of a swap', () => {
    const dto = toTransactionDto({
      ...base,
      type: 'swap',
      destinationCurrency: 'USDx',
      destinationAmount: '0.00708783',
      fxRate: '0.000675100000000000',
      rateSource: 'live',
    });
    expect(dto.source.wallet_id).toBe('w-1');
    expect(dto.destination).toEqual({
      wallet_id: 'w-1',
      currency: 'USDx',
      amount: '0.00708783',
    });
    expect(dto.fx_rate).toBe('0.000675100000000000');
    expect(dto.rate_source).toBe('live');
  });

  it('puts sender and receiver on the two sides of a transfer', () => {
    const dto = toTransactionDto({
      ...base,
      type: 'transfer',
      walletId: null,
      senderWalletId: 'w-a',
      receiverWalletId: 'w-b',
    });
    expect(dto.source.wallet_id).toBe('w-a');
    expect(dto.destination.wallet_id).toBe('w-b');
  });
});
