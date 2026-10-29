import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ApiError } from '../common/api-error';
import { CURRENCIES, Currency } from '../common/currency';
import { parseAmount, toAmountString } from '../common/money';
import { usdEquivalent } from '../fx/pricing';
import { RatesSource } from '../fx/rates-source';
import { Balance } from './balance.entity';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { BalancesDto, WalletBalancesDto, WalletDto } from './dto/wallet.dto';
import { normalizeEmail, normalizePhone } from './normalize';
import { Wallet } from './wallet.entity';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

const UNIQUE_CONSTRAINT_FIELD: Readonly<Record<string, 'email' | 'phone'>> = {
  UQ_wallets_email: 'email',
  UQ_wallets_phone: 'phone',
};

@Injectable()
export class WalletsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Wallet) private readonly wallets: Repository<Wallet>,
    @InjectRepository(Balance) private readonly balances: Repository<Balance>,
    private readonly rates: RatesSource,
  ) {}

  /**
   * Inserts the wallet and its five zero balance rows in one transaction.
   * Duplicates are detected by the unique constraints alone (no
   * SELECT-then-INSERT), so two concurrent creates with the same contact
   * yield exactly one wallet and one 409.
   */
  async create(input: CreateWalletDto): Promise<WalletDto> {
    const email = input.email == null ? null : normalizeEmail(input.email);
    const phone = input.phone == null ? null : normalizePhone(input.phone);
    if (email === null && phone === null) {
      throw ApiError.validation('At least one of email or phone is required', [
        { field: 'email', messages: ['at least one of email or phone is required'] },
        { field: 'phone', messages: ['at least one of email or phone is required'] },
      ]);
    }

    try {
      const wallet = await this.dataSource.transaction(async (em) => {
        const created = await em.save(em.create(Wallet, { email, phone }));
        const updatedAt = new Date();
        await em.insert(
          Balance,
          CURRENCIES.map((currency) => ({
            walletId: created.id,
            currency,
            amount: '0',
            updatedAt,
          })),
        );
        return created;
      });
      return toWalletDto(wallet);
    } catch (err) {
      const field = uniqueViolationField(err);
      if (field !== undefined) {
        throw ApiError.walletExists(field);
      }
      throw err;
    }
  }

  async get(id: string): Promise<WalletBalancesDto> {
    const wallet = await this.wallets.findOneBy({ id });
    if (wallet === null) {
      throw ApiError.walletNotFound(id);
    }
    // Independent reads; once phase 3 binds a live provider (3s timeout) its
    // latency overlaps the balance query instead of adding to it.
    const [rows, snapshot] = await Promise.all([
      this.balances.findBy({ walletId: id }),
      this.rates.getSnapshot(),
    ]);

    const byCurrency = new Map<Currency, string>(rows.map((r) => [r.currency, r.amount]));
    const balances = {} as BalancesDto;
    for (const currency of CURRENCIES) {
      const amount = byCurrency.get(currency);
      if (amount === undefined) {
        // Creation inserts all five rows, so this is a data-integrity failure, not a 4xx.
        throw new Error(`Wallet ${id} has no ${currency} balance row`);
      }
      balances[currency] = toAmountString(parseAmount(amount));
    }

    return {
      ...toWalletDto(wallet),
      balances,
      total_usd_equivalent: usdEquivalent(
        snapshot.table,
        CURRENCIES.map((currency) => ({ currency, amount: balances[currency] })),
      ),
      rate_source: snapshot.source,
      rates_refreshed_at: snapshot.fetchedAt.toISOString(),
    };
  }
}

function toWalletDto(wallet: Wallet): WalletDto {
  return {
    id: wallet.id,
    email: wallet.email,
    phone: wallet.phone,
    created_at: wallet.createdAt.toISOString(),
  };
}

/** Which unique constraint a failed insert hit, if that is what failed. */
export function uniqueViolationField(err: unknown): 'email' | 'phone' | undefined {
  if (!(err instanceof QueryFailedError)) {
    return undefined;
  }
  const driver = err.driverError as { code?: unknown; constraint?: unknown };
  if (driver.code !== UNIQUE_VIOLATION || typeof driver.constraint !== 'string') {
    return undefined;
  }
  return UNIQUE_CONSTRAINT_FIELD[driver.constraint];
}
