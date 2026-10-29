import { Column, Entity, PrimaryColumn } from 'typeorm';
import { numericString } from '../common/numeric-string.transformer';

/**
 * Persisted cache of live provider fetches. Fallback rates are an in-code
 * constant (`FALLBACK_RATES`) and are never written here, so a live upsert can
 * never overwrite the last-resort tier.
 */
@Entity({ name: 'fx_rates' })
export class FxRate {
  @PrimaryColumn({ name: 'base_currency', type: 'text' })
  baseCurrency!: string;

  @PrimaryColumn({ name: 'quote_currency', type: 'text' })
  quoteCurrency!: string;

  @Column({ type: 'numeric', precision: 38, scale: 18, transformer: numericString })
  rate!: string;

  /** Always `live` for stored rows. */
  @Column({ type: 'text' })
  source!: string;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;
}
