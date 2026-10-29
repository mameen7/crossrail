import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { isAmountString, parseAmount } from './money';

/** True for a request amount string that matches the spec format and is greater than zero. */
export function isPositiveAmount(value: unknown): value is string {
  return isAmountString(value) && parseAmount(value).greaterThan(0);
}

/**
 * class-validator decorator for request amounts: a string matching
 * `^[0-9]{1,20}(\.[0-9]{1,8})?$` and greater than zero. A JS number, a sign,
 * exponent notation, more than 8 dp or zero all fail (hard rule 1).
 */
export function IsAmount(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isAmount',
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate: (value: unknown) => isPositiveAmount(value),
        defaultMessage: (args?: ValidationArguments) =>
          `${args?.property ?? 'amount'} must be a positive decimal string with at most 20 integer digits and 8 decimal places`,
      },
    });
  };
}
