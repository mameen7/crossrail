import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves two rules the application already follows into the schema:
 *
 * - party shape: deposits and swaps name only their owner (`wallet_id`);
 *   transfers name only a sender and a receiver. Unknown types are left to
 *   `CHK_transactions_type`, so each bad row trips exactly one constraint.
 * - a transfer's sender and receiver differ (the API's 422 SELF_TRANSFER).
 *
 * Together they make a wallet's three history roles disjoint, which the
 * history query also guarantees on its own.
 */
export class TransactionPartyChecks1793373004957 implements MigrationInterface {
  name = 'TransactionPartyChecks1793373004957';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions"
        ADD CONSTRAINT "CHK_transactions_party_shape" CHECK (
          CASE "type"
            WHEN 'transfer' THEN "wallet_id" IS NULL
                             AND "sender_wallet_id" IS NOT NULL
                             AND "receiver_wallet_id" IS NOT NULL
            ELSE "wallet_id" IS NOT NULL
             AND "sender_wallet_id" IS NULL
             AND "receiver_wallet_id" IS NULL
          END
        ),
        ADD CONSTRAINT "CHK_transactions_distinct_parties"
          CHECK ("sender_wallet_id" <> "receiver_wallet_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions"
        DROP CONSTRAINT "CHK_transactions_distinct_parties",
        DROP CONSTRAINT "CHK_transactions_party_shape"
    `);
  }
}
