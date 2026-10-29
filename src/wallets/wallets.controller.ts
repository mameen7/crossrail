import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/api-error.dto';
import { UuidPipe } from '../common/uuid.pipe';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletBalancesDto, WalletDto } from './dto/wallet.dto';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a wallet', description: 'One wallet per email or phone.' })
  @ApiCreatedResponse({ type: WalletDto })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description: 'WALLET_EXISTS: a wallet with this email or phone already exists',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR: invalid email or phone, or neither supplied',
  })
  create(@Body() body: CreateWalletDto): Promise<WalletDto> {
    return this.wallets.create(body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a wallet and its balances',
    description: 'All five balances plus their USD equivalent at the current rate snapshot.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: WalletBalancesDto })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto, description: 'WALLET_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR: id is not a UUID',
  })
  get(@Param('id', UuidPipe) id: string): Promise<WalletBalancesDto> {
    return this.wallets.get(id);
  }
}
