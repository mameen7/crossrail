import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { IsAmount } from '../../common/amount.validator';
import { CURRENCIES } from '../../common/currency';
import { AMOUNT_PATTERN } from '../../common/money';

/**
 * UUIDs are case-insensitive and Postgres stores them lowercase; lowercasing
 * here gives body ids the same normalization `UuidPipe` gives path ids, so one
 * wallet never appears under two strings in the self-transfer check, the lock
 * order or the request hash. A non-string is left for `@IsUUID` to reject.
 */
const lowercase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;

export class CreateTransferDto {
  @ApiProperty({ format: 'uuid', description: 'The wallet debited' })
  @Transform(lowercase)
  @IsUUID('all')
  sender_wallet_id!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The wallet credited; must differ from sender_wallet_id (422 SELF_TRANSFER)',
  })
  @Transform(lowercase)
  @IsUUID('all')
  receiver_wallet_id!: string;

  @ApiProperty({
    enum: CURRENCIES,
    example: 'cNGN',
    description:
      'The currency debited from the sender; anything but a supported stablecoin is 422 UNSUPPORTED_CURRENCY',
  })
  @IsString()
  @IsNotEmpty()
  source_currency!: string;

  @ApiProperty({
    example: '150000.00',
    pattern: AMOUNT_PATTERN.source,
    description:
      'Amount of source_currency to send. Positive decimal string: up to 20 integer digits and 8 decimal places',
  })
  @IsAmount()
  source_amount!: string;

  @ApiPropertyOptional({
    enum: CURRENCIES,
    example: 'USDx',
    description:
      'The currency credited to the receiver; defaults to source_currency. When it differs, the amount is converted at the current rate',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  destination_currency?: string;
}
