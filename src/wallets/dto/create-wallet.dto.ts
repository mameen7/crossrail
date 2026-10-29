import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Digits, optionally separated by single spaces or dashes, 7 to 15 digits
 * in all, optional leading `+`. Normalization strips the separators.
 */
export const PHONE_PATTERN = /^\+?[0-9](?:[ -]?[0-9]){6,14}$/;

/** Surrounding whitespace is transport noise; strip it before validating. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateWalletDto {
  @ApiPropertyOptional({
    example: 'ada@example.com',
    description: 'Stored lowercased. At least one of email or phone is required.',
  })
  @Transform(trim)
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({
    example: '+234 800-000-0000',
    description:
      'Digits with optional spaces or dashes and an optional leading +; stored with separators stripped. At least one of email or phone is required.',
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'phone must be 7 to 15 digits, optionally separated by spaces or dashes',
  })
  phone?: string | null;
}
