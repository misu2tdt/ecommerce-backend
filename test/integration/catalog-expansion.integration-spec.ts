import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  BATCH1_COLLECTIONS,
  BATCH1_PRODUCTS,
} from '../../src/database/seeds/catalog-expansion/batch1.data';
import { seedCatalogExpansion } from '../../src/database/seeds/catalog-expansion/catalog-expansion';
import { getCatalogExpansionImageSlots } from '../../src/database/seeds/catalog-expansion/image-slots';
import type { DemoImageManifest } from '../../src/database/seeds/demo-image-manifest';
import { seedDemoData } from '../../src/database/seeds/demo-seed';
import { PRODUCTION_DEMO_CONFIRMATION } from '../../src/database/seeds/demo-seed-safety';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const testOptions = { target: 'test' as const, nodeEnvironment: 'test' };
const productionOptions = {
  target: 'production' as const,
  nodeEnvironment: 'production',
  productionApproval: {
    confirmation: PRODUCTION_DEMO_CONFIRMATION,
    database: 'ecommerce_test',
  },
};

const NEW_ARRIVALS = [
  'Studio High-Rise Leggings',
  'Pace 5-Inch Running Shorts',
  'Cloud Knit Lounge Set',
  'Cotton Gauze Pajama Set',
  'Garment-Dyed Pocket Tee',
  'Heritage Ringer Tee',
  'Cuban Collar Linen Blend Shirt',
  'Monsoon Shell Jacket',
  'Packable Anorak',
  'Waxed Cotton Work Jacket',
  'Canvas Carpenter Pants',
  'Straight Leg Indigo Jeans',
];

const imageUrl = (slug: string, colour: string, version = 1) =>
  `https://res.cloudinary.com/demo-cloud/image/upload/v${version}/evergreen/demo/${slug}__${colour}.jpg`;

// Slots of the first `count` batch 1 products, in the manifest's shape.
function manifestFor(count: number, version = 1): DemoImageManifest {
  const names = new Set(BATCH1_PRODUCTS.slice(0, count).map((p) => p.name));
  return {
    products: getCatalogExpansionImageSlots()
      .filter((slot) => names.has(slot.productName))
      .map((slot) => ({
        productSlug: slot.productSlug,
        colorSlug: slot.colorSlug,
        url: imageUrl(slot.productSlug, slot.colorSlug, version),
        width: 1024,
        height: 1280,
      })),
    banners: [
      {
        name: 'banner-collection-new-arrivals',
        url: 'https://res.cloudinary.com/demo-cloud/image/upload/v1/evergreen/demo/banner-collection-new-arrivals.png',
        width: 1536,
        height: 1024,
      },
    ],
  };
}

