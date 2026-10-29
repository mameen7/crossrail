import { ValueTransformer } from 'typeorm';

/**
 * Column transformer for every `numeric` column. Postgres `numeric` already
 * round-trips through the `pg` driver as a string, so this is a guard, not a
 * conversion: a JS `number` is refused in both directions so float precision
 * loss can never reach the database or leak out of it (hard rule 1).
 */
export const numericString: ValueTransformer = {
  to(value: unknown): unknown {
    assertNotNumber(value, 'write');
    return value;
  },
  from(value: unknown): unknown {
    assertNotNumber(value, 'read');
    return value;
  },
};

function assertNotNumber(value: unknown, direction: 'read' | 'write'): void {
  if (typeof value === 'number') {
    throw new TypeError(
      `Refusing to ${direction} a JS number as a numeric column value; amounts must be strings`,
    );
  }
}
