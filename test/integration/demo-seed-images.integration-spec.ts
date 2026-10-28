import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  getDemoImageSlots,
  seedDemoData,
} from '../../src/database/seeds/demo-seed';
import {
  serializeDemoImageManifest,
  type DemoImageManifest,
} from '../../src/database/seeds/demo-image-manifest';
import { PRODUCTION_DEMO_CONFIRMATION } from '../../src/database/seeds/demo-seed-safety';
import { ProductImage } from '../../src/products/entities/product-image.entity';
import { Product } from '../../src/products/entities/product.entity';
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

function buildManifest(version = 1): DemoImageManifest {
  return {
    products: getDemoImageSlots().map((slot) => ({
      productSlug: slot.productSlug,
      colorSlug: slot.colorSlug,
      url: `https://res.cloudinary.com/demo-cloud/image/upload/v${version}/evergreen/demo/${slot.productSlug}__${slot.colorSlug}.jpg`,
      width: 1024,
      height: 1536,
    })),
    banners: [
      {
        name: 'banner-home',
        url: `https://res.cloudinary.com/demo-cloud/image/upload/v${version}/evergreen/demo/banner-home.jpg`,
        width: 1536,
        height: 1024,
      },
    ],
  };
}

describe('demo seed product images on isolated PostgreSQL', () => {
  let dataSource: DataSource;
  let folder: string;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    folder = mkdtempSync(join(tmpdir(), 'demo-seed-images-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  const images = () => dataSource.getRepository(ProductImage);
  const productBySlug = (slug: string) =>
    dataSource.getRepository(Product).findOneByOrFail({ slug });
  const imagesOf = async (slug: string) => {
    const product = await productBySlug(slug);
    return images().find({
      where: { productId: product.id },
      order: { position: 'ASC', id: 'ASC' },
    });
  };
  const writeManifestFile = (manifest: DemoImageManifest) => {
    const file = join(folder, 'demo-images.json');
    writeFileSync(file, serializeDemoImageManifest(manifest));
    return file;
  };

  it('attaches one image per colour with position, primary flag and alt text', async () => {
    const summary = await seedDemoData(dataSource, {
      ...testOptions,
      images: buildManifest(),
    });

    expect(summary.images).toBe(48);
    expect(await images().count()).toBe(48);

    const tee = await imagesOf('classic-crewneck-cotton-tee');
    expect(
      tee.map((image) => [image.position, image.isPrimary, image.altText]),
    ).toEqual([
      [0, true, 'Classic Crewneck Cotton Tee in Black'],
      [1, false, 'Classic Crewneck Cotton Tee in White'],
    ]);
    expect(tee[0].url).toContain('/classic-crewneck-cotton-tee__black.jpg');
    expect(tee[1].url).toContain('/classic-crewneck-cotton-tee__white.jpg');

    // The position follows the product's colour list in the seed.
    const trunks = await imagesOf('seamless-modal-trunks-2-pack');
    expect(trunks).toHaveLength(1);
    expect(trunks[0].altText).toBe(
      'Seamless Modal Trunks 2-Pack in Black & Grey',
    );

    const primaryPerProduct = await dataSource.query<
      { productId: number; primaries: string }[]
    >(
      `SELECT "productId", COUNT(*) FILTER (WHERE "isPrimary") AS primaries FROM product_images GROUP BY "productId"`,
    );
    expect(primaryPerProduct).toHaveLength(26);
    expect(primaryPerProduct.every((row) => Number(row.primaries) === 1)).toBe(
      true,
    );
  });

  it('does not store banner images on products', async () => {
    await seedDemoData(dataSource, { ...testOptions, images: buildManifest() });

    const urls = (await images().find()).map((image) => image.url);
    expect(urls.some((url) => url.includes('banner-home'))).toBe(false);
  });

  it('creates no duplicates on a second run', async () => {
    const options = { ...productionOptions, images: buildManifest() };
    await seedDemoData(dataSource, options);
    const before = await images().find({ order: { id: 'ASC' } });

    const second = await seedDemoData(dataSource, options);
    const after = await images().find({ order: { id: 'ASC' } });

    expect(second.images).toBe(48);
    expect(after).toHaveLength(48);
    expect(after.map((image) => image.id)).toEqual(
      before.map((image) => image.id),
    );
  });

  it('adds images to products that already exist without images (the production case)', async () => {
    await seedDemoData(dataSource, { ...productionOptions, images: 'none' });
    expect(await images().count()).toBe(0);
    const productIds = (await dataSource.getRepository(Product).find()).map(
      (p) => p.id,
    );

    await seedDemoData(dataSource, {
      ...productionOptions,
      images: buildManifest(),
    });

    expect(await images().count()).toBe(48);
    expect(
      (await dataSource.getRepository(Product).find()).map((p) => p.id),
    ).toEqual(productIds);
  });

  it('keeps an image an admin uploaded manually, including its primary flag', async () => {
    await seedDemoData(dataSource, { ...testOptions, images: 'none' });
    const tee = await productBySlug('classic-crewneck-cotton-tee');
    const hoodie = await productBySlug('french-terry-full-zip-hoodie');
    const manualPrimary = await images().save({
      productId: tee.id,
      url: 'https://res.cloudinary.com/demo-cloud/image/upload/v9/manual/tee-hero.jpg',
      storageKey: 'ecommerce/products/1/hero',
      altText: 'Admin hero',
      position: 0,
      isPrimary: true,
    });
    const manualSecondary = await images().save({
      productId: hoodie.id,
      url: 'https://res.cloudinary.com/demo-cloud/image/upload/v9/manual/hoodie-extra.jpg',
      storageKey: 'ecommerce/products/2/extra',
      altText: 'Admin extra',
      position: 5,
      isPrimary: false,
    });

    const options = { ...testOptions, images: buildManifest() };
    await seedDemoData(dataSource, options);
    await seedDemoData(dataSource, options);

    const teeImages = await imagesOf('classic-crewneck-cotton-tee');
    expect(teeImages).toHaveLength(3);
    const keptPrimary = teeImages.find(
      (image) => image.id === manualPrimary.id,
    )!;
    expect(keptPrimary).toMatchObject({
      url: manualPrimary.url,
      storageKey: 'ecommerce/products/1/hero',
      altText: 'Admin hero',
      isPrimary: true,
    });
    // The admin's primary choice wins: demo images are added as non-primary.
    expect(teeImages.filter((image) => image.isPrimary)).toHaveLength(1);

    const hoodieImages = await imagesOf('french-terry-full-zip-hoodie');
    expect(hoodieImages).toHaveLength(3);
    expect(
      await images().findOneByOrFail({ id: manualSecondary.id }),
    ).toMatchObject({ position: 5, isPrimary: false, altText: 'Admin extra' });
    // No admin primary there, so the first demo image becomes primary.
    expect(hoodieImages.filter((image) => image.isPrimary)).toHaveLength(1);
    expect(hoodieImages.find((image) => image.isPrimary)?.url).toContain(
      'french-terry-full-zip-hoodie__heather-grey',
    );
  });

  it('repairs drifted position and primary flags without creating rows', async () => {
    const options = { ...testOptions, images: buildManifest() };
    await seedDemoData(dataSource, options);
    const tee = await imagesOf('classic-crewneck-cotton-tee');
    await images().update({ id: tee[0].id }, { isPrimary: false, position: 7 });
    await images().update(
      { id: tee[1].id },
      { isPrimary: true, position: 3, altText: 'edited' },
    );
    const total = await images().count();

    await seedDemoData(dataSource, options);

    expect(await images().count()).toBe(total);
    const repaired = await imagesOf('classic-crewneck-cotton-tee');
    expect(
      repaired.map((image) => [image.position, image.isPrimary, image.altText]),
    ).toEqual([
      [0, true, 'Classic Crewneck Cotton Tee in Black'],
      [1, false, 'Classic Crewneck Cotton Tee in White'],
    ]);
  });

  it('updates the url in place when an image is re-uploaded under a new version', async () => {
    await seedDemoData(dataSource, {
      ...testOptions,
      images: buildManifest(1),
    });
    const before = await images().find({ order: { id: 'ASC' } });

    await seedDemoData(dataSource, {
      ...testOptions,
      images: buildManifest(2),
    });
    const after = await images().find({ order: { id: 'ASC' } });

    expect(after).toHaveLength(48);
    expect(after.map((image) => image.id)).toEqual(
      before.map((image) => image.id),
    );
    expect(after.every((image) => image.url.includes('/v2/'))).toBe(true);
  });

  it('seeds without images and prints one warning when the JSON file does not exist', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const summary = await seedDemoData(dataSource, {
      ...productionOptions,
      imagesFile: join(folder, 'missing.json'),
    });

    expect(summary.images).toBe(0);
    expect(summary.products).toBe(26);
    expect(await images().count()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/images:upload/);
  });

  it('reads the JSON file for the development and production targets', async () => {
    const file = writeManifestFile(buildManifest());

    const summary = await seedDemoData(dataSource, {
      ...productionOptions,
      imagesFile: file,
    });

    expect(summary.images).toBe(48);
    expect(await images().count()).toBe(48);
  });

  it('keeps the test seed free of images even when the JSON file exists', async () => {
    const file = writeManifestFile(buildManifest());
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const summary = await seedDemoData(dataSource, {
      ...testOptions,
      imagesFile: file,
    });

    expect(summary.images).toBe(0);
    expect(await images().count()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('attaches images to the test seed only when explicitly asked to read the file', async () => {
    const file = writeManifestFile(buildManifest());

    const summary = await seedDemoData(dataSource, {
      ...testOptions,
      images: 'file',
      imagesFile: file,
    });

    expect(summary.images).toBe(48);
  });

  it('fails clearly, and changes nothing, when the JSON file is corrupt', async () => {
    const file = join(folder, 'demo-images.json');
    writeFileSync(file, '{ not json');

    await expect(
      seedDemoData(dataSource, { ...productionOptions, imagesFile: file }),
    ).rejects.toThrow(/demo-images\.json/);
    expect(await dataSource.getRepository(Product).count()).toBe(0);
  });
});
