import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootApp } from './app';

describe('openapi.json (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('matches the document the running app serves; run `yarn openapi` if this fails', async () => {
    const committed: unknown = JSON.parse(
      readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'),
    );
    const res = await request(app.getHttpServer()).get('/docs-json').expect(200);

    expect(res.body).toEqual(committed);
  });
});
