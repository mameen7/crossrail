import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { Balance } from '../wallets/balance.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { LedgerService, sumDeltas, TransactionDraft } from './ledger.service';
import { Transaction } from './transaction.entity';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';

const depositDraft = (walletId: string, amount: string): TransactionDraft => ({
  type: 'deposit',
  walletId,
  senderWalletId: null,
  receiverWalletId: null,
  sourceCurrency: 'cNGN',
  sourceAmount: amount,
  destinationCurrency: 'cNGN',
  destinationAmount: amount,
  fxRate: '1',
  rateSource: 'none',
});

describe('sumDeltas', () => {
  it('sums entries on the same row and orders rows by wallet id then currency, byte-wise', () => {
    const out = sumDeltas([
      { walletId: W2, currency: 'cNGN', amount: new Decimal('5') },
      { walletId: W1, currency: 'cNGN', amount: new Decimal('-3') },
      { walletId: W1, currency: 'USDx', amount: new Decimal('1') },
      { walletId: W1, currency: 'cNGN', amount: new Decimal('-2') },
      { walletId: W1, currency: 'EURx', amount: new Decimal('0.5') },
    ]);
    // 'E' (0x45) and 'U' (0x55) sort before 'c' (0x63) byte-wise.
    expect(out.map(([k, d]) => [k.walletId, k.currency, d.toString()])).toEqual([
      [W1, 'EURx', '0.5'],
      [W1, 'USDx', '1'],
      [W1, 'cNGN', '-5'],
      [W2, 'cNGN', '5'],
    ]);
  });

  it('rejects an empty list', () => {
    expect(() => sumDeltas([])).toThrow(/at least one ledger entry/);
  });
});

describe('LedgerService.apply', () => {
  let balances: Map<string, string>;
  let findOne: jest.Mock;
  let update: jest.Mock;
  let save: jest.Mock;
  let insert: jest.Mock;
  let em: EntityManager;
  const service = new LedgerService();

  const setBalance = (walletId: string, currency: string, amount: string): void => {
    balances.set(`${walletId}/${currency}`, amount);
  };

  beforeEach(() => {
    balances = new Map();
    findOne = jest.fn(
      (
        _target: unknown,
        options: { where: { walletId: string; currency: string }; lock?: { mode: string } },
      ) => {
        const amount = balances.get(`${options.where.walletId}/${options.where.currency}`);
        return Promise.resolve(amount === undefined ? null : { ...options.where, amount });
      },
    );
    update = jest.fn().mockResolvedValue(undefined);
    save = jest.fn((tx: Partial<Transaction>) =>
      Promise.resolve({ ...tx, id: 'tx-1', createdAt: new Date('2026-10-29T12:00:00Z') }),
    );
    insert = jest.fn().mockResolvedValue(undefined);
    em = {
      findOne,
      update,
      save,
      insert,
      create: (_target: unknown, value: Partial<Transaction>) => value,
    } as unknown as EntityManager;
  });

  it('applies a deposit: lock, credit, transaction row, one ledger entry at 8 dp', async () => {
    setBalance(W1, 'cNGN', '2.00000000');

    const tx = await service.apply(em, depositDraft(W1, '10.50000000'), [
      { walletId: W1, currency: 'cNGN', amount: new Decimal('10.5') },
    ]);

    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith(Balance, {
      where: { walletId: W1, currency: 'cNGN' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(update).toHaveBeenCalledWith(
      Balance,
      { walletId: W1, currency: 'cNGN' },
      expect.objectContaining({ amount: '12.50000000' }),
    );
    expect(save).toHaveBeenCalledWith({ ...depositDraft(W1, '10.50000000'), status: 'completed' });
    expect(insert).toHaveBeenCalledWith(LedgerEntry, [
      { transactionId: 'tx-1', walletId: W1, currency: 'cNGN', amount: '10.50000000' },
    ]);
    expect(tx.id).toBe('tx-1');
  });

  it('locks every touched row in sorted order, whatever order the entries arrive in', async () => {
    setBalance(W2, 'cNGN', '100');
    setBalance(W1, 'USDx', '0');
    setBalance(W1, 'cNGN', '50');

    await service.apply(
      em,
      { ...depositDraft(W1, '1'), type: 'transfer', senderWalletId: W2, receiverWalletId: W1 },
      [
        { walletId: W2, currency: 'cNGN', amount: new Decimal('-10') },
        { walletId: W1, currency: 'cNGN', amount: new Decimal('10') },
        { walletId: W1, currency: 'USDx', amount: new Decimal('1') },
      ],
    );

    const lockOrder = findOne.mock.calls.map(
      ([, opts]: [unknown, { where: { walletId: string; currency: string } }]) =>
        `${opts.where.walletId}/${opts.where.currency}`,
    );
    expect(lockOrder).toEqual([`${W1}/USDx`, `${W1}/cNGN`, `${W2}/cNGN`]);
    // All locks are taken before the first write.
    const firstUpdate = update.mock.invocationCallOrder[0]!;
    expect(findOne.mock.invocationCallOrder.every((n) => n < firstUpdate)).toBe(true);
  });

  it('rejects an uncovered debit with 422 INSUFFICIENT_FUNDS before writing anything', async () => {
    setBalance(W1, 'cNGN', '5.00000000');
    setBalance(W1, 'USDx', '0.00000000');

    await expect(
      service.apply(em, { ...depositDraft(W1, '7'), type: 'swap' }, [
        { walletId: W1, currency: 'cNGN', amount: new Decimal('-7') },
        { walletId: W1, currency: 'USDx', amount: new Decimal('0.00472570') },
      ]),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      status: 422,
      details: {
        wallet_id: W1,
        currency: 'cNGN',
        available: '5.00000000',
        requested: '7.00000000',
      },
    });
    // Both rows were locked before the shortfall was reported.
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('allows a debit that lands exactly on zero', async () => {
    setBalance(W1, 'cNGN', '7.00000000');
    await service.apply(em, { ...depositDraft(W1, '7'), type: 'swap' }, [
      { walletId: W1, currency: 'cNGN', amount: new Decimal('-7') },
    ]);
    expect(update).toHaveBeenCalledWith(
      Balance,
      { walletId: W1, currency: 'cNGN' },
      expect.objectContaining({ amount: '0.00000000' }),
    );
  });

  it('treats a missing balance row as 404 WALLET_NOT_FOUND for that wallet', async () => {
    setBalance(W1, 'cNGN', '100');
    await expect(
      service.apply(
        em,
        { ...depositDraft(W1, '1'), type: 'transfer', senderWalletId: W1, receiverWalletId: W2 },
        [
          { walletId: W1, currency: 'cNGN', amount: new Decimal('-1') },
          { walletId: W2, currency: 'cNGN', amount: new Decimal('1') },
        ],
      ),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND', status: 404, details: { id: W2 } });
    expect(update).not.toHaveBeenCalled();
  });

  it('validates entries before taking any lock', async () => {
    await expect(
      service.apply(em, depositDraft(W1, '1'), [
        { walletId: W1, currency: 'cNGN', amount: new Decimal('1.000000001') },
      ]),
    ).rejects.toThrow(/at most 8 dp/);
    await expect(
      service.apply(em, depositDraft(W1, '1'), [
        { walletId: W1, currency: 'cNGN', amount: new Decimal(0) },
      ]),
    ).rejects.toThrow(/non-zero/);
    await expect(service.apply(em, depositDraft(W1, '1'), [])).rejects.toThrow(
      /at least one ledger entry/,
    );
    expect(findOne).not.toHaveBeenCalled();
  });
});
