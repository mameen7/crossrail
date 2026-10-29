import { ApiError } from './api-error';
import { Currency, isCurrency } from './currency';

/**
 * Narrows a request field to a supported currency or throws the spec's 422
 * `UNSUPPORTED_CURRENCY`. Request DTOs only check that the field is a string,
 * so that an unknown code gets this code rather than `VALIDATION_ERROR`.
 */
export function requireCurrency(value: string, field: string): Currency {
  if (!isCurrency(value)) {
    throw ApiError.unsupportedCurrency(field, value);
  }
  return value;
}
