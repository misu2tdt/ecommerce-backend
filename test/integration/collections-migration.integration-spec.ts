import { DataSource } from 'typeorm';
import { CollectionProduct } from '../../src/collections/entities/collection-product.entity';
import { Collection } from '../../src/collections/entities/collection.entity';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { Product } from '../../src/products/entities/product.entity';
import { createCategory } from './catalog-fixtures';
import {
  cleanTestDatabase,
  initializeTestDatabase,
  undoMigrationsThrough,
} from './test-database';

const MIGRATION_NAME = 'AddCollections1787590800000';

// Collections are two new tables. Going up creates them with their keys, checks
// and indexes; going down removes them and touches nothing else.
describe('Collections migration', () => {
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

  const tableExists = async (name: string) => {
    const rows = await dataSource.query<Array<{ name: string | null }>>(
      `SELECT to_regclass($1) AS name`,
      [`public.${name}`],
    );
    return rows[0].name !== null;
  };

  const columns = (table: string) =>
    dataSource.query<
      Array<{
        name: string;
        type: string;
        nullable: string;
        defaultValue: string | null;
      }>
    >(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable,
              column_default AS "defaultValue"
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );

  const indexDefinition = async (name: string) => {
    const rows = await dataSource.query<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [name],
    );
    return rows.map((row) => row.indexdef);
  };

  it('is registered, and the entities declare what it creates', () => {
    expect(dataSource.migrations.map((migration) => migration.name)).toContain(
      MIGRATION_NAME,
    );
    const collectionIndices = dataSource
      .getMetadata(Collection)
      .indices.map((index) => index.name)
      .sort();
    expect(collectionIndices).toEqual([
      'IDX_collections_active_sort',
      'UQ_collections_slug',
    ]);
    const memberMetadata = dataSource.getMetadata(CollectionProduct);
    expect(memberMetadata.indices.map((index) => index.name)).toEqual([
      'IDX_collection_products_product',
    ]);
    expect(memberMetadata.checks.map((check) => check.name)).toEqual([
      'CHK_collection_products_position',
    ]);
    expect(
      memberMetadata.primaryColumns.map((column) => column.propertyName),
    ).toEqual(['collectionId', 'productId']);
  });

  it('creates the collections table with the agreed columns and defaults', async () => {
    const rows = await columns('collections');

    expect(rows.map((row) => [row.name, row.type, row.nullable])).toEqual([
      ['id', 'integer', 'NO'],
      ['slug', 'character varying', 'NO'],
      ['name', 'character varying', 'NO'],
      ['description', 'text', 'YES'],
      ['heroImageUrl', 'character varying', 'YES'],
      ['isActive', 'boolean', 'NO'],
      ['isFeatured', 'boolean', 'NO'],
      ['sortOrder', 'integer', 'NO'],
      ['createdAt', 'timestamp without time zone', 'NO'],
      ['updatedAt', 'timestamp without time zone', 'NO'],
    ]);
    const defaults = Object.fromEntries(
      rows.map((row) => [row.name, row.defaultValue]),
    );
    expect(defaults.isActive).toBe('true');
    expect(defaults.isFeatured).toBe('false');
    expect(defaults.sortOrder).toBe('0');
  });

  it('creates the membership table with a composite primary key, a check and cascading keys', async () => {
    expect(
      (await columns('collection_products')).map((row) => [
        row.name,
        row.type,
        row.nullable,
      ]),
    ).toEqual([
      ['collectionId', 'integer', 'NO'],
      ['productId', 'integer', 'NO'],
      ['position', 'integer', 'NO'],
    ]);

    const primaryKey = await dataSource.query<Array<{ columns: string[] }>>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'collection_products'::regclass AND c.contype = 'p'`,
    );
    expect(primaryKey[0].columns).toEqual(['collectionId', 'productId']);

    const foreignKeys = await dataSource.query<
      Array<{ name: string; deleteAction: string; target: string }>
    >(
      `SELECT conname AS name, confdeltype AS "deleteAction", confrelid::regclass::text AS target
       FROM pg_constraint
       WHERE conrelid = 'collection_products'::regclass AND contype = 'f'
       ORDER BY conname`,
    );
    // 'c' is ON DELETE CASCADE.
    expect(foreignKeys).toEqual([
      {
        name: 'FK_collection_products_collection',
        deleteAction: 'c',
        target: 'collections',
      },
      {
        name: 'FK_collection_products_product',
        deleteAction: 'c',
        target: 'products',
      },
    ]);

    const checks = await dataSource.query<
      Array<{ name: string; definition: string }>
    >(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'collection_products'::regclass AND contype = 'c'`,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('CHK_collection_products_position');
    expect(checks[0].definition).toMatch(/position.*>= 0/);
  });

  it('creates the indexes: unique slug, listing by (isActive, sortOrder), and by product', async () => {
    expect(await indexDefinition('UQ_collections_slug')).toEqual([
      // PostgreSQL only quotes names that need it, so plain "slug" has none.
      expect.stringMatching(/CREATE UNIQUE INDEX .*\(slug\)/),
    ]);
    expect(await indexDefinition('IDX_collections_active_sort')).toEqual([
      expect.stringMatching(/\("isActive", "sortOrder"\)/),
    ]);
    expect(await indexDefinition('IDX_collection_products_product')).toEqual([
      expect.stringMatching(/ON public\.collection_products .*\("productId"\)/),
    ]);
  });

  it('reverting removes both tables and every index, changes no other data, and applying again restores them', async () => {
    const category = await createCategory(dataSource, 'collections-migration');
    const product = await dataSource.getRepository(Product).save({
      name: 'Migration Tee',
      slug: 'collections-migration-tee',
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
    });
    const productsBefore = await dataSource.query(
      `SELECT * FROM products ORDER BY id`,
    );

    try {
      await undoMigrationsThrough(dataSource, MIGRATION_NAME);

      expect(await tableExists('collections')).toBe(false);
      expect(await tableExists('collection_products')).toBe(false);
      expect(await indexDefinition('IDX_collections_active_sort')).toEqual([]);
      expect(await indexDefinition('IDX_collection_products_product')).toEqual(
        [],
      );
      expect(await indexDefinition('UQ_collections_slug')).toEqual([]);
      expect(
        await dataSource.query(`SELECT * FROM products ORDER BY id`),
      ).toEqual(productsBefore);
    } finally {
      await dataSource.runMigrations();
    }

    expect(await tableExists('collections')).toBe(true);
    expect(await tableExists('collection_products')).toBe(true);
    expect(await indexDefinition('IDX_collections_active_sort')).toHaveLength(
      1,
    );
    expect(
      await dataSource.query(`SELECT * FROM products ORDER BY id`),
    ).toEqual(productsBefore);
    // The restored tables work.
    await dataSource.query(
      `INSERT INTO collections (slug, name) VALUES ('after-redo', 'After redo')`,
    );
    expect(product.id).toBeGreaterThan(0);
    await cleanTestDatabase(dataSource);
  });
});
