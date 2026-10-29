import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError, ApiErrorBody } from './api-error';

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
}

/**
 * Maps any thrown value to the single error envelope (hard rule 6).
 *
 * - `ApiError`: rendered as-is; this is what business code throws.
 * - Other `HttpException`s (Nest's own, e.g. an unknown route, or the body
 *   parser's malformed-JSON 400, oversized-body 413 or unsupported-charset
 *   415): a 404 becomes `NOT_FOUND`; any 5xx is masked as `INTERNAL_ERROR`;
 *   every other 4xx becomes 422 `VALIDATION_ERROR`, following the spec's
 *   "422 for everything else" (400 is reserved for `IDEMPOTENCY_KEY_REQUIRED`).
 *   So the codes the API emits are exactly `ERROR_CODES`.
 * - Anything else: 500 `INTERNAL_ERROR` with a generic message, never the
 *   original text or stack (SPEC.md: unhandled exceptions only). The stack
 *   goes to the server log instead.
 */
export function toErrorResponse(exception: unknown): ErrorResponse {
  if (exception instanceof ApiError) {
    return { status: exception.getStatus(), body: exception.toBody() };
  }

  if (exception instanceof HttpException) {
    const status: number = exception.getStatus();
    if (status >= 500) {
      return internalError();
    }
    const message = extractMessage(exception);
    if (status === 404) {
      return { status, body: envelope('NOT_FOUND', message) };
    }
    return { status: 422, body: envelope('VALIDATION_ERROR', message) };
  }

  return internalError();
}

function internalError(): ErrorResponse {
  return { status: 500, body: envelope('INTERNAL_ERROR', 'Internal server error') };
}

function envelope(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

function extractMessage(exception: HttpException): string {
  const response: unknown = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  if (response !== null && typeof response === 'object' && 'message' in response) {
    const message: unknown = response.message;
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message)) {
      return message.map(String).join('; ');
    }
  }
  return exception.message;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = toErrorResponse(exception);
    if (status >= 500) {
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error('Unhandled exception', stack);
    }
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }
}
