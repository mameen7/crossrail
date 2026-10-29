import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { IsAmount } from '../../common/amount.validator';
import { CURRENCIES } from '../../common/currency';
import { AMOUNT_PATTERN } from '../../common/money';

export class CreateDepositDto {
  @ApiProperty({
    enum: CURRENCIES,
    example: 'cNGN',
    description: 'A supported stablecoin; anything else is 422 UNSUPPORTED_CURRENCY',
  })
  @IsString()
  @IsNotEmpty()
  currency!: string;

  @ApiProperty({
    example: '150000.00',
    pattern: AMOUNT_PATTERN.source,
    description: 'Positive decimal string: up to 20 integer digits and 8 decimal places',
  })
  @IsAmount()
  amount!: string;
}
