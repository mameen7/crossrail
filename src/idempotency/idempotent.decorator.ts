import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBadRequestResponse, ApiHeader, ApiResponseOptions } from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/api-error.dto';

/** Reflector key under which `@Idempotent` stores the endpoint name. */
export const IDEMPOTENT_ENDPOINT = 'crossrail:idempotent-endpoint';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replay';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * Swagger documentation of the `Idempotent-Replay` response header. Swagger
 * keeps one entry per status code, so this goes on the route's own success
 * response decorator next to its body type:
 * `@ApiCreatedResponse({ type: ..., headers: IDEMPOTENT_RESPONSE_HEADERS })`.
 */
export const IDEMPOTENT_RESPONSE_HEADERS: NonNullable<ApiResponseOptions['headers']> = {
  [IDEMPOTENT_REPLAY_HEADER]: {
    description:
      '"true" when this is the stored response of an earlier request with the same key and body; absent otherwise',
    schema: { type: 'string', enum: ['true'] },
  },
};

/**
 * The 422 codes the idempotency machinery itself produces. For the same
 * one-entry-per-status reason, each route appends this to the description of
 * its own `@ApiUnprocessableEntityResponse` after its business codes.
 */
export const IDEMPOTENCY_422_CODES =
  'IDEMPOTENCY_KEY_REUSED: this key was already used with a different request on this endpoint; ' +
  `VALIDATION_ERROR: Idempotency-Key over ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`;

/**
 * Opts a mutating route into the idempotency machinery: the interceptor then
 * requires the `Idempotency-Key` header and turns the handler's
 * `IdempotentResponse` into the HTTP response, replay header included.
 * `endpoint` is the row's `idempotency_keys.endpoint`, in the spec's form,
 * e.g. `POST /wallets/:id/swaps`. The handler takes an `@IdempotencyReq()`
 * parameter, hashes its validated input, and hands both to
 * `IdempotencyService.execute`.
 *
 * Also documents what every idempotent route shares: the request header and
 * the 400 for a missing key.
 */
export function Idempotent(endpoint: string): MethodDecorator {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_ENDPOINT, endpoint),
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: true,
      description: `Any string up to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters, unique per request. Resending the same key with the same body returns the stored response.`,
      schema: { type: 'string', maxLength: IDEMPOTENCY_KEY_MAX_LENGTH },
    }),
    ApiBadRequestResponse({
      type: ApiErrorResponseDto,
      description: 'IDEMPOTENCY_KEY_REQUIRED: the Idempotency-Key header is missing',
    }),
  );
}
