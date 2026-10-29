import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** One wallet per email or phone. At least one contact is required. */
@Entity({ name: 'wallets' })
@Unique('UQ_wallets_email', ['email'])
@Unique('UQ_wallets_phone', ['phone'])
@Check('CHK_wallets_contact', '"email" IS NOT NULL OR "phone" IS NOT NULL')
export class Wallet {
  /** Postgres-generated via gen_random_uuid() (see typeorm.config.ts). */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stored lowercased. */
  @Column({ type: 'text', nullable: true })
  email!: string | null;

  /** Stored normalized (spaces and dashes stripped). */
  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
