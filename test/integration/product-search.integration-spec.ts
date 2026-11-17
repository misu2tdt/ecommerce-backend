import { DataSource } from 'typeorm';
import { Brand } from '../../src/brands/entities/brand.entity';
import { Category } from '../../src/categories/entities/category.entity';
import { ImageStorageService } from '../../src/image-storage/image-storage.service';
import { ProductSort } from '../../src/products/dto/product-query.dto';
import { ProductImage } from '../../src/products/entities/product-image.entity';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { Product } from '../../src/products/entities/product.entity';
import { ProductsService } from '../../src/products/products.service';
import { createBrand, createCategory } from './catalog-fixtures';
import {
  cleanTestDatabase,
  initializeTestDatabase,
  undoMigrationsThrough,
} from './test-database';

const MIGRATION_NAME = 'AddProductNameTrigramIndex1787677200000';
const INDEX_NAME = 'IDX_products_name_trgm';

describe('Product name search (PostgreSQL)', () => {
  let dataSource: DataSource;
  let service: ProductsService;
  let category: Category;
  let counter = 0;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
    service = new ProductsService(
      dataSource.getRepository(Product),
      dataSource.getRepository(Category),
      dataSource.getRepository(Brand),
      dataSource.getRepository(ProductImage),
      { deleteImage: jest.fn() } as unknown as ImageStorageService,
    );
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    category = await createCategory(dataSource, 'search');
    counter = 0;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  async function product(
    name: string,
    options: {
      status?: ProductStatus;
      categoryId?: number;
      brandId?: number | null;
    } = {},
  ) {
    counter += 1;
    return dataSource.getRepository(Product).save({
      name,
      slug: `search-product-${counter}`,
      status: options.status ?? ProductStatus.ACTIVE,
      categoryId: options.categoryId ?? category.id,
      brandId: options.brandId ?? null,
    });
  }

  async function names(q?: string) {
    return (await service.findAll({ q })).map((found) => found.name);
  }

  describe('matching', () => {
    it('ignores case', async () => {
      await product('Relaxed Oxford Shirt');
      await product('Classic Tee');

      for (const q of ['relaxed', 'RELAXED', 'rElAxEd']) {
        expect(await names(q)).toEqual(['Relaxed Oxford Shirt']);
      }
    });

    it('finds part of a word, at the start, in the middle and at the end', async () => {
      await product('Heritage Ringer Tee');
      await product('Packable Anorak');

      expect(await names('herit')).toEqual(['Heritage Ringer Tee']);
      expect(await names('ing')).toEqual(['Heritage Ringer Tee']);
      expect(await names('ee')).toEqual(['Heritage Ringer Tee']);
      expect(await names('kab')).toEqual(['Packable Anorak']);
    });

    it('finds a phrase that spans two words', async () => {
      await product('Cuban Collar Linen Blend Shirt');
      await product('Cuban Heel Boots');

      expect(await names('collar linen')).toEqual([
        'Cuban Collar Linen Blend Shirt',
      ]);
      expect(await names('cuban')).toHaveLength(2);
    });

    it('answers with nothing, not an error, when nothing matches', async () => {
      await product('Classic Tee');

      expect(await names('does-not-exist')).toEqual([]);
      expect(
        await service.findPage(
          { q: 'does-not-exist' },
          { page: 1, limit: 20, offset: 0 },
        ),
      ).toEqual({ items: [], total: 0 });
    });

    it('never returns an inactive product', async () => {
      await product('Visible Tee');
      await product('Hidden Tee', { status: ProductStatus.INACTIVE });

      expect(await names('tee')).toEqual(['Visible Tee']);
    });

    it('works together with the category and brand filters', async () => {
      const other = await createCategory(dataSource, 'other');
      const brand = await createBrand(dataSource, 'verve');
      await product('Verve Tee', { brandId: brand.id });
      await product('Plain Tee');
      await product('Verve Hoodie', {
        categoryId: other.id,
        brandId: brand.id,
      });

      expect(
        (await service.findAll({ q: 'tee', brand: brand.slug })).map(
          (p) => p.name,
        ),
      ).toEqual(['Verve Tee']);
      expect(
        (await service.findAll({ q: 'verve', category: other.slug })).map(
          (p) => p.name,
        ),
      ).toEqual(['Verve Hoodie']);
    });
  });

  describe('special characters are searched for, not interpreted', () => {
    beforeEach(async () => {
      await product('Sale 100% Cotton Tee');
      await product('Tee_Large');
      await product('Tee Large');
      await product('Back\\slash Tee');
      await product("O'Brien Tee");
      await product('Cinder & Oak Tee');
      await product('Plain Tee');
    });

    it('treats % as a letter, not as "anything"', async () => {
      expect(await names('100%')).toEqual(['Sale 100% Cotton Tee']);
      // A lone % used to match every product.
      expect(await names('%')).toEqual(['Sale 100% Cotton Tee']);
      expect(await names('%tee')).toEqual([]);
    });

    it('treats _ as a letter, not as "any one character"', async () => {
      expect(await names('_')).toEqual(['Tee_Large']);
      expect(await names('tee_large')).toEqual(['Tee_Large']);
      expect(await names('tee large')).toEqual(['Tee Large']);
    });

    it('treats a backslash as a letter', async () => {
      expect(await names('\\')).toEqual(['Back\\slash Tee']);
      expect(await names('back\\slash')).toEqual(['Back\\slash Tee']);
      // A trailing backslash does not break the pattern.
      expect(await names('tee\\')).toEqual([]);
    });

    it('finds quotes and ampersands', async () => {
      expect(await names("o'brien")).toEqual(["O'Brien Tee"]);
      expect(await names('& oak')).toEqual(['Cinder & Oak Tee']);
    });

    it('is not a way into the database: the term is a bound parameter', async () => {
      expect(await names("'; DROP TABLE products; --")).toEqual([]);
      expect(await names('" OR 1=1 --')).toEqual([]);

      expect(await dataSource.getRepository(Product).count()).toBe(7);
    });

    it('accepts the longest term the API allows', async () => {
      expect(await names('a'.repeat(255))).toEqual([]);
    });
  });

  describe('without a search term', () => {
    it('lists every active product, for no term and for an empty one', async () => {
      await product('B Tee');
      await product('A Tee');
      await product('Gone Tee', { status: ProductStatus.INACTIVE });

      expect(await names(undefined)).toEqual(['A Tee', 'B Tee']);
      expect(await names('')).toEqual(['A Tee', 'B Tee']);
    });
  });

  describe('paging and order', () => {
    it('pages a search with a total that counts only the matches', async () => {
      for (let n = 1; n <= 25; n += 1) {
        await product(`Match Item ${String(n).padStart(2, '0')}`);
      }
      for (let n = 1; n <= 7; n += 1) await product(`Other ${n}`);

      const page = (number: number) =>
        service.findPage(
          { q: 'match' },
          { page: number, limit: 10, offset: (number - 1) * 10 },
        );
      const first = await page(1);
      const second = await page(2);
      const third = await page(3);
      const beyond = await page(4);

      expect(first.total).toBe(25);
      expect(first.items.map((p) => p.name)).toEqual(
        Array.from(
          { length: 10 },
          (_, i) => `Match Item ${String(i + 1).padStart(2, '0')}`,
        ),
      );
      expect(second.items).toHaveLength(10);
      expect(third.items).toHaveLength(5);
      expect(beyond).toMatchObject({ items: [], total: 25 });
      const ids = [...first.items, ...second.items, ...third.items].map(
        (p) => p.id,
      );
      expect(new Set(ids).size).toBe(25);
    });

    it('keeps one stable order when many products share a name, ending with the id', async () => {
      const created: number[] = [];
      for (let n = 0; n < 7; n += 1)
        created.push((await product('Twin Tee')).id);
      await product('Aaa Tee');

      const seen: number[] = [];
      for (let number = 1; number <= 4; number += 1) {
        const page = await service.findPage(
          { q: 'tee' },
          { page: number, limit: 2, offset: (number - 1) * 2 },
        );
        seen.push(...page.items.map((p) => p.id));
      }

      // "Aaa Tee" first, then the seven twins by id: no repeat, no gap.
      expect(seen).toHaveLength(8);
      expect(seen.slice(1)).toEqual([...created].sort((a, b) => a - b));
      // Asking again gives the very same order.
      const again = await service.findAll({ q: 'tee' });
      expect(again.map((p) => p.id)).toEqual(seen);
    });

    it('keeps the order of the other sorts when searching', async () => {
      await product('Zed Tee');
      await product('Alpha Tee');

      expect(
        (await service.findAll({ q: 'tee', sort: ProductSort.NAME_ASC })).map(
          (p) => p.name,
        ),
      ).toEqual(['Alpha Tee', 'Zed Tee']);
      expect(
        (await service.findAll({ q: 'tee', sort: ProductSort.NAME_DESC })).map(
          (p) => p.name,
        ),
      ).toEqual(['Zed Tee', 'Alpha Tee']);
      expect(
        (await service.findAll({ q: 'tee', sort: ProductSort.NEWEST })).map(
          (p) => p.name,
        ),
      ).toEqual(['Alpha Tee', 'Zed Tee']);
    });
  });

  describe('the trigram index', () => {
    const indexRows = () =>
      dataSource.query<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
        [INDEX_NAME],
      );
    const extensionRows = () =>
      dataSource.query<{ extname: string }[]>(
        `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
      );

    it('exists after the migrations: a GIN index on the name with the trigram operator class', async () => {
      expect(
        dataSource.migrations.map((migration) => migration.name),
      ).toContain(MIGRATION_NAME);
      expect(await extensionRows()).toHaveLength(1);

      const rows = await indexRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/USING gin/i);
      expect(rows[0].indexdef).toMatch(/\("?name"? gin_trgm_ops\)/);
      expect(rows[0].indexdef).toMatch(/ON public\.products/);
    });

    it('is declared on the entity as an index TypeORM must leave alone', () => {
      const declared = dataSource
        .getMetadata(Product)
        .indices.find((index) => index.name === INDEX_NAME);

      expect(declared).toBeDefined();
      expect(declared?.synchronize).toBe(false);
    });

    it('only adds the index: reverting drops it and keeps the extension and the data, applying restores it, results never change', async () => {
      await product('Relaxed Oxford Shirt');
      await product('Classic Tee');
      const before = await names('relax');
      const rowsBefore = await dataSource.query(
        'SELECT * FROM products ORDER BY id',
      );

      try {
        await undoMigrationsThrough(dataSource, MIGRATION_NAME);
        expect(await indexRows()).toHaveLength(0);
        // The extension stays: it may have been there before the migration.
        expect(await extensionRows()).toHaveLength(1);
        expect(
          await dataSource.query('SELECT * FROM products ORDER BY id'),
        ).toEqual(rowsBefore);
        expect(await names('relax')).toEqual(before);
      } finally {
        await dataSource.runMigrations();
      }

      expect(await indexRows()).toHaveLength(1);
      expect(
        await dataSource.query('SELECT * FROM products ORDER BY id'),
      ).toEqual(rowsBefore);
      expect(await names('relax')).toEqual(before);
    });

    it('is used for a rare word on a big table, and not for two letters', async () => {
      await dataSource.query(
        `INSERT INTO products (name, slug, status, "categoryId")
         SELECT 'Item ' || g, 'plan-' || g, 'active', $1 FROM generate_series(1, 20000) g`,
        [category.id],
      );
      await dataSource.query(
        `INSERT INTO products (name, slug, status, "categoryId")
         SELECT 'Zephyr Special ' || g, 'plan-zephyr-' || g, 'active', $1 FROM generate_series(1, 20) g`,
        [category.id],
      );
      await dataSource.query('ANALYZE products');
      const plan = async (pattern: string) =>
        (
          await dataSource.query<Array<{ 'QUERY PLAN': string }>>(
            `EXPLAIN SELECT id FROM products WHERE status = 'active' AND name ILIKE $1`,
            [pattern],
          )
        )
          .map((row) => row['QUERY PLAN'])
          .join('\n');

      expect(await plan('%zephyr%')).toContain(INDEX_NAME);
      // Shorter than three letters has no trigram to look up.
      expect(await plan('%ze%')).not.toContain(INDEX_NAME);
      expect(await names('zephyr')).toHaveLength(20);
    });
  });
});
