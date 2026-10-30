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
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransfersService } from './transfers.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const REQ: IdempotencyRequest = { key: 'k', endpoint: 'POST /transfers' };

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

/** A validated DTO instance, as the pipe hands it to the controller (ids already lowercased). */
const dto = (
  source_currency: string,
  source_amount: string,
  destination_currency?: string,
  sender_wallet_id = A,
  receiver_wallet_id = B,
): CreateTransferDto =>
  Object.assign(new CreateTransferDto(), {
    sender_wallet_id,
    receiver_wallet_id,
    source_currency,
    source_amount,
    ...(destination_currency === undefined ? {} : { destination_currency }),
  });

describe('TransfersService.transfer', () => {
  const em = {} as EntityManager;
  let execute: jest.Mock;
  let apply: jest.Mock;
  let getSnapshot: jest.Mock<Promise<RateSnapshot>, []>;
  let service: TransfersService;

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
    service = new TransfersService(
      { execute } as unknown as IdempotencyService,
      { apply },
      { getSnapshot },
    );
  });

  it('moves a same-currency amount unchanged at rate 1 from source "none", without a rate snapshot', async () => {
    const res = await service.transfer(REQ, dto('cNGN', '10.5', 'cNGN'));

    expect(getSnapshot).not.toHaveBeenCalled();
    const [manager, draft, entries] = apply.mock.calls[0] as [
      unknown,
      Partial<Transaction>,
      Entry[],
    ];
    expect(manager).toBe(em);
    expect(draft).toEqual({
      type: 'transfer',
      walletId: null,
      senderWalletId: A,
      receiverWalletId: B,
      sourceCurrency: 'cNGN',
      sourceAmount: '10.50000000',
      destinationCurrency: 'cNGN',
      destinationAmount: '10.50000000',
      fxRate: '1', // stored as the literal; the DTO below renders it at 18 dp
      rateSource: 'none',
    });
    expect(entries.map((e) => [e.walletId, e.currency, e.amount.toString()])).toEqual([
      [A, 'cNGN', '-10.5'],
      [B, 'cNGN', '10.5'],
    ]);
    expect(res).toEqual({
      status: 201,
      replayed: false,
      body: {
        id: 'tx-1',
        type: 'transfer',
        status: 'completed',
        source: { wallet_id: A, currency: 'cNGN', amount: '10.50000000' },
        destination: { wallet_id: B, currency: 'cNGN', amount: '10.50000000' },
        fx_rate: '1.000000000000000000',
        rate_source: 'none',
        created_at: '2026-10-29T12:00:00.000Z',
      },
    });
  });

  it('defaults an omitted destination_currency to the source currency, and hashes it as if sent', async () => {
    await service.transfer(REQ, dto('USDx', '3'));

    expect(getSnapshot).not.toHaveBeenCalled();
    const [, draft] = apply.mock.calls[0] as [unknown, Partial<Transaction>];
    expect(draft).toMatchObject({
      sourceCurrency: 'USDx',
      destinationCurrency: 'USDx',
      destinationAmount: '3.00000000',
      rateSource: 'none',
    });

    await service.transfer(REQ, dto('USDx', '3', 'USDx'));
    const [omitted, explicit] = (execute.mock.calls as [unknown, string][]).map(([, hash]) => hash);
    expect(omitted).toBeDefined();
    expect(omitted).toBe(explicit);
  });

  it('converts across currencies at the 18 dp stored rate: destination = round_down(source × rate, 8)', async () => {
    const fxRate = crossRate(TABLE, 'cNGN', 'USDx');
    const expectedDestination = roundDownAmount(new Decimal('150000').times(parseRate(fxRate)));

    const res = await service.transfer(REQ, dto('cNGN', '150000.00', 'USDx'));

    const [, draft, entries] = apply.mock.calls[0] as [unknown, Partial<Transaction>, Entry[]];
    expect(fxRate).toMatch(/^[0-9]+\.[0-9]{18}$/);
    expect(draft).toEqual({
      type: 'transfer',
      walletId: null,
      senderWalletId: A,
      receiverWalletId: B,
      sourceCurrency: 'cNGN',
      sourceAmount: '150000.00000000',
      destinationCurrency: 'USDx',
      destinationAmount: toAmountString(expectedDestination),
      fxRate,
      rateSource: 'live',
    });
    expect(entries.map((e) => [e.walletId, e.currency, e.amount.toString()])).toEqual([
      [A, 'cNGN', '-150000'],
      [B, 'USDx', expectedDestination.toString()],
    ]);
    expect(res.body.source).toEqual({ wallet_id: A, currency: 'cNGN', amount: '150000.00000000' });
    expect(res.body.destination).toEqual({
      wallet_id: B,
      currency: 'USDx',
      amount: toAmountString(expectedDestination),
    });
  });

  it('takes a cross-currency rate snapshot once, before the transaction opens', async () => {
    await service.transfer(REQ, dto('USDx', '1', 'cNGN'));

    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(getSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]!,
    );
  });

  it('records the snapshot source it was priced from', async () => {
    getSnapshot.mockResolvedValue(FALLBACK_SNAPSHOT);
    await service.transfer(REQ, dto('EURx', '2.5', 'cGHS'));

    const [, draft] = apply.mock.calls[0] as [unknown, Partial<Transaction>];
    expect(draft.rateSource).toBe('fallback');
    expect(draft.fxRate).toBe(crossRate(FALLBACK_SNAPSHOT.table, 'EURx', 'cGHS'));
  });

  it('hashes the normalized DTO alone, not the rate', async () => {
    await service.transfer(REQ, dto('cNGN', '1', 'USDx'));
    const [, hash] = execute.mock.calls[0] as [unknown, string];

    const body = {
      sender_wallet_id: A,
      receiver_wallet_id: B,
      source_currency: 'cNGN',
      source_amount: '1',
      destination_currency: 'USDx',
    };
    expect(hash).toBe(hashRequest(body, {}));
    expect(hash).not.toBe(hashRequest({ ...body, receiver_wallet_id: A }, {}));
    expect(hash).not.toBe(hashRequest({ ...body, destination_currency: 'cGHS' }, {}));
  });

  it.each([
    ['source_currency', dto('BTC', '1', 'USDx')],
    ['source_currency', dto('BTC', '1')],
    ['destination_currency', dto('cNGN', '1', 'BTC')],
  ])(
    'rejects an unsupported %s with 422 UNSUPPORTED_CURRENCY before fetching a rate',
    async (field, input) => {
      await expect(service.transfer(REQ, input)).rejects.toMatchObject({
        code: 'UNSUPPORTED_CURRENCY',
        status: 422,
        details: { field, value: 'BTC' },
      });
      expect(getSnapshot).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects sender == receiver with 422 SELF_TRANSFER before fetching a rate', async () => {
    await expect(service.transfer(REQ, dto('cNGN', '1', 'USDx', A, A))).rejects.toMatchObject({
      code: 'SELF_TRANSFER',
      status: 422,
      details: { wallet_id: A },
    });
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('checks currencies before the self-transfer rule', async () => {
    await expect(service.transfer(REQ, dto('BTC', '1', 'USDx', A, A))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CURRENCY',
    });
  });

  it('rejects a conversion that rounds to zero with 422 AMOUNT_TOO_SMALL inside the transaction, before any ledger write', async () => {
    const fxRate = crossRate(TABLE, 'cXAF', 'USDx');
    await expect(service.transfer(REQ, dto('cXAF', '0.00000001', 'USDx'))).rejects.toMatchObject({
      code: 'AMOUNT_TOO_SMALL',
      status: 422,
      details: {
        from_currency: 'cXAF',
        to_currency: 'USDx',
        amount: '0.00000001',
        fx_rate: fxRate,
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('lets a replay of a committed transfer win even when the current rate would now round it to zero', async () => {
    const first = await service.transfer(REQ, dto('cXAF', '0.00001', 'USDx'));
    expect(first.body.destination.amount).toBe('0.00000001');

    getSnapshot.mockResolvedValue({ ...LIVE, table: { ...TABLE, XAF: '2000' } });
    execute.mockResolvedValue({ status: 201, body: first.body, replayed: true });

    const retry = await service.transfer(REQ, dto('cXAF', '0.00001', 'USDx'));

    expect(retry).toEqual({ status: 201, body: first.body, replayed: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('lets a ledger failure (insufficient funds, unknown wallet) propagate out of the transaction', async () => {
    const boom = new Error('WALLET_NOT_FOUND stand-in');
    apply.mockRejectedValue(boom);
    await expect(service.transfer(REQ, dto('cNGN', '1'))).rejects.toBe(boom);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
