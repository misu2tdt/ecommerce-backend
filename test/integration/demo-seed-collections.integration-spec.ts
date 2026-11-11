import { DataSource } from 'typeorm';
import { Collection } from '../../src/collections/entities/collection.entity';
import { seedDemoData } from '../../src/database/seeds/demo-seed';
import { PRODUCTION_DEMO_CONFIRMATION } from '../../src/database/seeds/demo-seed-safety';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const EVERYDAY = [
  'Classic Crewneck Cotton Tee',
  'Heavyweight Boxy Pocket Tee',
  'Classic Pique Cotton Polo',
  'Everyday Stretch Chino Pants',
  'Bamboo Fiber Boxer Briefs 3-Pack',
  'Cushioned Cotton Crew Socks 3-Pack',
  'Heavy Canvas Daily Tote Bag',
];
const LAYERING = [
  'Waffle Knit Long Sleeve Tee',
  'Relaxed Oxford Button-Down Shirt',
  'Structured Workwear Overshirt',
  'French Terry Full-Zip Hoodie',
  'Heavyweight Pullover Sweatshirt',
  'Packable Trail Windbreaker',
  'Minimalist Technical Bomber Jacket',
];

// The sample collections: development and test only, built from products the seed
// itself creates, the same on every run.
describe('demo seed: sample collections', () => {
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

  const testOptions = { target: 'test' as const, nodeEnvironment: 'test' };
  const productionOptions = {
    target: 'production' as const,
    nodeEnvironment: 'production',
    productionApproval: {
      confirmation: PRODUCTION_DEMO_CONFIRMATION,
      database: 'ecommerce_test',
    },
    images: 'none' as const,
  };

  const membership = () =>
    dataSource.query<Array<{ slug: string; position: number; name: string }>>(
      `SELECT c.slug, cp.position, p.name
       FROM collection_products cp
       JOIN collections c ON c.id = cp."collectionId"
       JOIN products p ON p.id = cp."productId"
       ORDER BY c.slug, cp.position`,
    );

  const counts = async () => {
    const [row] = await dataSource.query<Array<Record<string, string>>>(
      `SELECT
         (SELECT COUNT(*) FROM categories) AS categories,
         (SELECT COUNT(*) FROM brands) AS brands,
         (SELECT COUNT(*) FROM products) AS products,
         (SELECT COUNT(*) FROM product_variants) AS variants`,
    );
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    );
  };

  it('creates two collections from seeded products, one of them featured', async () => {
    const summary = await seedDemoData(dataSource, testOptions);

    expect(summary.collections).toBe(2);
    const collections = await dataSource
      .getRepository(Collection)
      .find({ order: { sortOrder: 'ASC', id: 'ASC' } });
    expect(
      collections.map((collection) => [
        collection.slug,
        collection.name,
        collection.isActive,
        collection.isFeatured,
      ]),
    ).toEqual([
      ['everyday-essentials', 'Everyday Essentials', true, true],
      ['layering-pieces', 'Layering Pieces', true, false],
    ]);

    const rows = await membership();
    expect(
      rows
        .filter((row) => row.slug === 'everyday-essentials')
        .map((row) => row.name),
    ).toEqual(EVERYDAY);
    expect(
      rows
        .filter((row) => row.slug === 'layering-pieces')
        .map((row) => row.name),
    ).toEqual(LAYERING);
    for (const slug of ['everyday-essentials', 'layering-pieces']) {
      expect(
        rows.filter((row) => row.slug === slug).map((row) => row.position),
      ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it('does not change the number of categories, brands, products or variants', async () => {
    await seedDemoData(dataSource, testOptions);

    expect(await counts()).toEqual({
      categories: 5,
      brands: 4,
      products: 26,
      variants: 72,
    });
  });

  it('a rerun gives the same collections and membership, and repairs a changed one', async () => {
    const first = await seedDemoData(dataSource, testOptions);
    const before = await membership();
    const collectionsBefore = await dataSource.query(
      `SELECT id, slug, name, description, "isActive", "isFeatured", "sortOrder" FROM collections ORDER BY id`,
    );
    // Somebody edits a sample collection in the meantime.
    await dataSource.query(
      `DELETE FROM collection_products WHERE position < 3`,
    );
    await dataSource.query(`UPDATE collections SET name = 'Edited'`);

    const second = await seedDemoData(dataSource, testOptions);

    expect(second).toEqual(first);
    expect(await membership()).toEqual(before);
    expect(
      await dataSource.query(
        `SELECT id, slug, name, description, "isActive", "isFeatured", "sortOrder" FROM collections ORDER BY id`,
      ),
    ).toEqual(collectionsBefore);
  });

  it('shows both collections to the public, with seven products each', async () => {
    await seedDemoData(dataSource, testOptions);

    const rows = await dataSource.query<
      Array<{ slug: string; visible: number }>
    >(
      `SELECT c.slug,
              (SELECT COUNT(*)::int FROM collection_products cp
               JOIN products p ON p.id = cp."productId"
               WHERE cp."collectionId" = c.id AND p.status = 'active'
                 AND EXISTS (SELECT 1 FROM product_variants v WHERE v."productId" = p.id AND v."isActive" = true)) AS visible
       FROM collections c ORDER BY c.slug`,
    );
    expect(rows).toEqual([
      { slug: 'everyday-essentials', visible: 7 },
      { slug: 'layering-pieces', visible: 7 },
    ]);
  });

  it('the production target creates no collections yet', async () => {
    const summary = await seedDemoData(dataSource, productionOptions);

    expect(summary.collections).toBe(0);
    expect(await dataSource.query(`SELECT id FROM collections`)).toEqual([]);
    expect(await membership()).toEqual([]);
    // The rest of the production seed is as before.
    expect(summary.products).toBe(26);
    expect(await counts()).toEqual({
      categories: 5,
      brands: 4,
      products: 26,
      variants: 72,
    });
  });

  it('the production target leaves collections that already exist alone', async () => {
    await seedDemoData(dataSource, testOptions);
    const before = await membership();
    await dataSource.query(
      `UPDATE collections SET name = 'Edited by an admin'`,
    );

    await seedDemoData(dataSource, productionOptions);

    expect(await membership()).toEqual(before);
    expect(
      await dataSource.query(`SELECT DISTINCT name FROM collections`),
    ).toEqual([{ name: 'Edited by an admin' }]);
  });
});
