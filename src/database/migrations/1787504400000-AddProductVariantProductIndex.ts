import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProductVariantProductIndex1787504400000 implements MigrationInterface {
  name = 'AddProductVariantProductIndex1787504400000';

  // Additive and data-free: only adds an index. The catalog computes prices,
  // stock and filters per product with a lookup of its variants, and no index
  // covered "productId", so each lookup read the whole table.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_product_variants_product" ON "product_variants" ("productId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_product_variants_product"`,
    );
  }
}
