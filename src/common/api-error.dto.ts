import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ERROR_CODES } from './api-error';

/** Swagger shape of the single error envelope. */
export class ApiErrorDto {
  @ApiProperty({ enum: ERROR_CODES, example: 'VALIDATION_ERROR' })
  code!: string;

  @ApiProperty({ example: 'Request validation failed' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Machine-readable context, e.g. one { field, messages } row per invalid field',
    example: [{ field: 'email', messages: ['email must be an email'] }],
  })
  details?: unknown;
}

export class ApiErrorResponseDto {
  @ApiProperty({ type: ApiErrorDto })
  error!: ApiErrorDto;
}
