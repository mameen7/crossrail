import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, map } from 'rxjs';
import { ApiError } from '../common/api-error';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENT_ENDPOINT,
  IDEMPOTENT_REPLAY_HEADER,
} from './idempotent.decorator';
import { IdempotencyRequest, IdempotentResponse } from './idempotency.service';

/** Per-request context, keyed by the request object so nothing is bolted onto it. */
const REQUESTS = new WeakMap<object, IdempotencyRequest>();

/**
 * Enforces the `Idempotency-Key` header on routes decorated with
 * `@Idempotent` and turns their `IdempotentResponse` into the HTTP response.
 * Registered globally; undecorated routes pass through untouched.
 *
 * Runs before the pipes, so a missing key is a 400 before any validation
 * 422. The request hash is not computed here: it is the service's job, over
 * the validated DTO, so that stripped unknown properties and UUID casing
 * cannot make a retry look like a different request.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const endpoint = this.reflector.get<string | undefined>(
      IDEMPOTENT_ENDPOINT,
      context.getHandler(),
    );
    if (endpoint === undefined) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    REQUESTS.set(req, { key: readIdempotencyKey(req.header(IDEMPOTENCY_KEY_HEADER)), endpoint });

    return next.handle().pipe(
      map((result: unknown) => {
        if (!isIdempotentResponse(result)) {
          throw new Error(`Handler for ${endpoint} must return an IdempotentResponse`);
        }
        // The one place the status of an idempotent route is decided: fresh
        // or replayed, it is whatever the service stored.
        res.status(result.status);
        if (result.replayed) {
          res.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
        }
        return result.body;
      }),
    );
  }
}

/** Missing or empty is the API's one 400; too long is a validation 422. */
export function readIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw ApiError.idempotencyKeyRequired();
  }
  if (raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw ApiError.validation('Request validation failed', [
      {
        field: IDEMPOTENCY_KEY_HEADER,
        messages: [
          `${IDEMPOTENCY_KEY_HEADER} must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        ],
      },
    ]);
  }
  return raw;
}

function isIdempotentResponse(value: unknown): value is IdempotentResponse<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof value.status === 'number' &&
    'replayed' in value &&
    typeof value.replayed === 'boolean' &&
    'body' in value
  );
}

/**
 * Injects the `IdempotencyRequest` (key and endpoint) the interceptor built
 * for this request. Only valid on a handler decorated with `@Idempotent`.
 */
export const IdempotencyReq = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IdempotencyRequest => {
    const req = context.switchToHttp().getRequest<object>();
    const request = REQUESTS.get(req);
    if (request === undefined) {
      throw new Error('@IdempotencyReq() used on a route without @Idempotent()');
    }
    return request;
  },
);
