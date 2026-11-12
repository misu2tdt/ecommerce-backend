import { DataSource, EntityManager, In } from 'typeorm';
import { Brand } from '../../../brands/entities/brand.entity';
import { createSlug } from '../../../catalog/slug';
import { Category } from '../../../categories/entities/category.entity';
import { CollectionProduct } from '../../../collections/entities/collection-product.entity';
import { Collection } from '../../../collections/entities/collection.entity';
import { Coupon } from '../../../promotions/entities/coupon.entity';
import { ProductImage } from '../../../products/entities/product-image.entity';
import { ProductStatus } from '../../../products/entities/product-status.enum';
import { ProductVariant } from '../../../products/entities/product-variant.entity';
import { Product } from '../../../products/entities/product.entity';
import type { DemoImageManifest, DemoImageSlot } from '../demo-image-manifest';
import {
  brandDefinitions,
  categoryDefinitions,
  getDemoImageSlots,
  resolveImageManifest,
  syncProductImages,
} from '../demo-seed';
import {
  assertSafeDemoSeedDatabase,
  type DemoSeedTarget,
} from '../demo-seed-safety';
import {
  BATCH1_BRANDS,
  BATCH1_CATEGORIES,
  BATCH1_COLLECTIONS,
  BATCH1_COUPONS,
  BATCH1_PRODUCTS,
} from './batch1.data';
import {
  collectionBannerName,
  getCatalogExpansionImageSlots,
} from './image-slots';
import { getBatch1Variants } from './variants';

const INSERT_CHUNK_SIZE = 100;
const BASE_SEED_HINT =
  'Run the base demo seed first (npm run seed:demo for development, npm run seed:demo:production for the public demo), then run this seed again.';

export interface CatalogExpansionOptions {
  target: DemoSeedTarget;
  nodeEnvironment?: string;
  productionApproval?: {
    confirmation?: string;
    database?: string;
  };
  // 'none': no images. 'file': read demo-images.json. A manifest object is used
  // as given. Left out, the test target gets no images and the others read the
  // file (the same rule as the base seed).
  images?: 'none' | 'file' | DemoImageManifest;
  // Overrides where 'file' reads from (tests and tooling only).
  imagesFile?: string;
}

export interface EntityCounts {
  created: number;
  alreadyPresent: number;
}

export interface CatalogExpansionSummary {
  categories: EntityCounts;
  brands: EntityCounts;
  products: EntityCounts;
  variants: EntityCounts;
  collections: EntityCounts;
  // Members written into the collections created by this run.
  collectionMembers: number;
  coupons: EntityCounts;
  // Image slots of the batch 1 products that a manifest entry covers.
  images: number;
  // Batch 1 products that have no image at all after this run.
  newProductsWithoutImages: number;
}

// Adds batch 1 of the catalog expansion on top of the base demo catalog. It only
// inserts what is missing (categories and brands by slug, products by slug,
// variants by SKU, coupons by code, collections by slug) and never changes a row
// that exists, so an admin's edits and the stock that orders took survive a rerun.
// Images are attached with the same rules as the base seed and are never deleted.
// It never touches users. Everything runs in one transaction.
export async function seedCatalogExpansion(
  dataSource: DataSource,
  options: CatalogExpansionOptions,
): Promise<CatalogExpansionSummary> {
  assertSafeDemoSeedDatabase(
    dataSource,
    options.target,
    options.nodeEnvironment,
    options.productionApproval,
  );
  if (!dataSource.isInitialized) {
    throw new Error('Catalog expansion DataSource must be initialized');
  }
  const imageManifest = resolveImageManifest(options);

  return dataSource.transaction(async (manager) => {
    await requireBaseCatalog(manager);

    const categories = await insertMissingCategories(manager);
    const brands = await insertMissingBrands(manager);
    const products = await insertMissingProducts(manager);
    const variants = await insertMissingVariants(manager, products.byName);

    const slots = getCatalogExpansionImageSlots();
    const images = imageManifest
      ? await syncProductImages(manager, products.byName, imageManifest, slots)
      : 0;

    const coupons = await insertMissingCoupons(manager);
    const collections = await insertMissingCollections(
      manager,
      products.byName,
      imageManifest,
    );

    return {
      categories,
      brands,
      products: products.counts,
      variants,
      collections: collections.counts,
      collectionMembers: collections.members,
      coupons,
      images,
      newProductsWithoutImages: await countProductsWithoutImages(
        manager,
        products.byName,
      ),
    };
  });
}

