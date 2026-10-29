import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  MethodNotAllowedException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ApiError, ERROR_CODES } from './api-error';
import { ApiExceptionFilter, toErrorResponse } from './api-exception.filter';

describe('toErrorResponse', () => {
  it('renders an ApiError with its code, message and details', () => {
    expect(toErrorResponse(ApiError.walletExists('email'))).toEqual({
      status: 409,
      body: {
        error: {
          code: 'WALLET_EXISTS',
          message: 'A wallet with this email already exists',
          details: { field: 'email' },
        },
      },
    });
  });

  it('omits details when an ApiError has none', () => {
    const { body } = toErrorResponse(
      new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'INSUFFICIENT_FUNDS', 'Not enough cNGN'),
    );
    expect(body).toEqual({ error: { code: 'INSUFFICIENT_FUNDS', message: 'Not enough cNGN' } });
    expect('details' in body.error).toBe(false);
  });

  it("maps Nest's 404 to NOT_FOUND", () => {
    expect(toErrorResponse(new NotFoundException('Cannot GET /api/v1/nope'))).toEqual({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Cannot GET /api/v1/nope' } },
    });
  });

  it('maps a generic 400 to 422 VALIDATION_ERROR (400 is reserved for IDEMPOTENCY_KEY_REQUIRED)', () => {
    expect(toErrorResponse(new BadRequestException('Unexpected end of JSON input'))).toEqual({
      status: 422,
      body: { error: { code: 'VALIDATION_ERROR', message: 'Unexpected end of JSON input' } },
    });
  });

  it('joins array messages from a Nest exception response', () => {
    const exception = new HttpException({ message: ['a', 'b'] }, HttpStatus.UNPROCESSABLE_ENTITY);
    expect(toErrorResponse(exception).body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'a; b',
    });
  });

  it('maps every other 4xx to 422 VALIDATION_ERROR so only spec codes are ever emitted', () => {
    for (const exception of [
      new MethodNotAllowedException(),
      new PayloadTooLargeException('request entity too large'),
      new UnsupportedMediaTypeException(),
    ]) {
      const { status, body } = toErrorResponse(exception);
      expect(status).toBe(422);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(ERROR_CODES).toContain(body.error.code);
    }
  });

  it('masks every 5xx as INTERNAL_ERROR without leaking the original message', () => {
    for (const exception of [
      new Error('connection to server at "postgres" failed'),
      new InternalServerErrorException('secret detail'),
      'a string',
      undefined,
    ]) {
      expect(toErrorResponse(exception)).toEqual({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      });
    }
  });
});

describe('ApiExceptionFilter', () => {
  it('writes a raw thrown Error as 500 INTERNAL_ERROR in the envelope, with no message or stack', () => {
    const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    const raw = new Error('relation "secret_table" does not exist');

    new ApiExceptionFilter().catch(raw, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    const written = JSON.stringify(json.mock.calls[0]);
    expect(written).not.toContain('secret_table');
    expect(written).not.toContain('at ');
    // The stack is kept, but only in the server log.
    expect(logError).toHaveBeenCalledWith('Unhandled exception', raw.stack);
    logError.mockRestore();
  });
});
