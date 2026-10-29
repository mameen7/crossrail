import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { IdempotencyRequest, IdempotencyService } from '../idempotency/idempotency.service';
import { hashRequest } from '../idempotency/request-hash';
import { Transaction } from '../transactions/transaction.entity';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { DepositsService } from './deposits.service';

const W1 = '11111111-1111-4111-8111-111111111111';
const REQ: IdempotencyRequest = { key: 'k', endpoint: 'POST /wallets/:id/deposits' };

/** A validated DTO instance, as the pipe hands it to the controller. */
const dto = (currency: string, amount: string): CreateDepositDto =>
  Object.assign(new CreateDepositDto(), { currency, amount });

describe('DepositsService.deposit', () => {
  const em = {} as EntityManager;
  let execute: jest.Mock;
  let apply: jest.Mock;
  let service: DepositsService;

  beforeEach(() => {
    // Runs the work with the fake manager, as the real execute does on a fresh key.
    execute = jest.fn(
      async (
        _req: IdempotencyRequest,
        _hash: string,
        work: (em: EntityManager) => Promise<{ status: number; body: unknown }>,
      ) => {
        const { status, body } = await work(em);
        return { status, body, replayed: false };
      },
    );
    apply = jest.fn((_em: unknown, draft: Partial<Transaction>) =>
      Promise.resolve({
        ...draft,
        id: 'tx-1',
        status: 'completed',
        createdAt: new Date('2026-10-29T12:00:00.000Z'),
      }),
    );
    service = new DepositsService({ execute } as unknown as IdempotencyService, { apply });
  });

  it('credits one ledger entry through the ledger and returns the canonical DTO', async () => {
    const res = await service.deposit(REQ, W1, dto('cNGN', '10.5'));

    expect(execute).toHaveBeenCalledWith(
      REQ,
      hashRequest(dto('cNGN', '10.5'), { id: W1 }),
      expect.any(Function),
    );
    const [manager, draft, entries] = apply.mock.calls[0] as [
      unknown,
      Partial<Transaction>,
      { walletId: string; currency: string; amount: Decimal }[],
    ];
    expect(manager).toBe(em);
    expect(draft).toEqual({
      type: 'deposit',
      walletId: W1,
      senderWalletId: null,
      receiverWalletId: null,
      sourceCurrency: 'cNGN',
      sourceAmount: '10.50000000',
      destinationCurrency: 'cNGN',
      destinationAmount: '10.50000000',
      fxRate: '1',
      rateSource: 'none',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount.toString()).toBe('10.5');
    expect(res).toEqual({
      status: 201,
      replayed: false,
      body: {
        id: 'tx-1',
        type: 'deposit',
        status: 'completed',
        source: { wallet_id: null, currency: 'cNGN', amount: '10.50000000' },
        destination: { wallet_id: W1, currency: 'cNGN', amount: '10.50000000' },
        fx_rate: '1.000000000000000000',
        rate_source: 'none',
        created_at: '2026-10-29T12:00:00.000Z',
      },
    });
  });

  it('hashes the validated DTO and the wallet id, so key order and extra fields do not matter', async () => {
    await service.deposit(REQ, W1, dto('cNGN', '1'));
    const [, hash] = execute.mock.calls[0] as [unknown, string];

    expect(hash).toBe(hashRequest({ amount: '1', currency: 'cNGN' }, { id: W1 }));
    expect(hash).not.toBe(hashRequest({ amount: '1', currency: 'cNGN' }, { id: 'other' }));
    expect(hash).not.toBe(hashRequest({ amount: '1.0', currency: 'cNGN' }, { id: W1 }));
  });

  it('rejects an unsupported currency with 422 UNSUPPORTED_CURRENCY before opening a transaction', async () => {
    await expect(service.deposit(REQ, W1, dto('BTC', '1'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CURRENCY',
      status: 422,
      details: { field: 'currency', value: 'BTC' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets a ledger failure (e.g. unknown wallet) propagate out of the transaction', async () => {
    const boom = new Error('WALLET_NOT_FOUND stand-in');
    apply.mockRejectedValue(boom);
    await expect(service.deposit(REQ, W1, dto('cNGN', '1'))).rejects.toBe(boom);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
