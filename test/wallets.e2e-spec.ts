import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ApiErrorBody } from '../src/common/api-error';
import { CURRENCIES } from '../src/common/currency';
import { WalletBalancesDto, WalletDto } from '../src/wallets/dto/wallet.dto';
import { truncateAll } from './db';

const ZERO = '0.00000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('wallets (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
    await truncateAll(db);
  });

  afterAll(async () => {
    await truncateAll(db);
    await app.close();
  });

  describe('POST /api/v1/wallets (scenario 1)', () => {
    it('creates a wallet with normalized contacts and five zero balance rows', async () => {
      const res = await api()
        .post('/api/v1/wallets')
        .send({ email: ' Ada@Example.COM ', phone: '+234 800-000-0001' })
        .expect(201);
      const body = res.body as WalletDto;

      expect(body.id).toMatch(UUID_RE);
      expect(body.email).toBe('ada@example.com');
      expect(body.phone).toBe('+2348000000001');
      expect(new Date(body.created_at).toISOString()).toBe(body.created_at);

      const rows: { currency: string; amount: string }[] = await db.query(
        'SELECT currency, amount FROM balances WHERE wallet_id = $1 ORDER BY currency',
        [body.id],
      );
      expect(rows).toEqual([...CURRENCIES].sort().map((currency) => ({ currency, amount: ZERO })));
    });

    it('creates email-only and phone-only wallets', async () => {
      await api().post('/api/v1/wallets').send({ email: 'email-only@example.com' }).expect(201);
      await api().post('/api/v1/wallets').send({ phone: '08000000002' }).expect(201);
    });

    it('returns 409 WALLET_EXISTS for a duplicate email, even in a different case', async () => {
      await api().post('/api/v1/wallets').send({ email: 'dup@example.com' }).expect(201);
      const res = await api()
        .post('/api/v1/wallets')
        .send({ email: 'DUP@example.com' })
        .expect(409);
      expect(res.body).toEqual({
        error: {
          code: 'WALLET_EXISTS',
          message: expect.stringContaining('email') as string,
          details: { field: 'email' },
        },
      });
    });

    it('returns 409 WALLET_EXISTS for a duplicate phone, even with different separators', async () => {
      await api().post('/api/v1/wallets').send({ phone: '+2348000000003' }).expect(201);
      const res = await api()
        .post('/api/v1/wallets')
        .send({ phone: '+234 800 000-0003' })
        .expect(409);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'WALLET_EXISTS',
        details: { field: 'phone' },
      });
    });

    it('does not persist a wallet when its phone collides but its email is new', async () => {
      await api().post('/api/v1/wallets').send({ phone: '+2348000000004' }).expect(201);
      await api()
        .post('/api/v1/wallets')
        .send({ email: 'never-stored@example.com', phone: '+2348000000004' })
        .expect(409);
      const rows: unknown[] = await db.query('SELECT 1 FROM wallets WHERE email = $1', [
        'never-stored@example.com',
      ]);
      expect(rows).toHaveLength(0);
    });

    it('returns 422 VALIDATION_ERROR when neither email nor phone is given', async () => {
      const res = await api().post('/api/v1/wallets').send({}).expect(422);
      const body = res.body as ApiErrorBody;
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'email' })]),
      );
    });

    it('returns 422 VALIDATION_ERROR for a malformed email or phone', async () => {
      const bad = await api().post('/api/v1/wallets').send({ email: 'not-an-email' }).expect(422);
      expect((bad.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'email', messages: ['email must be an email'] }],
      });
      await api().post('/api/v1/wallets').send({ phone: 'call me' }).expect(422);
    });

    it('strips unknown properties instead of persisting them', async () => {
      const res = await api()
        .post('/api/v1/wallets')
        .send({ email: 'extra@example.com', id: '00000000-0000-4000-8000-000000000000' })
        .expect(201);
      expect((res.body as WalletDto).id).not.toBe('00000000-0000-4000-8000-000000000000');
    });

    it('is race-safe: two concurrent creates with the same email yield one wallet and one 409', async () => {
      const email = 'race@example.com';
      const [a, b] = await Promise.all([
        api().post('/api/v1/wallets').send({ email }),
        api().post('/api/v1/wallets').send({ email }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);

      const wallets: { id: string }[] = await db.query('SELECT id FROM wallets WHERE email = $1', [
        email,
      ]);
      expect(wallets).toHaveLength(1);
      const balances: { n: string }[] = await db.query(
        'SELECT count(*)::text AS n FROM balances WHERE wallet_id = $1',
        [wallets[0]?.id],
      );
      expect(balances[0]?.n).toBe('5');
    });
  });

  describe('GET /api/v1/wallets/:id', () => {
    it('returns the wallet with five zero balances and a zero USD total', async () => {
      const created = await api()
        .post('/api/v1/wallets')
        .send({ email: 'read@example.com' })
        .expect(201);
      const { id } = created.body as WalletDto;

      const res = await api().get(`/api/v1/wallets/${id}`).expect(200);
      const body = res.body as WalletBalancesDto;

      expect(body).toMatchObject({
        id,
        email: 'read@example.com',
        phone: null,
        balances: { cNGN: ZERO, cGHS: ZERO, cXAF: ZERO, USDx: ZERO, EURx: ZERO },
        total_usd_equivalent: ZERO,
        rate_source: 'fallback',
      });
      expect(Object.keys(body.balances)).toEqual([...CURRENCIES]);
      expect(new Date(body.rates_refreshed_at).toISOString()).toBe(body.rates_refreshed_at);
    });

    it('prices non-zero balances into the USD total at the fallback rates', async () => {
      const created = await api()
        .post('/api/v1/wallets')
        .send({ email: 'priced@example.com' })
        .expect(201);
      const { id } = created.body as WalletDto;
      // No deposit endpoint until phase 4: set the balance directly.
      await db.query(
        `UPDATE balances SET amount = '2.5' WHERE wallet_id = $1 AND currency = 'USDx'`,
        [id],
      );

      const res = await api().get(`/api/v1/wallets/${id}`).expect(200);
      const body = res.body as WalletBalancesDto;
      expect(body.balances.USDx).toBe('2.50000000');
      expect(body.total_usd_equivalent).toBe('2.50000000');
    });

    it('still reads a wallet whose balance has more integer digits than a request may carry', async () => {
      const created = await api()
        .post('/api/v1/wallets')
        .send({ email: 'whale@example.com' })
        .expect(201);
      const { id } = created.body as WalletDto;
      const huge = '123456789012345678901234567890.00000001'; // 30 integer digits
      await db.query(`UPDATE balances SET amount = $2 WHERE wallet_id = $1 AND currency = 'USDx'`, [
        id,
        huge,
      ]);

      const res = await api().get(`/api/v1/wallets/${id}`).expect(200);
      const body = res.body as WalletBalancesDto;
      expect(body.balances.USDx).toBe(huge);
      expect(body.total_usd_equivalent).toBe(huge);
    });

    it('returns 404 WALLET_NOT_FOUND for an unknown id', async () => {
      const res = await api()
        .get('/api/v1/wallets/00000000-0000-4000-8000-000000000000')
        .expect(404);
      expect(res.body).toEqual({
        error: {
          code: 'WALLET_NOT_FOUND',
          message: expect.any(String) as string,
          details: { id: '00000000-0000-4000-8000-000000000000' },
        },
      });
    });

    it('returns 422 VALIDATION_ERROR for an id that is not a UUID', async () => {
      const res = await api().get('/api/v1/wallets/not-a-uuid').expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'id', messages: ['id must be a UUID'] }],
      });
    });
  });

  describe('error envelope on framework error paths', () => {
    it('wraps an unknown route as 404 NOT_FOUND', async () => {
      const res = await api().get('/api/v1/nope').expect(404);
      expect((res.body as ApiErrorBody).error).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('wraps an oversized JSON body as 422 VALIDATION_ERROR, not a bare 413', async () => {
      const res = await api()
        .post('/api/v1/wallets')
        .send({ email: `${'x'.repeat(200_000)}@example.com` })
        .expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('wraps a malformed JSON body as 422 VALIDATION_ERROR', async () => {
      const res = await api()
        .post('/api/v1/wallets')
        .set('Content-Type', 'application/json')
        .send('{"email": ')
        .expect(422);
      expect((res.body as ApiErrorBody).error).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
});
