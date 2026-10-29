import { ValidationError, ValidationPipe } from '@nestjs/common';
import { ApiError } from './api-error';

export interface FieldErrorDetail {
  field: string;
  messages: string[];
}

/** Flattens class-validator's error tree into `{ field, messages }` rows. */
export function flattenValidationErrors(
  errors: ValidationError[],
  parent?: string,
): FieldErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parent === undefined ? error.property : `${parent}.${error.property}`;
    const own: FieldErrorDetail[] =
      error.constraints === undefined
        ? []
        : [{ field, messages: Object.values(error.constraints) }];
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/**
 * The global request validation pipe: unknown properties are stripped
 * (`whitelist`), payloads are transformed into their DTO classes, and failures
 * are 422 `VALIDATION_ERROR` (not Nest's default 400) with one detail row per
 * offending field.
 */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    errorHttpStatusCode: 422,
    // Implicit conversion is off on purpose: it would coerce amount strings
    // into JS numbers wherever a DTO property was typed loosely (hard rule 1).
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors: ValidationError[]) =>
      ApiError.validation('Request validation failed', flattenValidationErrors(errors)),
  });
}
