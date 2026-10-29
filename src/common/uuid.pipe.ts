import { ArgumentMetadata, Injectable, ParseUUIDPipe } from '@nestjs/common';
import { ApiError } from './api-error';

/**
 * Path-parameter UUID validation. Without a pipe, a malformed id reaches
 * Postgres and surfaces as a 500 (`invalid input syntax for type uuid`). The
 * global filter would already turn a plain `ParseUUIDPipe` 400 into a 422,
 * but this one also carries the `{ field, messages }` details every other
 * validation failure has. Every route with a UUID path parameter uses it.
 *
 * The id is also lowercased: UUIDs are case-insensitive and Postgres stores
 * them lowercase, so without this one wallet could appear under two string
 * keys in lock ordering, equality checks and request hashes.
 */
@Injectable()
export class UuidPipe extends ParseUUIDPipe {
  constructor() {
    super({
      exceptionFactory: () =>
        ApiError.validation('Request validation failed', [
          { field: 'id', messages: ['id must be a UUID'] },
        ]),
    });
  }

  override async transform(value: string, metadata: ArgumentMetadata): Promise<string> {
    const id: unknown = await super.transform(value, metadata);
    if (typeof id !== 'string') {
      // Only reachable with `optional: true`, which this pipe never sets.
      throw new Error('UuidPipe: ParseUUIDPipe did not yield a string');
    }
    return id.toLowerCase();
  }
}
