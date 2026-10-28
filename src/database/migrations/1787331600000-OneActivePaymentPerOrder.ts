import { MigrationInterface, QueryRunner } from 'typeorm';

const MAX_LISTED_ORDERS = 50;

export class OneActivePaymentPerOrder1787331600000 implements MigrationInterface {
  name = 'OneActivePaymentPerOrder1787331600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Read-only pre-check. This migration never changes or deletes payments:
    // if existing data already breaks the rule, a human must resolve it first.
    const violations = (await queryRunner.query(
      `SELECT "orderId" FROM "payments" WHERE "status" IN ('pending', 'processing', 'succeeded') GROUP BY "orderId" HAVING COUNT(*) > 1 ORDER BY "orderId"`,
    )) as { orderId: number }[];

    if (violations.length > 0) {
      const listed = violations
        .slice(0, MAX_LISTED_ORDERS)
        .map(({ orderId }) => orderId)
        .join(', ');
      const more =
        violations.length > MAX_LISTED_ORDERS
          ? ` and ${violations.length - MAX_LISTED_ORDERS} more`
          : '';
      throw new Error(
        `Cannot create "UQ_payments_one_active_per_order": ${violations.length} order(s) already have more than one active payment (pending, processing or succeeded). Order ids: ${listed}${more}. Resolve them manually (for example mark the duplicate payments failed or cancelled) and run the migration again. No data was changed.`,
      );
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payments_one_active_per_order" ON "payments" ("orderId") WHERE "status" IN ('pending', 'processing', 'succeeded')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_payments_one_active_per_order"`,
    );
  }
}
