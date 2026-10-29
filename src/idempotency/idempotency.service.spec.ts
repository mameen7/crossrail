import { DataSource, EntityManager } from 'typeorm';
import { IdempotencyKey } from './idempotency-key.entity';
import { IdempotencyRequest, IdempotencyService } from './idempotency.service';

const REQ: IdempotencyRequest = { key: 'k-1', endpoint: 'POST /wallets/:id/deposits' };
const HASH = 'a'.repeat(64);

const STORED: IdempotencyKey = {
  key: REQ.key,
  endpoint: REQ.endpoint,
  requestHash: HASH,
  responseStatus: 201,
  responseBody: { id: 'tx-1', type: 'deposit' },
  transactionId: 'tx-1',
  createdAt: new Date('2026-10-29T12:00:00.000Z'),
};

describe('IdempotencyService.execute', () => {
  let insertRaw: unknown[];
  let findOneBy: jest.Mock;
  let update: jest.Mock;
  let transaction: jest.Mock;
  let execute: jest.Mock;
  let builder: Record<string, jest.Mock> & { execute: jest.Mock };
  let service: IdempotencyService;

  beforeEach(() => {
    insertRaw = [{ key: REQ.key }];
    execute = jest.fn(() => Promise.resolve({ raw: insertRaw }));
    builder = { execute };
    for (const method of ['insert', 'into', 'values', 'orIgnore', 'returning', 'updateEntity']) {
      builder[method] = jest.fn(() => builder);
    }
    findOneBy = jest.fn();
    update = jest.fn().mockResolvedValue(undefined);
    const em = { createQueryBuilder: () => builder, findOneBy, update } as unknown as EntityManager;
    transaction = jest.fn((fn: (em: EntityManager) => Promise<unknown>) => fn(em));
    service = new IdempotencyService({ transaction } as unknown as DataSource);
  });

  it('inserts the key row with ON CONFLICT DO NOTHING as the first statement, then runs the work', async () => {
    const order: string[] = [];
    execute.mockImplementation(() => {
      order.push('insert');
      return Promise.resolve({ raw: insertRaw });
    });
    const work = jest.fn(() => {
      order.push('work');
      return Promise.resolve({ status: 201, body: { id: 'tx-1' }, transactionId: 'tx-1' });
    });

    const res = await service.execute(REQ, HASH, work);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['insert', 'work']);
    expect(builder.into).toHaveBeenCalledWith(IdempotencyKey);
    expect(builder.values).toHaveBeenCalledWith({
      key: REQ.key,
      endpoint: REQ.endpoint,
      requestHash: HASH,
    });
    expect(builder.orIgnore).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ status: 201, body: { id: 'tx-1' }, replayed: false });
  });

  it('writes status, body and transaction id onto the key row inside the same transaction', async () => {
    await service.execute(REQ, HASH, () =>
      Promise.resolve({ status: 201, body: { id: 'tx-1' }, transactionId: 'tx-1' }),
    );

    expect(update).toHaveBeenCalledWith(
      IdempotencyKey,
      { key: REQ.key, endpoint: REQ.endpoint },
      { responseStatus: 201, responseBody: { id: 'tx-1' }, transactionId: 'tx-1' },
    );
    expect(findOneBy).not.toHaveBeenCalled();
  });

  it('replays the stored response, without running the work, when the key exists with the same hash', async () => {
    insertRaw = [];
    findOneBy.mockResolvedValue(STORED);
    const work = jest.fn();

    const res = await service.execute(REQ, HASH, work);

    expect(findOneBy).toHaveBeenCalledWith(IdempotencyKey, {
      key: REQ.key,
      endpoint: REQ.endpoint,
    });
    expect(work).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(res).toEqual({ status: 201, body: STORED.responseBody, replayed: true });
  });

  it('rejects with 422 IDEMPOTENCY_KEY_REUSED when the key exists with a different hash', async () => {
    insertRaw = [];
    findOneBy.mockResolvedValue({ ...STORED, requestHash: 'b'.repeat(64) });
    const work = jest.fn();

    await expect(service.execute(REQ, HASH, work)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 422,
      details: { key: REQ.key, endpoint: REQ.endpoint },
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('propagates a failure thrown by the work and writes no response', async () => {
    const boom = new Error('insufficient funds');

    await expect(service.execute(REQ, HASH, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(update).not.toHaveBeenCalled();
  });

  it('fails loudly on a conflicting row that has no stored response or cannot be read', async () => {
    insertRaw = [];
    findOneBy.mockResolvedValueOnce({ ...STORED, responseStatus: null, responseBody: null });
    await expect(service.execute(REQ, HASH, jest.fn())).rejects.toThrow(/no stored response/);

    findOneBy.mockResolvedValueOnce(null);
    await expect(service.execute(REQ, HASH, jest.fn())).rejects.toThrow(/cannot be read/);
  });

  it('fails loudly when the insert result is not a row array', async () => {
    execute.mockResolvedValue({ raw: 1 });
    await expect(service.execute(REQ, HASH, jest.fn())).rejects.toThrow(/row array/);
  });
});
