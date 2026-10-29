import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/** Where an app under test fetches FX rates from, and how long it waits. */
export interface FxEnv {
  readonly url: string;
  readonly timeoutMs: number;
}

/**
 * Boots a fully configured app for an e2e suite. With `fx`, the provider
 * URL and timeout are written to this test file's own process.env before the
 * module compiles, which is when FxProvider reads them; without it the app
 * keeps the env.ts default (a blocked port, so the fallback chain runs with
 * no network). The app listens on a loopback port before any request, so
 * supertest never opens and closes the server itself and parallel requests
 * share one socket. Callers close it with `app.close()`.
 */
export async function bootApp(fx?: FxEnv): Promise<INestApplication<App>> {
  if (fx !== undefined) {
    process.env.FX_PROVIDER_URL = fx.url;
    process.env.FX_TIMEOUT_MS = String(fx.timeoutMs);
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return app;
}
