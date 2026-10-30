import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { IdempotencyRequest, IdempotencyService } from '../idempotency/idempotency.service';
import { LedgerPosting, recordTransaction } from './record-transaction';
import { Transaction } from './transaction.entity';

const W1 = '11111111-1111-4111-8111-111111111111';
const REQ: IdempotencyRequest = { key: 'k', endpoint: 'POST /wallets/:id/deposits' };

const POSTING: LedgerPosting = {
  draft: {
    type: 'deposit',
    walletId: W1,
    senderWalletId: null,
    receiverWalletId: null,
    sourceCurrency: 'cNGN',
    sourceAmount: '1.00000000',
    destinationCurrency: 'cNGN',
    destinationAmount: '1.00000000',
    fxRate: '1',
    rateSource: 'none',
  },
  entries: [{ walletId: W1, currency: 'cNGN', amount: new Decimal(1) }],
};

describe('recordTransaction', () => {
  const em = {} as EntityManager;
  let calls: string[];
  let execute: jest.Mock;
  let apply: jest.Mock;
  let prepare: jest.Mock<LedgerPosting, []>;

  const run = () =>
    recordTransaction(
      { execute } as unknown as IdempotencyService,
      { apply },
      REQ,
      'hash',
      prepare,
    );

  beforeEach(() => {
    calls = [];
    // A fresh key: the real execute inserts the key row, then runs the work.
    execute = jest.fn(
      async (
        _req: IdempotencyRequest,
        _hash: string,
        work: (em: EntityManager) => Promise<{ status: number; body: unknown }>,
      ) => {
        calls.push('key insert');
        const { status, body } = await work(em);
        return { status, body, replayed: false };
      },
    );
    apply = jest.fn((_em: unknown, draft: Partial<Transaction>) => {
      calls.push('apply');
      return Promise.resolve({
        ...draft,
        id: 'tx-1',
        status: 'completed',
        createdAt: new Date('2026-10-29T12:00:00.000Z'),
      });
    });
    prepare = jest.fn(() => {
      calls.push('prepare');
      return POSTING;
    });
  });

  it('on a fresh key runs prepare after the key insert and before the ledger, inside the transaction', async () => {
    await run();

    expect(calls).toEqual(['key insert', 'prepare', 'apply']);
    expect(execute).toHaveBeenCalledWith(REQ, 'hash', expect.any(Function));
    expect(apply).toHaveBeenCalledWith(em, POSTING.draft, POSTING.entries);
  });

  it('hands execute a 201 with the canonical DTO and the transaction id for the key row', async () => {
    let stored: unknown;
    execute.mockImplementation(
      async (
        _req: IdempotencyRequest,
        _hash: string,
        work: (em: EntityManager) => Promise<{ status: number; body: unknown }>,
      ) => {
        stored = await work(em);
        return { ...(stored as object), replayed: false };
      },
    );

    const res = await run();

    expect(stored).toEqual({
      status: 201,
      transactionId: 'tx-1',
      body: {
        id: 'tx-1',
        type: 'deposit',
        status: 'completed',
        source: { wallet_id: null, currency: 'cNGN', amount: '1.00000000' },
        destination: { wallet_id: W1, currency: 'cNGN', amount: '1.00000000' },
        fx_rate: '1.000000000000000000',
        rate_source: 'none',
        created_at: '2026-10-29T12:00:00.000Z',
      },
    });
    expect(res).toMatchObject({ status: 201, replayed: false });
  });

  it('never calls prepare or the ledger on a replay', async () => {
    const stored = { status: 201, body: { id: 'tx-0' }, replayed: true };
    execute.mockResolvedValue(stored);

    await expect(run()).resolves.toBe(stored);
    expect(prepare).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('lets a prepare failure out of the transaction before any ledger write, so the key rolls back', async () => {
    const tooSmall = new Error('AMOUNT_TOO_SMALL stand-in');
    prepare.mockImplementation(() => {
      throw tooSmall;
    });

    await expect(run()).rejects.toBe(tooSmall);
    expect(apply).not.toHaveBeenCalled();
  });
});
