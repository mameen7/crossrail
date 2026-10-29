import { Injectable, ParseUUIDPipe } from '@nestjs/common';
import { ApiError } from './api-error';

/**
 * Path-parameter UUID validation. Without a pipe, a malformed id reaches
 * Postgres and surfaces as a 500 (`invalid input syntax for type uuid`). The
 * global filter would already turn a plain `ParseUUIDPipe` 400 into a 422,
 * but this one also carries the `{ field, messages }` details every other
 * validation failure has. Every route with a UUID path parameter uses it.
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
}
