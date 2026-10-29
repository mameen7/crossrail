import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { parseRate, roundDownAmount, toAmountString } from '../common/money';
import { FALLBACK_SNAPSHOT } from '../fx/fallback-rates';
import { UsdRateTable } from '../fx/fiat';
import { crossRate } from '../fx/pricing';
import { RateSnapshot } from '../fx/rates-source';
import { IdempotencyRequest, IdempotencyService } from '../idempotency/idempotency.service';
import { hashRequest } from '../idempotency/request-hash';
import { Transaction } from '../transactions/transaction.entity';
import { CreateSwapDto } from './dto/create-swap.dto';
import { SwapsService } from './swaps.service';

const W1 = '11111111-1111-4111-8111-111111111111';
const REQ: IdempotencyRequest = { key: 'k', endpoint: 'POST /wallets/:id/swaps' };

const TABLE: UsdRateTable = {
  USD: '1',
  EUR: '0.85',
  NGN: '1490.123456789012345678',
  GHS: '11.5',
  XAF: '557.56',
};
const LIVE: RateSnapshot = {
  table: TABLE,
  source: 'live',
  fetchedAt: new Date('2026-10-29T11:59:00.000Z'),
};

type Entry = { walletId: string; currency: string; amount: Decimal };

/** A validated DTO instance, as the pipe hands it to the controller. */
const dto = (from_currency: string, to_currency: string, amount: string): CreateSwapDto =>
  Object.assign(new CreateSwapDto(), { from_currency, to_currency, amount });