describe('catalog expansion (batch 1) on isolated PostgreSQL', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  const count = async (table: string): Promise<number> => {
    const [row] = await dataSource.query<Array<{ n: string }>>(
      `SELECT COUNT(*) AS n FROM "${table}"`,
    );
    return Number(row.n);
  };

  const snapshot = async () => ({
    categories: await dataSource.query(`SELECT * FROM categories ORDER BY id`),
    brands: await dataSource.query(`SELECT * FROM brands ORDER BY id`),
    products: await dataSource.query(`SELECT * FROM products ORDER BY id`),
    variants: await dataSource.query(
      `SELECT * FROM product_variants ORDER BY id`,
    ),
    images: await dataSource.query(`SELECT * FROM product_images ORDER BY id`),
    collections: await dataSource.query(
      `SELECT * FROM collections ORDER BY id`,
    ),
    members: await dataSource.query(
      `SELECT * FROM collection_products ORDER BY "collectionId", position`,
    ),
    coupons: await dataSource.query(`SELECT * FROM coupons ORDER BY id`),
  });

  const membersOf = async (slug: string): Promise<string[]> => {
    const rows = await dataSource.query<Array<{ name: string }>>(
      `SELECT p.name FROM collection_products cp
       JOIN collections c ON c.id = cp."collectionId"
       JOIN products p ON p.id = cp."productId"
       WHERE c.slug = $1 ORDER BY cp.position`,
      [slug],
    );
    return rows.map((row) => row.name);
  };

  const seedBase = () => seedDemoData(dataSource, testOptions);

  describe('on top of the base demo catalog', () => {
    it('gives 70 products, 7 categories, 8 brands, 395 variants, 6 new collections and 2 new coupons', async () => {
      await seedBase();

      const summary = await seedCatalogExpansion(dataSource, testOptions);

      expect(summary).toEqual({
        categories: { created: 2, alreadyPresent: 0 },
        brands: { created: 4, alreadyPresent: 0 },
        products: { created: 44, alreadyPresent: 0 },
        variants: { created: 323, alreadyPresent: 0 },
        collections: { created: 6, alreadyPresent: 0 },
        collectionMembers: 70,
        coupons: { created: 2, alreadyPresent: 0 },
        images: 0,
        newProductsWithoutImages: 44,
      });
      expect(await count('products')).toBe(70);
      expect(await count('categories')).toBe(7);
      expect(await count('brands')).toBe(8);
      expect(await count('product_variants')).toBe(395);
      // The base test seed's own 2 sample collections plus the 6 new ones.
      expect(await count('collections')).toBe(8);
      expect(await count('coupons')).toBe(4);
      expect(await count('product_images')).toBe(0);
    });

    it('creates the new categories, brands and products with the right links', async () => {
      await seedBase();
      await seedCatalogExpansion(dataSource, testOptions);

      const rows = await dataSource.query<
        Array<{ slug: string; status: string; category: string; brand: string }>
      >(
        `SELECT p.slug, p.status, c.slug AS category, b.slug AS brand
         FROM products p JOIN categories c ON c.id = p."categoryId"
         JOIN brands b ON b.id = p."brandId"
         WHERE p.slug IN ('studio-high-rise-leggings', 'cloud-knit-lounge-set', 'woven-cotton-belt')
         ORDER BY p.slug`,
      );
      expect(rows).toEqual([
        {
          slug: 'cloud-knit-lounge-set',
          status: 'active',
          category: 'loungewear-sleepwear',
          brand: 'hushwell',
        },
        {
          slug: 'studio-high-rise-leggings',
          status: 'active',
          category: 'activewear',
          brand: 'ardent-motion',
        },
        {
          slug: 'woven-cotton-belt',
          status: 'active',
          category: 'basics-accessories',
          brand: 'aerothread',
        },
      ]);
      const categoryCounts = await dataSource.query<
        Array<{ slug: string; n: string }>
      >(
        `SELECT c.slug, COUNT(*) AS n FROM products p
         JOIN categories c ON c.id = p."categoryId" GROUP BY c.slug ORDER BY c.slug`,
      );
      expect(
        Object.fromEntries(categoryCounts.map((r) => [r.slug, Number(r.n)])),
      ).toEqual({
        activewear: 8,
        'basics-accessories': 11,
        'hoodies-outerwear': 11,
        'loungewear-sleepwear': 8,
        'pants-shorts': 11,
        'shirts-polos': 10,
        't-shirts-tops': 11,
      });
    });

    it('creates the variants of the rules: names, attributes, positions, stock, prices', async () => {
      await seedBase();
      await seedCatalogExpansion(dataSource, testOptions);

      const rows = await dataSource.query<
        Array<{
          sku: string;
          name: string;
          price: string;
          compareAtPrice: string | null;
          stock: number;
          attributes: { size: string; color: string };
          position: number;
          isActive: boolean;
        }>
      >(
        `SELECT sku, name, price, "compareAtPrice", stock, attributes, position, "isActive"
         FROM product_variants
         WHERE sku IN ('AM-SHL-BLK-XS', 'AM-SHL-PLM-M', 'KB-MLS-GMR-OS', 'KB-MSS-BLK-M')
         ORDER BY sku`,
      );
      expect(rows).toEqual([
        {
          sku: 'AM-SHL-BLK-XS',
          name: 'Black / XS',
          price: '399000',
          compareAtPrice: null,
          stock: 0,
          attributes: { size: 'XS', color: 'Black' },
          position: 0,
          isActive: true,
        },
        {
          sku: 'AM-SHL-PLM-M',
          name: 'Deep Plum / M',
          price: '399000',
          compareAtPrice: null,
          stock: 22,
          attributes: { size: 'M', color: 'Deep Plum' },
          position: 7,
          isActive: true,
        },
        {
          sku: 'KB-MLS-GMR-OS',
          name: 'Grey Marl',
          price: '159000',
          compareAtPrice: null,
          stock: 40,
          attributes: { size: 'One Size', color: 'Grey Marl' },
          position: 0,
          isActive: true,
        },
        {
          sku: 'KB-MSS-BLK-M',
          name: 'Black / M',
          price: '229000',
          compareAtPrice: '289000',
          stock: 29, // 24 x 1.2
          attributes: { size: 'M', color: 'Black' },
          position: 1,
          isActive: true,
        },
      ]);
      const [{ soldOut }] = await dataSource.query<Array<{ soldOut: string }>>(
        `SELECT COUNT(*) AS "soldOut" FROM product_variants
         WHERE stock = 0 AND "productId" IN (SELECT id FROM products WHERE slug = ANY($1))`,
        [BATCH1_PRODUCTS.map((p) => p.slug)],
      );
      expect(Number(soldOut)).toBe(8);
    });

    it('creates the six collections with their order, flags and members in the listed order', async () => {
      await seedBase();
      await seedCatalogExpansion(dataSource, testOptions);

      const collections = await dataSource.query<
        Array<{
          slug: string;
          name: string;
          isActive: boolean;
          isFeatured: boolean;
          sortOrder: number;
          heroImageUrl: string | null;
          description: string;
        }>
      >(
        `SELECT slug, name, "isActive", "isFeatured", "sortOrder", "heroImageUrl", description
         FROM collections WHERE slug = ANY($1) ORDER BY "sortOrder"`,
        [BATCH1_COLLECTIONS.map((c) => c.slug)],
      );
      expect(
        collections.map((c) => [
          c.slug,
          c.isActive,
          c.isFeatured,
          c.sortOrder,
          c.heroImageUrl,
        ]),
      ).toEqual([
        ['new-arrivals', true, true, 0, null],
        ['office-essentials', true, false, 1, null],
        ['weekend-casual', true, false, 2, null],
        ['rainy-season', true, false, 3, null],
        ['active-everyday', true, false, 4, null],
        ['tet-gift-edit', true, false, 5, null],
      ]);
      expect(collections[0].description).toContain('rain-ready shells');

      for (const definition of BATCH1_COLLECTIONS) {
        expect(await membersOf(definition.slug)).toEqual([
          ...definition.products,
        ]);
      }
      expect(await membersOf('new-arrivals')).toEqual(NEW_ARRIVALS);
    });

    it('creates the two coupons with the existing constraints', async () => {
      await seedBase();
      await seedCatalogExpansion(dataSource, testOptions);

      const coupons = await dataSource.query(
        `SELECT code, type, value::int AS value, "minSubtotal"::int AS "minSubtotal",
                "maxDiscount"::int AS "maxDiscount", "isActive", "startsAt", "endsAt"
         FROM coupons WHERE code IN ('TET2027', 'RAINY100') ORDER BY code`,
      );
      expect(coupons).toEqual([
        {
          code: 'RAINY100',
          type: 'FIXED',
          value: 100000,
          minSubtotal: 900000,
          maxDiscount: null,
          isActive: true,
          startsAt: null,
          endsAt: null,
        },
        {
          code: 'TET2027',
          type: 'PERCENTAGE',
          value: 15,
          minSubtotal: 700000,
          maxDiscount: 150000,
          isActive: true,
          startsAt: null,
          endsAt: null,
        },
      ]);
    });

    it('works after the production base seed too: 6 collections, 4 coupons, no admin account', async () => {
      await seedDemoData(dataSource, { ...productionOptions, images: 'none' });
      expect(await count('collections')).toBe(0);

      const summary = await seedCatalogExpansion(dataSource, {
        ...productionOptions,
        images: 'none',
      });

      expect(summary.products).toEqual({ created: 44, alreadyPresent: 0 });
      expect(await count('products')).toBe(70);
      expect(await count('collections')).toBe(6);
      expect(await count('coupons')).toBe(4);
      expect(await count('users')).toBe(1);
      expect(
        await dataSource.query(`SELECT id FROM users WHERE role = 'admin'`),
      ).toEqual([]);
    });
  });

  describe('reruns', () => {
    it('a second run creates nothing and changes nothing', async () => {
      await seedBase();
      await seedCatalogExpansion(dataSource, testOptions);
      const before = await snapshot();

      const second = await seedCatalogExpansion(dataSource, testOptions);

      expect(second).toEqual({
        categories: { created: 0, alreadyPresent: 2 },
        brands: { created: 0, alreadyPresent: 4 },
        products: { created: 0, alreadyPresent: 44 },
        variants: { created: 0, alreadyPresent: 323 },
        collections: { created: 0, alreadyPresent: 6 },
        collectionMembers: 0,
        coupons: { created: 0, alreadyPresent: 2 },
        images: 0,
        newProductsWithoutImages: 44,
      });
      // Rows are compared whole, "updatedAt" included: no row was even touched.
      expect(await snapshot()).toEqual(before);
    });

    it('keeps edits made by hand: variant stock and price, product name, collection and coupon', async () => {
      await seedBase();
      await seedCatalogExpansion(dataSource, testOptions);

      // An admin edits things, and orders take stock.
      await dataSource.query(
        `UPDATE product_variants SET stock = 777, price = 123000 WHERE sku = 'AM-SHL-BLK-M'`,
      );
      await dataSource.query(
        `UPDATE product_variants SET stock = 0 WHERE sku = 'AM-SHL-SAG-M'`,
      );
      await dataSource.query(
        `UPDATE product_variants SET "isActive" = false WHERE sku = 'AM-SHL-PLM-S'`,
      );
      await dataSource.query(
        `UPDATE products SET name = 'Studio Leggings (edited)', description = 'Edited text', status = 'inactive'
         WHERE slug = 'studio-high-rise-leggings'`,
      );
      await dataSource.query(
        `UPDATE collections SET name = 'Fresh Drops', "isFeatured" = false, "isActive" = false
         WHERE slug = 'new-arrivals'`,
      );
      await dataSource.query(
        `DELETE FROM collection_products WHERE "collectionId" =
           (SELECT id FROM collections WHERE slug = 'new-arrivals') AND position < 5`,
      );
      await dataSource.query(
        `UPDATE coupons SET "isActive" = false, "maxDiscount" = 99000 WHERE code = 'TET2027'`,
      );
      const before = await snapshot();

      const second = await seedCatalogExpansion(dataSource, testOptions);

      expect(second.products.created).toBe(0);
      expect(second.variants.created).toBe(0);
      expect(await snapshot()).toEqual(before);
      const [edited] = await dataSource.query<
        Array<{ stock: number; price: string }>
      >(`SELECT stock, price FROM product_variants WHERE sku = 'AM-SHL-BLK-M'`);
      expect(edited).toEqual({ stock: 777, price: '123000' });
      expect(await membersOf('new-arrivals')).toEqual(NEW_ARRIVALS.slice(5));
    });

    it('adds only what is missing after something was removed', async () => {
      await seedBase();
      await seedCatalogExpansion(dataSource, testOptions);
      await dataSource.query(`DELETE FROM coupons WHERE code = 'RAINY100'`);
      await dataSource.query(
        `DELETE FROM product_variants WHERE sku IN ('AM-SHL-BLK-S', 'AM-SHL-BLK-M')`,
      );
      await dataSource.query(
        `DELETE FROM collections WHERE slug = 'rainy-season'`,
      );

      const second = await seedCatalogExpansion(dataSource, testOptions);

      expect(second.coupons).toEqual({ created: 1, alreadyPresent: 1 });
      expect(second.variants).toEqual({ created: 2, alreadyPresent: 321 });
      expect(second.collections).toEqual({ created: 1, alreadyPresent: 5 });
      expect(second.collectionMembers).toBe(9);
      expect(await count('product_variants')).toBe(395);
      expect(await membersOf('rainy-season')).toHaveLength(9);
    });
  });

  describe('images', () => {
    it('attaches one image per colour from an injected manifest, first colour primary, and skips slots without an entry', async () => {
      await seedBase();

      const summary = await seedCatalogExpansion(dataSource, {
        ...testOptions,
        images: manifestFor(3),
      });

      // Leggings (3 colours), sports bra (3) and yoga pants (2).
      expect(summary.images).toBe(8);
      expect(summary.newProductsWithoutImages).toBe(41);
      expect(await count('product_images')).toBe(8);

      const rows = await dataSource.query<
        Array<{
          url: string;
          altText: string;
          position: number;
          isPrimary: boolean;
        }>
      >(
        `SELECT i.url, i."altText", i.position, i."isPrimary"
         FROM product_images i JOIN products p ON p.id = i."productId"
         WHERE p.slug = 'studio-high-rise-leggings' ORDER BY i.position`,
      );
      expect(rows).toEqual([
        {
          url: imageUrl('studio-high-rise-leggings', 'black'),
          altText: 'Studio High-Rise Leggings in Black',
          position: 0,
          isPrimary: true,
        },
        {
          url: imageUrl('studio-high-rise-leggings', 'deep-plum'),
          altText: 'Studio High-Rise Leggings in Deep Plum',
          position: 1,
          isPrimary: false,
        },
        {
          url: imageUrl('studio-high-rise-leggings', 'sage'),
          altText: 'Studio High-Rise Leggings in Sage',
          position: 2,
          isPrimary: false,
        },
      ]);
      // No base product got an image from this seed.
      expect(
        await dataSource.query(
          `SELECT 1 FROM product_images i JOIN products p ON p.id = i."productId"
           WHERE p.slug = 'classic-crewneck-cotton-tee'`,
        ),
      ).toEqual([]);
    });

    it('uses the collection cover from the manifest when it names one, otherwise no cover', async () => {
      await seedBase();

      await seedCatalogExpansion(dataSource, {
        ...testOptions,
        images: manifestFor(1),
      });

      const rows = await dataSource.query<
        Array<{ slug: string; heroImageUrl: string | null }>
      >(
        `SELECT slug, "heroImageUrl" FROM collections WHERE slug = ANY($1) ORDER BY "sortOrder"`,
        [BATCH1_COLLECTIONS.map((c) => c.slug)],
      );
      expect(rows.map((r) => r.heroImageUrl)).toEqual([
        'https://res.cloudinary.com/demo-cloud/image/upload/v1/evergreen/demo/banner-collection-new-arrivals.png',
        null,
        null,
        null,
        null,
        null,
      ]);
    });

    it('images added by a later run attach to the products that already exist, without duplicates or deletions', async () => {
      await seedBase();
      await seedCatalogExpansion(dataSource, {
        ...testOptions,
        images: manifestFor(2),
      });
      const [leggings] = await dataSource.query<Array<{ id: number }>>(
        `SELECT id FROM products WHERE slug = 'studio-high-rise-leggings'`,
      );
      // An admin uploads a picture of their own to a new product.
      await dataSource.query(
        `INSERT INTO product_images ("productId", url, "storageKey", "altText", position, "isPrimary")
         VALUES ($1, 'https://res.cloudinary.com/demo-cloud/image/upload/v9/manual/leggings.jpg', 'manual/leggings', 'Admin picture', 9, false)`,
        [leggings.id],
      );
      const before = await dataSource.query<Array<{ id: number }>>(
        `SELECT id FROM product_images ORDER BY id`,
      );

      const again = await seedCatalogExpansion(dataSource, {
        ...testOptions,
        images: manifestFor(4),
      });

      expect(again.products.created).toBe(0);
      // Four products now: 3 + 3 + 2 + 2 colours.
      expect(again.images).toBe(10);
      expect(await count('product_images')).toBe(11);
      const after = await dataSource.query<Array<{ id: number }>>(
        `SELECT id FROM product_images ORDER BY id`,
      );
      // Every image that was there is still there.
      expect(after.slice(0, before.length)).toEqual(before);
      expect(
        await dataSource.query(
          `SELECT 1 FROM product_images WHERE "altText" = 'Admin picture'`,
        ),
      ).toHaveLength(1);
      // A rerun with the same manifest adds nothing.
      await seedCatalogExpansion(dataSource, {
        ...testOptions,
        images: manifestFor(4),
      });
      expect(await count('product_images')).toBe(11);
    });

    it('reads no image file for the test target by default and reports every new product as without image', async () => {
      await seedBase();

      const summary = await seedCatalogExpansion(dataSource, testOptions);

      expect(summary.images).toBe(0);
      expect(summary.newProductsWithoutImages).toBe(44);
    });
  });

  describe('safety', () => {
    it('refuses a database that is not the one for the target, before writing anything', async () => {
      await seedBase();

      await expect(
        seedCatalogExpansion(dataSource, {
          target: 'development',
          nodeEnvironment: 'test',
        }),
      ).rejects.toThrow('requires database ecommerce_dev');
      await expect(
        seedCatalogExpansion(dataSource, {
          target: 'test',
          nodeEnvironment: 'development',
        }),
      ).rejects.toThrow('requires NODE_ENV=test');
      await expect(
        seedCatalogExpansion(dataSource, {
          target: 'test',
          nodeEnvironment: 'production',
        }),
      ).rejects.toThrow('disabled in production');

      expect(await count('products')).toBe(26);
    });

    it('refuses the production target without NODE_ENV, the confirmation or the exact database name', async () => {
      await seedBase();

      await expect(
        seedCatalogExpansion(dataSource, {
          ...productionOptions,
          nodeEnvironment: 'test',
        }),
      ).rejects.toThrow('requires NODE_ENV=production');
      await expect(
        seedCatalogExpansion(dataSource, {
          ...productionOptions,
          productionApproval: { database: 'ecommerce_test' },
        }),
      ).rejects.toThrow('requires explicit confirmation');
      await expect(
        seedCatalogExpansion(dataSource, {
          ...productionOptions,
          productionApproval: {
            confirmation: 'yes',
            database: 'ecommerce_test',
          },
        }),
      ).rejects.toThrow('requires explicit confirmation');
      await expect(
        seedCatalogExpansion(dataSource, {
          ...productionOptions,
          productionApproval: {
            confirmation: PRODUCTION_DEMO_CONFIRMATION,
            database: 'some_other_database',
          },
        }),
      ).rejects.toThrow('database confirmation does not match');
      await expect(
        seedCatalogExpansion(dataSource, {
          ...productionOptions,
          productionApproval: {
            confirmation: PRODUCTION_DEMO_CONFIRMATION,
          },
        }),
      ).rejects.toThrow('database confirmation does not match');

      expect(await count('products')).toBe(26);
    });

    it('fails with a clear message when the base demo catalog is missing, and writes nothing', async () => {
      await expect(
        seedCatalogExpansion(dataSource, testOptions),
      ).rejects.toThrow(/base demo catalog is not in this database/);
      await expect(
        seedCatalogExpansion(dataSource, testOptions),
      ).rejects.toThrow(/Run the base demo seed first/);

      expect(await count('products')).toBe(0);
      expect(await count('categories')).toBe(0);
      expect(await count('coupons')).toBe(0);
    });

    it('names what is missing when only part of the base catalog is there', async () => {
      await seedBase();
      await dataSource.query(
        `DELETE FROM products WHERE slug = 'heavy-canvas-daily-tote-bag'`,
      );
      await dataSource.query(
        `UPDATE products SET "brandId" = NULL
         WHERE "brandId" = (SELECT id FROM brands WHERE slug = 'veloce-active')`,
      );
      await dataSource.query(`DELETE FROM brands WHERE slug = 'veloce-active'`);

      let message = '';
      try {
        await seedCatalogExpansion(dataSource, testOptions);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toMatch(/base products \(for example/);
      expect(message).toMatch(/base brands: Veloce Active/);
      expect(message).toMatch(/Run the base demo seed first/);
      expect(await count('collections')).toBe(2);
      expect(
        await dataSource.query(
          `SELECT id FROM products WHERE slug = 'bucket-hat'`,
        ),
      ).toEqual([]);
    });

    it('runs in one transaction: a failure part-way leaves nothing behind', async () => {
      await seedBase();
      await dataSource.query(`
        CREATE FUNCTION fail_for_new_collection_members() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'insert refused for the test';
        END;
        $$ LANGUAGE plpgsql
      `);
      await dataSource.query(`
        CREATE TRIGGER fail_for_new_collection_members BEFORE INSERT ON collection_products
        FOR EACH ROW EXECUTE FUNCTION fail_for_new_collection_members()
      `);
      const before = await snapshot();

      try {
        await expect(
          seedCatalogExpansion(dataSource, testOptions),
        ).rejects.toThrow(/insert refused for the test/);
      } finally {
        await dataSource.query(
          `DROP TRIGGER fail_for_new_collection_members ON collection_products`,
        );
        await dataSource.query(
          `DROP FUNCTION fail_for_new_collection_members()`,
        );
      }

      expect(await snapshot()).toEqual(before);
      expect(await count('products')).toBe(26);
      // The same run works once the cause is gone.
      const retry = await seedCatalogExpansion(dataSource, testOptions);
      expect(retry.products.created).toBe(44);
    });
  });

  describe('the base seed is unchanged', () => {
    it('seed:demo:test still produces exactly 26 products, 5 categories, 4 brands and 72 variants', async () => {
      await seedBase();

      expect(await count('products')).toBe(26);
      expect(await count('categories')).toBe(5);
      expect(await count('brands')).toBe(4);
      expect(await count('product_variants')).toBe(72);
    });

    it('has no npm script and no test runner that runs the expansion against the test database', () => {
      const root = join(__dirname, '..', '..');
      const scripts = (
        JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        }
      ).scripts;
      const expansionScripts = Object.entries(scripts).filter(([, command]) =>
        command.includes('catalog-expansion'),
      );

      expect(expansionScripts.map(([name]) => name).sort()).toEqual([
        'seed:demo:catalog',
        'seed:demo:catalog:production',
      ]);
      expect(
        readFileSync(
          join(root, 'src/database/seeds/demo-seed-test.runner.ts'),
          'utf8',
        ),
      ).not.toContain('catalog-expansion');
    });
  });
});