// The lines the runners print: created and already-present counts per entity,
// then how many new products still have no image.
export function formatCatalogExpansionSummary(
  summary: CatalogExpansionSummary,
): string[] {
  const row = (label: string, counts: EntityCounts) =>
    `${label}: created ${counts.created}, already present ${counts.alreadyPresent}`;
  return [
    row('Categories', summary.categories),
    row('Brands', summary.brands),
    row('Products', summary.products),
    row('Variants', summary.variants),
    row('Collections', summary.collections),
    `Collection members added: ${summary.collectionMembers}`,
    row('Coupons', summary.coupons),
    `Product images attached or kept: ${summary.images}`,
    `New products still without an image: ${summary.newProductsWithoutImages}`,
  ];
}

// The distinct products of the base demo catalog, as the image tooling lists them.
export function getBaseProducts(
  slots: readonly DemoImageSlot[] = getDemoImageSlots(),
): Array<{ name: string; slug: string }> {
  const seen = new Map<string, string>();
  for (const slot of slots) seen.set(slot.productSlug, slot.productName);
  return [...seen].map(([slug, name]) => ({ name, slug }));
}

// Stops with a plain message when the base catalog this batch is built on is not
// there: its 26 products, and the categories and brands they and this batch use.
async function requireBaseCatalog(manager: EntityManager): Promise<void> {
  const baseProducts = getBaseProducts();
  const productSlugs = new Set(
    (
      await manager.getRepository(Product).find({
        select: { slug: true },
        where: { slug: In(baseProducts.map((product) => product.slug)) },
      })
    ).map((product) => product.slug),
  );
  const categorySlugs = new Set(
    (
      await manager.getRepository(Category).find({
        select: { slug: true },
        where: {
          slug: In(categoryDefinitions.map(({ name }) => createSlug(name))),
        },
      })
    ).map((category) => category.slug),
  );
  const brandSlugs = new Set(
    (
      await manager.getRepository(Brand).find({
        select: { slug: true },
        where: {
          slug: In(brandDefinitions.map(({ name }) => createSlug(name))),
        },
      })
    ).map((brand) => brand.slug),
  );

  const missing: string[] = [];
  const missingProducts = baseProducts.filter(
    (product) => !productSlugs.has(product.slug),
  );
  if (missingProducts.length > 0) {
    missing.push(
      `${missingProducts.length} of ${baseProducts.length} base products (for example "${missingProducts[0].name}")`,
    );
  }
  const missingCategories = categoryDefinitions.filter(
    ({ name }) => !categorySlugs.has(createSlug(name)),
  );
  if (missingCategories.length > 0) {
    missing.push(
      `base categories: ${missingCategories.map(({ name }) => name).join(', ')}`,
    );
  }
  const missingBrands = brandDefinitions.filter(
    ({ name }) => !brandSlugs.has(createSlug(name)),
  );
  if (missingBrands.length > 0) {
    missing.push(
      `base brands: ${missingBrands.map(({ name }) => name).join(', ')}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `The base demo catalog is not in this database (missing ${missing.join('; ')}). ${BASE_SEED_HINT}`,
    );
  }
}

async function insertMissingCategories(manager: EntityManager) {
  const repository = manager.getRepository(Category);
  const existing = await repository.find({
    select: { slug: true },
    where: { slug: In(BATCH1_CATEGORIES.map((category) => category.slug)) },
  });
  const present = new Set(existing.map((category) => category.slug));

  const missing = BATCH1_CATEGORIES.filter(
    (category) => !present.has(category.slug),
  );
  if (missing.length > 0) {
    await repository.insert(
      missing.map(({ name, slug, description }) => ({
        name,
        slug,
        description,
      })),
    );
  }
  return {
    created: missing.length,
    alreadyPresent: BATCH1_CATEGORIES.length - missing.length,
  };
}

async function insertMissingBrands(manager: EntityManager) {
  const repository = manager.getRepository(Brand);
  const newBrands = BATCH1_BRANDS.map((brand) => ({
    ...brand,
    slug: createSlug(brand.name),
  }));
  const existing = await repository.find({
    select: { slug: true },
    where: { slug: In(newBrands.map((brand) => brand.slug)) },
  });
  const present = new Set(existing.map((brand) => brand.slug));

  const missing = newBrands.filter((brand) => !present.has(brand.slug));
  if (missing.length > 0) {
    await repository.insert(
      missing.map(({ name, slug, description }) => ({
        name,
        slug,
        description,
      })),
    );
  }
  return {
    created: missing.length,
    alreadyPresent: newBrands.length - missing.length,
  };
}

async function insertMissingProducts(manager: EntityManager) {
  const repository = manager.getRepository(Product);
  const categories = new Map(
    (
      await manager.getRepository(Category).find({
        where: {
          slug: In(BATCH1_PRODUCTS.map((p) => createSlug(p.category))),
        },
      })
    ).map((category) => [category.slug, category]),
  );
  const brands = new Map(
    (
      await manager.getRepository(Brand).find({
        where: { slug: In(BATCH1_PRODUCTS.map((p) => createSlug(p.brand))) },
      })
    ).map((brand) => [brand.slug, brand]),
  );

  const slugs = BATCH1_PRODUCTS.map((product) => product.slug);
  const present = new Set(
    (
      await repository.find({
        select: { slug: true },
        where: { slug: In(slugs) },
      })
    ).map((product) => product.slug),
  );
  const missing = BATCH1_PRODUCTS.filter(
    (product) => !present.has(product.slug),
  );

  for (const group of chunk(missing, INSERT_CHUNK_SIZE)) {
    await repository.insert(
      group.map((product) => ({
        name: product.name,
        slug: product.slug,
        description: product.description,
        status: ProductStatus.ACTIVE,
        categoryId: requireFound(
          categories.get(createSlug(product.category)),
          `category "${product.category}"`,
        ).id,
        brandId: requireFound(
          brands.get(createSlug(product.brand)),
          `brand "${product.brand}"`,
        ).id,
      })),
    );
  }

  const bySlug = new Map(
    (await repository.find({ where: { slug: In(slugs) } })).map((product) => [
      product.slug,
      product,
    ]),
  );
  const byName = new Map(
    BATCH1_PRODUCTS.map((definition) => [
      definition.name,
      requireFound(bySlug.get(definition.slug), `product "${definition.name}"`),
    ]),
  );
  return {
    byName,
    counts: {
      created: missing.length,
      alreadyPresent: BATCH1_PRODUCTS.length - missing.length,
    },
  };
}

async function insertMissingVariants(
  manager: EntityManager,
  products: ReadonlyMap<string, Product>,
): Promise<EntityCounts> {
  const repository = manager.getRepository(ProductVariant);
  const definitions = getBatch1Variants();
  const present = new Set(
    (
      await repository.find({
        select: { sku: true },
        where: { sku: In(definitions.map((variant) => variant.sku)) },
      })
    ).map((variant) => variant.sku),
  );
  const missing = definitions.filter((variant) => !present.has(variant.sku));

  for (const group of chunk(missing, INSERT_CHUNK_SIZE)) {
    await repository.insert(
      group.map((variant) => ({
        productId: requireFound(
          products.get(variant.productName),
          `product "${variant.productName}"`,
        ).id,
        sku: variant.sku,
        name: variant.name,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        stock: variant.stock,
        attributes: { ...variant.attributes },
        isActive: true,
        position: variant.position,
      })),
    );
  }
  return {
    created: missing.length,
    alreadyPresent: definitions.length - missing.length,
  };
}

async function insertMissingCoupons(
  manager: EntityManager,
): Promise<EntityCounts> {
  const repository = manager.getRepository(Coupon);
  const present = new Set(
    (
      await repository.find({
        select: { code: true },
        where: { code: In(BATCH1_COUPONS.map((coupon) => coupon.code)) },
      })
    ).map((coupon) => coupon.code),
  );
  const missing = BATCH1_COUPONS.filter((coupon) => !present.has(coupon.code));
  if (missing.length > 0) {
    await repository.insert(
      missing.map((coupon) => ({
        ...coupon,
        isActive: true,
        startsAt: null,
        endsAt: null,
      })),
    );
  }
  return {
    created: missing.length,
    alreadyPresent: BATCH1_COUPONS.length - missing.length,
  };
}

// Creates the collections that are not there yet, with their members in the listed
// order. A collection that exists is left exactly as it is, members included.
async function insertMissingCollections(
  manager: EntityManager,
  batchProducts: ReadonlyMap<string, Product>,
  manifest: DemoImageManifest | null,
) {
  const repository = manager.getRepository(Collection);
  const present = new Set(
    (
      await repository.find({
        select: { slug: true },
        where: {
          slug: In(BATCH1_COLLECTIONS.map((collection) => collection.slug)),
        },
      })
    ).map((collection) => collection.slug),
  );
  const missing = BATCH1_COLLECTIONS.filter(
    (collection) => !present.has(collection.slug),
  );

  let members = 0;
  if (missing.length > 0) {
    const productsByName = await resolveProductsByName(
      manager,
      batchProducts,
      missing.flatMap((collection) => collection.products),
    );
    for (const definition of missing) {
      const ids = definition.products.map((name) => {
        const product = productsByName.get(name);
        if (!product) {
          throw new Error(
            `The collection "${definition.name}" needs the product "${name}", which is not in this database. ${BASE_SEED_HINT}`,
          );
        }
        return product.id;
      });
      const hero = manifest?.banners.find(
        (banner) => banner.name === collectionBannerName(definition.slug),
      );
      const created = await repository.save(
        repository.create({
          slug: definition.slug,
          name: definition.name,
          description: definition.description,
          heroImageUrl: hero?.url ?? null,
          isActive: true,
          isFeatured: definition.isFeatured,
          sortOrder: definition.sortOrder,
        }),
      );
      await manager.insert(
        CollectionProduct,
        ids.map((productId, position) => ({
          collectionId: created.id,
          productId,
          position,
        })),
      );
      members += ids.length;
    }
  }
  return {
    members,
    counts: {
      created: missing.length,
      alreadyPresent: BATCH1_COLLECTIONS.length - missing.length,
    },
  };
}

// Finds the products a collection names: this batch's, and the base catalog's
// (found by the slug the base seed gave them).
async function resolveProductsByName(
  manager: EntityManager,
  batchProducts: ReadonlyMap<string, Product>,
  names: readonly string[],
): Promise<Map<string, Product>> {
  const resolved = new Map<string, Product>();
  const slugByBaseName = new Map(
    getBaseProducts().map((product) => [product.name, product.slug]),
  );
  const baseSlugs: string[] = [];
  for (const name of new Set(names)) {
    const batchProduct = batchProducts.get(name);
    if (batchProduct) {
      resolved.set(name, batchProduct);
      continue;
    }
    const slug = slugByBaseName.get(name);
    if (slug) baseSlugs.push(slug);
  }
  if (baseSlugs.length > 0) {
    const rows = await manager
      .getRepository(Product)
      .find({ where: { slug: In(baseSlugs) } });
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    for (const [name, slug] of slugByBaseName) {
      const row = bySlug.get(slug);
      if (row) resolved.set(name, row);
    }
  }
  return resolved;
}

async function countProductsWithoutImages(
  manager: EntityManager,
  products: ReadonlyMap<string, Product>,
): Promise<number> {
  const ids = [...products.values()].map((product) => product.id);
  const withImages = await manager
    .getRepository(ProductImage)
    .createQueryBuilder('image')
    .select('image.productId', 'productId')
    .distinct(true)
    .where('image.productId IN (:...ids)', { ids })
    .getRawMany<{ productId: number }>();
  return ids.length - withImages.length;
}

function requireFound<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Catalog expansion could not find ${what}`);
  }
  return value;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}