describe('SwapsService.swap', () => {
  const em = {} as EntityManager;
  let execute: jest.Mock;
  let apply: jest.Mock;
  let getSnapshot: jest.Mock<Promise<RateSnapshot>, []>;
  let service: SwapsService;

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
    getSnapshot = jest.fn(() => Promise.resolve(LIVE));
    service = new SwapsService(
      { execute } as unknown as IdempotencyService,
      { apply },
      {
        getSnapshot,
      },
    );
  });

  it('debits the source, credits round_down(source × stored rate, 8) and returns the canonical DTO', async () => {
    const fxRate = crossRate(TABLE, 'cNGN', 'USDx');
    const expectedDestination = roundDownAmount(new Decimal('150000').times(parseRate(fxRate)));

    const res = await service.swap(REQ, W1, dto('cNGN', 'USDx', '150000.00'));

    expect(execute).toHaveBeenCalledWith(
      REQ,
      hashRequest(dto('cNGN', 'USDx', '150000.00'), { id: W1 }),
      expect.any(Function),
    );
    const [manager, draft, entries] = apply.mock.calls[0] as [
      unknown,
      Partial<Transaction>,
      Entry[],
    ];
    expect(manager).toBe(em);
    expect(draft).toEqual({
      type: 'swap',
      walletId: W1,
      senderWalletId: null,
      receiverWalletId: null,
      sourceCurrency: 'cNGN',
      sourceAmount: '150000.00000000',
      destinationCurrency: 'USDx',
      destinationAmount: toAmountString(expectedDestination),
      fxRate,
      rateSource: 'live',
    });
    expect(fxRate).toMatch(/^[0-9]+\.[0-9]{18}$/);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => [e.walletId, e.currency, e.amount.toString()])).toEqual([
      [W1, 'cNGN', '-150000'],
      [W1, 'USDx', expectedDestination.toString()],
    ]);
    expect(res).toEqual({
      status: 201,
      replayed: false,
      body: {
        id: 'tx-1',
        type: 'swap',
        status: 'completed',
        source: { wallet_id: W1, currency: 'cNGN', amount: '150000.00000000' },
        destination: {
          wallet_id: W1,
          currency: 'USDx',
          amount: toAmountString(expectedDestination),
        },
        fx_rate: fxRate,
        rate_source: 'live',
        created_at: '2026-10-29T12:00:00.000Z',
      },
    });
  });

  it('takes the rate snapshot once, before the transaction opens, never inside it', async () => {
    await service.swap(REQ, W1, dto('USDx', 'cNGN', '1'));

    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(getSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]!,
    );
  });

  it('records the snapshot source it was priced from', async () => {
    getSnapshot.mockResolvedValue(FALLBACK_SNAPSHOT);
    await service.swap(REQ, W1, dto('EURx', 'cGHS', '2.5'));

    const [, draft] = apply.mock.calls[0] as [unknown, Partial<Transaction>];
    expect(draft.rateSource).toBe('fallback');
    expect(draft.fxRate).toBe(crossRate(FALLBACK_SNAPSHOT.table, 'EURx', 'cGHS'));
  });

  it('hashes the validated DTO and the wallet id, not the rate', async () => {
    await service.swap(REQ, W1, dto('cNGN', 'USDx', '1'));
    const [, hash] = execute.mock.calls[0] as [unknown, string];

    expect(hash).toBe(
      hashRequest({ amount: '1', to_currency: 'USDx', from_currency: 'cNGN' }, { id: W1 }),
    );
    expect(hash).not.toBe(
      hashRequest({ amount: '1', to_currency: 'USDx', from_currency: 'cNGN' }, { id: 'other' }),
    );
    expect(hash).not.toBe(
      hashRequest({ amount: '1', to_currency: 'cGHS', from_currency: 'cNGN' }, { id: W1 }),
    );
  });

  it.each([
    ['from_currency', dto('BTC', 'USDx', '1')],
    ['to_currency', dto('cNGN', 'BTC', '1')],
  ])(
    'rejects an unsupported %s with 422 UNSUPPORTED_CURRENCY before fetching a rate',
    async (field, input) => {
      await expect(service.swap(REQ, W1, input)).rejects.toMatchObject({
        code: 'UNSUPPORTED_CURRENCY',
        status: 422,
        details: { field, value: 'BTC' },
      });
      expect(getSnapshot).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects a same-currency swap with 422 SAME_CURRENCY_SWAP before fetching a rate', async () => {
    await expect(service.swap(REQ, W1, dto('cNGN', 'cNGN', '1'))).rejects.toMatchObject({
      code: 'SAME_CURRENCY_SWAP',
      status: 422,
      details: { currency: 'cNGN' },
    });
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a conversion that rounds to zero with 422 AMOUNT_TOO_SMALL inside the transaction, before any ledger write', async () => {
    const fxRate = crossRate(TABLE, 'cXAF', 'USDx');
    await expect(service.swap(REQ, W1, dto('cXAF', 'USDx', '0.00000001'))).rejects.toMatchObject({
      code: 'AMOUNT_TOO_SMALL',
      status: 422,
      details: {
        from_currency: 'cXAF',
        to_currency: 'USDx',
        amount: '0.00000001',
        fx_rate: fxRate,
      },
    });
    // The snapshot was taken outside; the rejection came from inside the work
    // callback, so the key row rolls back with it and nothing hit the ledger.
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('lets a replay of a committed swap win even when the current rate would now round it to zero', async () => {
    // 0.00001 cXAF converts to 0.00000001 USDx at the live table, and commits.
    const first = await service.swap(REQ, W1, dto('cXAF', 'USDx', '0.00001'));
    expect(first.body.destination.amount).toBe('0.00000001');

    // The rate moves so the same amount now rounds to zero ...
    getSnapshot.mockResolvedValue({ ...LIVE, table: { ...TABLE, XAF: '2000' } });
    // ... and the retry finds the first attempt's key row: execute replays it
    // without running the work callback.
    execute.mockResolvedValue({ status: 201, body: first.body, replayed: true });

    const retry = await service.swap(REQ, W1, dto('cXAF', 'USDx', '0.00001'));

    expect(retry).toEqual({ status: 201, body: first.body, replayed: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('lets a ledger failure (insufficient funds, unknown wallet) propagate out of the transaction', async () => {
    const boom = new Error('INSUFFICIENT_FUNDS stand-in');
    apply.mockRejectedValue(boom);
    await expect(service.swap(REQ, W1, dto('cNGN', 'USDx', '1'))).rejects.toBe(boom);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
