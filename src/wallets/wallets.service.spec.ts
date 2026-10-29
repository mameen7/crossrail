import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { ApiError } from '../common/api-error';
import { CURRENCIES } from '../common/currency';
import { FallbackRatesSource } from '../fx/fallback-rates.source';
import { Balance } from './balance.entity';
import { Wallet } from './wallet.entity';
import { uniqueViolationField, WalletsService } from './wallets.service';

const CREATED_AT = new Date('2026-10-29T12:00:00.000Z');

const pgError = (code: string, constraint?: string): QueryFailedError =>
  new QueryFailedError('INSERT', [], Object.assign(new Error('driver'), { code, constraint }));

describe('WalletsService', () => {
  let transaction: jest.Mock;
  let save: jest.Mock;
  let insert: jest.Mock;
  let findOneBy: jest.Mock;
  let findBy: jest.Mock;
  let service: WalletsService;

  beforeEach(() => {
    save = jest.fn((wallet: Partial<Wallet>) =>
      Promise.resolve({ ...wallet, id: 'wallet-1', createdAt: CREATED_AT } as Wallet),
    );
    insert = jest.fn().mockResolvedValue(undefined);
    const em = {
      create: (_target: unknown, value: Partial<Wallet>) => value,
      save,
      insert,
    } as unknown as EntityManager;
    transaction = jest.fn((fn: (em: EntityManager) => Promise<unknown>) => fn(em));
    findOneBy = jest.fn();
    findBy = jest.fn();

    service = new WalletsService(
      { transaction } as unknown as DataSource,
      { findOneBy } as unknown as Repository<Wallet>,
      { findBy } as unknown as Repository<Balance>,
      new FallbackRatesSource(),
    );
  });

  describe('create', () => {
    it('normalizes email and phone before persisting', async () => {
      const dto = await service.create({ email: 'Ada@Example.COM', phone: '+234 800-000-0000' });

      expect(save).toHaveBeenCalledWith({ email: 'ada@example.com', phone: '+2348000000000' });
      expect(dto).toEqual({
        id: 'wallet-1',
        email: 'ada@example.com',
        phone: '+2348000000000',
        created_at: '2026-10-29T12:00:00.000Z',
      });
    });

    it('inserts all five zero balance rows inside the same transaction', async () => {
      await service.create({ email: 'ada@example.com' });

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledTimes(1);
      const [target, rows] = insert.mock.calls[0] as [
        unknown,
        { currency: string; amount: string }[],
      ];
      expect(target).toBe(Balance);
      expect(rows.map((r) => r.currency)).toEqual([...CURRENCIES]);
      expect(rows.every((r) => r.amount === '0')).toBe(true);
    });

    it('stores null for an omitted contact', async () => {
      await service.create({ phone: '08000000000' });
      expect(save).toHaveBeenCalledWith({ email: null, phone: '08000000000' });
    });

    it('rejects a request with neither email nor phone before touching the database', async () => {
      await expect(service.create({})).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 422,
      });
      await expect(service.create({ email: null, phone: null })).rejects.toBeInstanceOf(ApiError);
      expect(transaction).not.toHaveBeenCalled();
    });

    it('maps a unique violation to 409 WALLET_EXISTS naming the field', async () => {
      transaction.mockRejectedValueOnce(pgError('23505', 'UQ_wallets_phone'));
      await expect(service.create({ phone: '08000000000' })).rejects.toMatchObject({
        code: 'WALLET_EXISTS',
        status: 409,
        details: { field: 'phone' },
      });
    });

    it('rethrows any other database error untouched', async () => {
      const boom = pgError('23514', 'CHK_wallets_contact');
      transaction.mockRejectedValueOnce(boom);
      await expect(service.create({ email: 'a@b.co' })).rejects.toBe(boom);
    });
  });

  describe('get', () => {
    it('throws 404 WALLET_NOT_FOUND for an unknown id', async () => {
      findOneBy.mockResolvedValue(null);
      await expect(service.get('missing')).rejects.toMatchObject({
        code: 'WALLET_NOT_FOUND',
        status: 404,
      });
    });

    it('returns balances in canonical order and the USD total from the fallback rates', async () => {
      findOneBy.mockResolvedValue({
        id: 'wallet-1',
        email: 'ada@example.com',
        phone: null,
        createdAt: CREATED_AT,
      });
      // Deliberately out of order and with a non-canonical scale.
      findBy.mockResolvedValue([
        { currency: 'EURx', amount: '0.86000000' },
        { currency: 'USDx', amount: '2.5' },
        { currency: 'cXAF', amount: '0.00000000' },
        { currency: 'cGHS', amount: '0.00000000' },
        { currency: 'cNGN', amount: '1480.00000000' },
      ]);

      const dto = await service.get('wallet-1');

      expect(Object.keys(dto.balances)).toEqual([...CURRENCIES]);
      expect(dto.balances).toEqual({
        cNGN: '1480.00000000',
        cGHS: '0.00000000',
        cXAF: '0.00000000',
        USDx: '2.50000000',
        EURx: '0.86000000',
      });
      expect(dto.total_usd_equivalent).toBe('4.50000000');
      expect(dto.rate_source).toBe('fallback');
      expect(new Date(dto.rates_refreshed_at).toISOString()).toBe(dto.rates_refreshed_at);
      expect(dto).toMatchObject({ id: 'wallet-1', email: 'ada@example.com', phone: null });
    });

    it('reads a balance that has outgrown the 20-integer-digit request format', async () => {
      findOneBy.mockResolvedValue({
        id: 'wallet-1',
        email: 'a@b.co',
        phone: null,
        createdAt: CREATED_AT,
      });
      const huge = '123456789012345678901234567890.00000000'; // 30 integer digits, numeric(38,8) max
      findBy.mockResolvedValue([
        { currency: 'cNGN', amount: '0.00000000' },
        { currency: 'cGHS', amount: '0.00000000' },
        { currency: 'cXAF', amount: '0.00000000' },
        { currency: 'USDx', amount: huge },
        { currency: 'EURx', amount: '0.00000000' },
      ]);

      const dto = await service.get('wallet-1');
      expect(dto.balances.USDx).toBe(huge);
      expect(dto.total_usd_equivalent).toBe(huge);
    });

    it('fails loudly when a balance row is missing rather than inventing a zero', async () => {
      findOneBy.mockResolvedValue({
        id: 'wallet-1',
        email: 'a@b.co',
        phone: null,
        createdAt: CREATED_AT,
      });
      findBy.mockResolvedValue([]);
      await expect(service.get('wallet-1')).rejects.toThrow(/no cNGN balance row/);
    });
  });
});

describe('uniqueViolationField', () => {
  it('names the field for the two wallet unique constraints', () => {
    expect(uniqueViolationField(pgError('23505', 'UQ_wallets_email'))).toBe('email');
    expect(uniqueViolationField(pgError('23505', 'UQ_wallets_phone'))).toBe('phone');
  });

  it('is undefined for other constraints, other codes and non-database errors', () => {
    expect(uniqueViolationField(pgError('23505', 'PK_wallets'))).toBeUndefined();
    expect(uniqueViolationField(pgError('23514', 'UQ_wallets_email'))).toBeUndefined();
    expect(uniqueViolationField(new Error('23505'))).toBeUndefined();
    expect(uniqueViolationField(undefined)).toBeUndefined();
  });
});
