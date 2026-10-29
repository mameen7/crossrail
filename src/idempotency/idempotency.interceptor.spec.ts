import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { ApiError } from '../common/api-error';
import {
  IdempotencyInterceptor,
  IdempotencyReq,
  readIdempotencyKey,
} from './idempotency.interceptor';
import { IDEMPOTENT_ENDPOINT } from './idempotent.decorator';
import { IdempotencyRequest } from './idempotency.service';

const ENDPOINT = 'POST /wallets/:id/deposits';

interface FakeHttp {
  req: { header: (name: string) => string | undefined };
  res: { status: jest.Mock; setHeader: jest.Mock };
}

function fakeContext(
  endpoint: string | undefined,
  headers: Record<string, string>,
): { context: ExecutionContext; http: FakeHttp } {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const http: FakeHttp = {
    req: { header: (name) => lower[name.toLowerCase()] },
    res: { status: jest.fn(), setHeader: jest.fn() },
  };
  const handler = (): void => undefined;
  if (endpoint !== undefined) {
    Reflect.defineMetadata(IDEMPOTENT_ENDPOINT, endpoint, handler);
  }
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => http.req, getResponse: () => http.res }),
  } as unknown as ExecutionContext;
  return { context, http };
}

const next = (result: unknown): CallHandler => ({ handle: () => of(result) });

/** Runs `fn`, expects it to throw an ApiError, and returns it for assertions. */
function thrownApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected an ApiError to be thrown');
}

/** Resolves what `@IdempotencyReq()` would inject for this context. */
function injectedRequest(context: ExecutionContext): IdempotencyRequest {
  // createParamDecorator stores the factory under this metadata key; calling
  // it directly is the only way to exercise it without a running app.
  class Probe {
    handler(@IdempotencyReq() _req: IdempotencyRequest): void {
      void _req;
    }
  }
  const metadata = Reflect.getMetadata('__routeArguments__', Probe, 'handler') as Record<
    string,
    { factory: (data: unknown, ctx: ExecutionContext) => IdempotencyRequest }
  >;
  const [entry] = Object.values(metadata);
  if (entry === undefined) {
    throw new Error('param decorator metadata missing');
  }
  return entry.factory(undefined, context);
}

describe('IdempotencyInterceptor', () => {
  const interceptor = new IdempotencyInterceptor(new Reflector());

  it('passes a route without @Idempotent through untouched, header or not', async () => {
    const { context, http } = fakeContext(undefined, {});
    const out = await lastValueFrom(interceptor.intercept(context, next({ plain: true })));
    expect(out).toEqual({ plain: true });
    expect(http.res.status).not.toHaveBeenCalled();
  });

  it('rejects a missing key with 400 IDEMPOTENCY_KEY_REQUIRED before the handler runs', () => {
    const { context } = fakeContext(ENDPOINT, {});
    const handle = jest.fn();
    expect(thrownApiError(() => interceptor.intercept(context, { handle }))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      status: 400,
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a key over 255 characters with 422 VALIDATION_ERROR naming the header', () => {
    const { context } = fakeContext(ENDPOINT, { 'Idempotency-Key': 'k'.repeat(256) });
    expect(thrownApiError(() => interceptor.intercept(context, next({})))).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 422,
      details: [{ field: 'Idempotency-Key', messages: [expect.stringContaining('255')] }],
    });
  });

  it('exposes the key (case-insensitive header) and the endpoint to @IdempotencyReq()', async () => {
    const { context } = fakeContext(ENDPOINT, { 'idempotency-key': 'k'.repeat(255) });

    await lastValueFrom(
      interceptor.intercept(context, next({ status: 201, body: {}, replayed: false })),
    );

    expect(injectedRequest(context)).toEqual({ key: 'k'.repeat(255), endpoint: ENDPOINT });
  });

  it('unwraps a fresh response: stored status, body only, no replay header', async () => {
    const { context, http } = fakeContext(ENDPOINT, { 'Idempotency-Key': 'k' });
    const out = await lastValueFrom(
      interceptor.intercept(context, next({ status: 201, body: { id: 'tx' }, replayed: false })),
    );
    expect(out).toEqual({ id: 'tx' });
    expect(http.res.status).toHaveBeenCalledWith(201);
    expect(http.res.setHeader).not.toHaveBeenCalled();
  });

  it('unwraps a replayed response with the stored status and Idempotent-Replay: true', async () => {
    const { context, http } = fakeContext(ENDPOINT, { 'Idempotency-Key': 'k' });
    const out = await lastValueFrom(
      interceptor.intercept(context, next({ status: 201, body: { id: 'tx' }, replayed: true })),
    );
    expect(out).toEqual({ id: 'tx' });
    expect(http.res.status).toHaveBeenCalledWith(201);
    expect(http.res.setHeader).toHaveBeenCalledWith('Idempotent-Replay', 'true');
  });

  it('fails loudly when a decorated handler returns something other than an IdempotentResponse', async () => {
    const { context } = fakeContext(ENDPOINT, { 'Idempotency-Key': 'k' });
    await expect(lastValueFrom(interceptor.intercept(context, next({ id: 'tx' })))).rejects.toThrow(
      /must return an IdempotentResponse/,
    );
  });

  it('@IdempotencyReq throws on a route the interceptor did not prepare', () => {
    const { context } = fakeContext(undefined, {});
    expect(() => injectedRequest(context)).toThrow(/without @Idempotent/);
  });
});

describe('readIdempotencyKey', () => {
  it('returns the key as sent, including a 255-char one', () => {
    expect(readIdempotencyKey('abc')).toBe('abc');
    expect(readIdempotencyKey('x'.repeat(255))).toBe('x'.repeat(255));
  });

  it('treats an empty header like a missing one', () => {
    expect(thrownApiError(() => readIdempotencyKey('')).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(thrownApiError(() => readIdempotencyKey(undefined)).code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  });
});
