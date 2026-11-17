import { MigrationInterface, QueryRunner } from 'typeorm';

export const PRODUCT_NAME_TRIGRAM_INDEX = 'IDX_products_name_trgm';

export class AddProductNameTrigramIndex1787677200000 implements MigrationInterface {
  name = 'AddProductNameTrigramIndex1787677200000';

  // Additive and data-free. The catalog search is `name ILIKE '%term%'`, which a
  // plain index can not serve (the pattern starts with a wildcard), so every
  // search read every product. A trigram GIN index can serve it.
  //
  // pg_trgm ships with PostgreSQL (it is a "trusted" extension, so the owner of
  // the database may create it). The index is a plain CREATE INDEX, not
  // CONCURRENTLY, because a migration runs in a transaction; it takes a short
  // lock on "products" while it builds, which is a moment for a catalog of this
  // size. No query result changes: the same rows match, only faster.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(
      `CREATE INDEX "${PRODUCT_NAME_TRIGRAM_INDEX}" ON "products" USING gin ("name" gin_trgm_ops)`,
    );
  }

  // Drops the index only. The extension is left installed: "IF NOT EXISTS" above
  // means it may have been there before this migration, and dropping it could
  // break something else that uses it. It is harmless when unused.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."${PRODUCT_NAME_TRIGRAM_INDEX}"`,
    );
  }
}
