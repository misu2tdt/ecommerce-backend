import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentEventResolution1787418000000 implements MigrationInterface {
  name = 'AddPaymentEventResolution1787418000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Only adds nullable columns: existing rows are not touched.
    await queryRunner.query(
      `ALTER TABLE "payment_events" ADD "resolvedAt" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" ADD "resolvedByUserId" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" ADD "resolutionNote" character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" ADD CONSTRAINT "CHK_payment_events_resolution" CHECK ("resolvedAt" IS NOT NULL OR ("resolvedByUserId" IS NULL AND "resolutionNote" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" ADD CONSTRAINT "FK_payment_events_resolved_by" FOREIGN KEY ("resolvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payment_events_unresolved_reconciliation" ON "payment_events" ("createdAt", "id") WHERE "processingStatus" = 'requires_reconciliation' AND "resolvedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_payment_events_unresolved_reconciliation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" DROP CONSTRAINT "FK_payment_events_resolved_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" DROP CONSTRAINT "CHK_payment_events_resolution"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" DROP COLUMN "resolutionNote"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" DROP COLUMN "resolvedByUserId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_events" DROP COLUMN "resolvedAt"`,
    );
  }
}
