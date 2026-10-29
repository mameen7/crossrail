import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { HealthResponseDto } from '../src/health/health.dto';

describe('GET /api/v1/health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with the database reported up', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    const body = res.body as HealthResponseDto;

    expect(body).toMatchObject({ status: 'ok', checks: { database: 'up' } });
    expect(typeof body.timestamp).toBe('string');
  });

  it('serves the Swagger UI at /docs', async () => {
    await request(app.getHttpServer()).get('/docs').expect(200);
  });
});
