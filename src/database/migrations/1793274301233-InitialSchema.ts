import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The six tables from SPEC.md "Data model". Every money column is
 * numeric(38,8); FX rates are numeric(38,18). CHECK constraints, uniques,
 * composite PKs and the three history indexes are declared here so the
 * database enforces them regardless of application code.
 */
export class InitialSchema1793274301233 implements MigrationInterface {
  name = 'InitialSchema1793274301233';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // wallets: one per email or phone
    await queryRunner.query(`
      CREATE TABLE "wallets" (
        "id"         uuid        NOT NULL DEFAULT gen_random_uuid(),
        "email"      text        NULL,
        "phone"      text        NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallets"          PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallets_email"    UNIQUE ("email"),
        CONSTRAINT "UQ_wallets_phone"    UNIQUE ("phone"),
        CONSTRAINT "CHK_wallets_contact" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL)
      )
    `);

    // balances: one row per (wallet, currency); the row that gets locked
    await queryRunner.query(`
      CREATE TABLE "balances" (
        "wallet_id"  uuid          NOT NULL,
        "currency"   text          NOT NULL,
        "amount"     numeric(38,8) NOT NULL DEFAULT '0',
        "updated_at" timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_balances" PRIMARY KEY ("wallet_id", "currency"),
        CONSTRAINT "FK_balances_wallet"
          FOREIGN KEY ("wallet_id") REFERENCES "wallets" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "CHK_balances_currency"
          CHECK ("currency" IN ('cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx')),
        CONSTRAINT "CHK_balances_amount_non_negative" CHECK ("amount" >= 0)
      )
    `);

    // transactions: one row per business operation
    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id"                   uuid           NOT NULL DEFAULT gen_random_uuid(),
        "type"                 text           NOT NULL,
        "status"               text           NOT NULL DEFAULT 'completed',
        "wallet_id"            uuid           NULL,
        "sender_wallet_id"     uuid           NULL,
        "receiver_wallet_id"   uuid           NULL,
        "source_currency"      text           NOT NULL,
        "source_amount"        numeric(38,8)  NOT NULL,
        "destination_currency" text           NOT NULL,
        "destination_amount"   numeric(38,8)  NOT NULL,
        "fx_rate"              numeric(38,18) NOT NULL,
        "rate_source"          text           NOT NULL,
        "created_at"           timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_transactions_type" CHECK ("type" IN ('deposit', 'swap', 'transfer')),
        CONSTRAINT "CHK_transactions_source_amount_positive"      CHECK ("source_amount" > 0),
        CONSTRAINT "CHK_transactions_destination_amount_positive" CHECK ("destination_amount" > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_transactions_wallet_created" ON "transactions" ("wallet_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transactions_sender_created" ON "transactions" ("sender_wallet_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transactions_receiver_created" ON "transactions" ("receiver_wallet_id", "created_at" DESC)`,
    );

    // ledger_entries: signed rows; negative = debit, positive = credit
    await queryRunner.query(`
      CREATE TABLE "ledger_entries" (
        "id"             uuid          NOT NULL DEFAULT gen_random_uuid(),
        "transaction_id" uuid          NOT NULL,
        "wallet_id"      uuid          NOT NULL,
        "currency"       text          NOT NULL,
        "amount"         numeric(38,8) NOT NULL,
        "created_at"     timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ledger_entries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ledger_entries_transaction"
          FOREIGN KEY ("transaction_id") REFERENCES "transactions" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);

    // idempotency_keys: one row per attempted mutation
    await queryRunner.query(`
      CREATE TABLE "idempotency_keys" (
        "key"             text        NOT NULL,
        "endpoint"        text        NOT NULL,
        "request_hash"    text        NOT NULL,
        "response_status" integer     NULL,
        "response_body"   jsonb       NULL,
        "transaction_id"  uuid        NULL,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("key", "endpoint")
      )
    `);

    // fx_rates: persisted cache of live fetches (fallback rates live in code)
    await queryRunner.query(`
      CREATE TABLE "fx_rates" (
        "base_currency"  text           NOT NULL,
        "quote_currency" text           NOT NULL,
        "rate"           numeric(38,18) NOT NULL,
        "source"         text           NOT NULL,
        "fetched_at"     timestamptz    NOT NULL,
        CONSTRAINT "PK_fx_rates" PRIMARY KEY ("base_currency", "quote_currency")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse dependency order: children before the tables they reference.
    // Dropping a table drops its indexes, so none are listed separately.
    await queryRunner.query(`DROP TABLE "fx_rates"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE "ledger_entries"`);
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TABLE "balances"`);
    await queryRunner.query(`DROP TABLE "wallets"`);
  }
}
