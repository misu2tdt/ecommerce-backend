import { DataSource } from 'typeorm';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { Product } from '../../src/products/entities/product.entity';
import { createCategory } from './catalog-fixtures';
import {
  cleanTestDatabase,
  initializeTestDatabase,
  undoMigrationsThrough,
} from './test-database';

const MIGRATION_NAME = 'AddProductVariantProductIndex1787504400000';
const INDEX_NAME = 'IDX_product_variants_product';

// Every price, stock and filter summary of the catalog looks variants up by
// their product, and nothing indexed that column: the paged price sort took
// about 54 seconds on a synthetic catalog of 18,000 products and 52 milliseconds
// once the column was indexed. This migration only adds that index.
describe('Product variant product index migration', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.runMigrations();
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  const indexDefinitions = () =>
    dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [INDEX_NAME],
    );

  it('exists, is declared on the entity, and is what the schema has', async () => {
    expect(dataSource.migrations.map((migration) => migration.name)).toContain(
      MIGRATION_NAME,
    );
    const declared = dataSource
      .getMetadata(ProductVariant)
      .indices.find((index) => index.name === INDEX_NAME);
    expect(declared?.columns.map((column) => column.propertyName)).toEqual([
      'productId',
    ]);
    expect(declared?.isUnique).toBe(false);

    const rows = await indexDefinitions();
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\("productId"\)/);
  });

  it('only adds the index: reverting removes it, applying again restores it, no data changes', async () => {
    const category = await createCategory(dataSource, 'migration');
    const product = await dataSource.getRepository(Product).save({
      name: 'Migration Tee',
      slug: 'migration-tee',
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
    });
    await dataSource.getRepository(ProductVariant).save({
      productId: product.id,
      sku: 'MIGRATION-1',
      name: 'Default',
      price: 100_000,
      stock: 3,
      attributes: {},
      isActive: true,
      position: 0,
    });
    const before = await dataSource.query(
      `SELECT * FROM product_variants ORDER BY id`,
    );

    try {
      await undoMigrationsThrough(dataSource, MIGRATION_NAME);
      expect(await indexDefinitions()).toHaveLength(0);
      expect(
        await dataSource.query(`SELECT * FROM product_variants ORDER BY id`),
      ).toEqual(before);
    } finally {
      await dataSource.runMigrations();
    }

    expect(await indexDefinitions()).toHaveLength(1);
    expect(
      await dataSource.query(`SELECT * FROM product_variants ORDER BY id`),
    ).toEqual(before);
    await cleanTestDatabase(dataSource);
  });

  it('is used by the per-product price lookup the catalog runs for every row', async () => {
    const category = await createCategory(dataSource, 'plan');
    await dataSource.query(
      `INSERT INTO products (name, slug, status, "categoryId")
       SELECT 'P' || g, 'plan-' || g, 'active', $1 FROM generate_series(1, 2000) g`,
      [category.id],
    );
    await dataSource.query(
      `INSERT INTO product_variants ("productId", sku, name, price, stock, attributes, "isActive", position)
       SELECT p.id, 'PLAN-' || p.id || '-' || v, 'V', 100000, 1, '{}', true, v
       FROM products p, generate_series(1, 3) v WHERE p.slug LIKE 'plan-%'`,
    );
    await dataSource.query('ANALYZE product_variants');

    const plan = await dataSource.query<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT MIN(v."price") FROM product_variants v
       WHERE v."productId" = (SELECT MIN(id) FROM products WHERE slug LIKE 'plan-%')
         AND v."isActive" = true`,
    );

    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      INDEX_NAME,
    );
    await cleanTestDatabase(dataSource);
  });
});
