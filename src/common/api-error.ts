import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error codes from SPEC.md (`INTERNAL_ERROR` is the 500 for unhandled
 * exceptions), plus `NOT_FOUND`, which the filter emits for unknown routes.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'WALLET_EXISTS',
  'WALLET_NOT_FOUND',
  'UNSUPPORTED_CURRENCY',
  'SAME_CURRENCY_SWAP',
  'INSUFFICIENT_FUNDS',
  'AMOUNT_TOO_SMALL',
  'SELF_TRANSFER',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'TRANSACTION_NOT_FOUND',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The single error envelope every error response carries. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * The one exception type business code throws. It carries the spec's error
 * code so the global filter can render the envelope without guessing.
 */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message, status);
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      error.details = this.details;
    }
    return { error };
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_ERROR', message, details);
  }

  static walletExists(field: 'email' | 'phone'): ApiError {
    return new ApiError(
      HttpStatus.CONFLICT,
      'WALLET_EXISTS',
      `A wallet with this ${field} already exists`,
      {
        field,
      },
    );
  }

  static walletNotFound(id: string): ApiError {
    return new ApiError(HttpStatus.NOT_FOUND, 'WALLET_NOT_FOUND', `Wallet ${id} not found`, { id });
  }

  static unsupportedCurrency(field: string, value: string): ApiError {
    return new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'UNSUPPORTED_CURRENCY',
      `Unsupported currency ${JSON.stringify(value)}`,
      { field, value },
    );
  }

  /** `available` and `requested` are 8 dp amount strings. */
  static insufficientFunds(
    walletId: string,
    currency: string,
    available: string,
    requested: string,
  ): ApiError {
    return new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'INSUFFICIENT_FUNDS',
      `Insufficient ${currency} balance in wallet ${walletId}`,
      { wallet_id: walletId, currency, available, requested },
    );
  }

  /** The one 400 in the API. */
  static idempotencyKeyRequired(): ApiError {
    return new ApiError(
      HttpStatus.BAD_REQUEST,
      'IDEMPOTENCY_KEY_REQUIRED',
      'The Idempotency-Key header is required for this endpoint',
    );
  }

  static idempotencyKeyReused(key: string, endpoint: string): ApiError {
    return new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request on this endpoint',
      { key, endpoint },
    );
  }
}
