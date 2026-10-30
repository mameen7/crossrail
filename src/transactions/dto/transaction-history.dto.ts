import { ApiProperty } from '@nestjs/swagger';
import { TransactionDto } from './transaction.dto';

/** One page of a wallet's history, newest first. */
export class TransactionHistoryDto {
  @ApiProperty({ type: [TransactionDto] })
  items!: TransactionDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    example:
      'MjAyNi0xMC0yOVQxMjowMDowMC4xMjM0NTZaX2M5MWQ0ZjJhLThiM2UtNGQxYy05ZjZhLTJlN2I1YzhkOWEwZg',
    description: 'Pass as cursor to fetch the next page; null on the last page',
  })
  next_cursor!: string | null;
}
