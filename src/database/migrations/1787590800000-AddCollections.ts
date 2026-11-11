import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCollections1787590800000 implements MigrationInterface {
  name = 'AddCollections1787590800000';

  // Additive: two new tables and their indexes. No existing table or row changes.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "collections" (
        "id" SERIAL PRIMARY KEY,
        "slug" varchar(255) NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text NULL,
        "heroImageUrl" varchar(2048) NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "isFeatured" boolean NOT NULL DEFAULT false,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "UQ_collections_slug" UNIQUE ("slug")
      )
    `);
    // Serves the public list: active collections in display order.
    await queryRunner.query(
      `CREATE INDEX "IDX_collections_active_sort" ON "collections" ("isActive", "sortOrder")`,
    );

    await queryRunner.query(`
      CREATE TABLE "collection_products" (
        "collectionId" integer NOT NULL,
        "productId" integer NOT NULL,
        "position" integer NOT NULL,
        CONSTRAINT "PK_collection_products" PRIMARY KEY ("collectionId", "productId"),
        CONSTRAINT "CHK_collection_products_position" CHECK ("position" >= 0),
        CONSTRAINT "FK_collection_products_collection" FOREIGN KEY ("collectionId") REFERENCES "collections" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_collection_products_product" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE
      )
    `);
    // The primary key serves "products of a collection"; this serves "collections
    // of a product" and the ON DELETE CASCADE from products.
    await queryRunner.query(
      `CREATE INDEX "IDX_collection_products_product" ON "collection_products" ("productId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_collection_products_product"`,
    );
    await queryRunner.query(`DROP TABLE "collection_products"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_collections_active_sort"`,
    );
    await queryRunner.query(`DROP TABLE "collections"`);
  }
}
