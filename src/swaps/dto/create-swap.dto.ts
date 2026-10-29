import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { IsAmount } from '../../common/amount.validator';
import { CURRENCIES } from '../../common/currency';
import { AMOUNT_PATTERN } from '../../common/money';

export class CreateSwapDto {
  @ApiProperty({
    enum: CURRENCIES,
    example: 'cNGN',
    description:
      'The currency debited; anything but a supported stablecoin is 422 UNSUPPORTED_CURRENCY',
  })
  @IsString()
  @IsNotEmpty()
  from_currency!: string;

  @ApiProperty({
    enum: CURRENCIES,
    example: 'USDx',
    description:
      'The currency credited; must differ from from_currency (422 SAME_CURRENCY_SWAP otherwise)',
  })
  @IsString()
  @IsNotEmpty()
  to_currency!: string;

  @ApiProperty({
    example: '150000.00',
    pattern: AMOUNT_PATTERN.source,
    description:
      'Amount of from_currency to swap. Positive decimal string: up to 20 integer digits and 8 decimal places',
  })
  @IsAmount()
  amount!: string;
}
