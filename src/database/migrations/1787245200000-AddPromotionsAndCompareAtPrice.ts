import { MigrationInterface, QueryRunner } from 'typeorm';

const MAX_SAFE_VND = '9007199254740991';

export class AddPromotionsAndCompareAtPrice1787245200000 implements MigrationInterface {
  name = 'AddPromotionsAndCompareAtPrice1787245200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add compareAtPrice to product_variants
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD COLUMN "compareAtPrice" bigint NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "CHK_product_variants_compare_at_price" CHECK ("compareAtPrice" IS NULL OR ("compareAtPrice" >= 0 AND "compareAtPrice" <= ${MAX_SAFE_VND} AND "compareAtPrice" > "price"))`,
    );

    // 2. Create coupons table
    await queryRunner.query(`
      CREATE TABLE "coupons" (
        "id" SERIAL PRIMARY KEY,
        "code" varchar(64) NOT NULL,
        "name" varchar(255) NOT NULL,
        "type" varchar(32) NOT NULL,
        "value" bigint NOT NULL,
        "minSubtotal" bigint NULL,
        "maxDiscount" bigint NULL,
        "startsAt" timestamp with time zone NULL,
        "endsAt" timestamp with time zone NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "UQ_coupons_code" UNIQUE ("code"),
        CONSTRAINT "CHK_coupons_type" CHECK ("type" IN ('PERCENTAGE', 'FIXED')),
        CONSTRAINT "CHK_coupons_value" CHECK ("value" > 0 AND "value" <= ${MAX_SAFE_VND} AND ("type" <> 'PERCENTAGE' OR "value" <= 100)),
        CONSTRAINT "CHK_coupons_min_subtotal" CHECK ("minSubtotal" IS NULL OR ("minSubtotal" >= 0 AND "minSubtotal" <= ${MAX_SAFE_VND})),
        CONSTRAINT "CHK_coupons_max_discount" CHECK ("maxDiscount" IS NULL OR ("maxDiscount" > 0 AND "maxDiscount" <= ${MAX_SAFE_VND} AND "type" = 'PERCENTAGE')),
        CONSTRAINT "CHK_coupons_date_range" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt")
      )
    `);

    // 3. Add promotion snapshot columns to orders
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "subtotalPrice" bigint NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "discountPrice" bigint NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "couponCode" varchar(64) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "couponType" varchar(32) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "couponValue" bigint NULL`,
    );

    // 4. Backfill existing orders
    await queryRunner.query(
      `UPDATE "orders" SET "subtotalPrice" = "totalPrice", "discountPrice" = 0 WHERE "subtotalPrice" = 0`,
    );

    // 5. Add check constraints on orders
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_subtotal_price" CHECK ("subtotalPrice" >= 0 AND "subtotalPrice" <= ${MAX_SAFE_VND})`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_discount_price" CHECK ("discountPrice" >= 0 AND "discountPrice" <= "subtotalPrice")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_discount_price"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_subtotal_price"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "couponValue"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "couponType"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "couponCode"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "discountPrice"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "subtotalPrice"`);

    await queryRunner.query(`DROP TABLE "coupons"`);

    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "CHK_product_variants_compare_at_price"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN "compareAtPrice"`,
    );
  }
}
