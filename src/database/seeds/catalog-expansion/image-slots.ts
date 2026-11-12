import { createSlug } from '../../../catalog/slug';
import type { DemoImageSlot } from '../demo-image-manifest';
import { BATCH1_COLLECTIONS, BATCH1_PRODUCTS } from './batch1.data';

// The prefix of a collection's cover image in the manifest's banner list.
export const COLLECTION_BANNER_PREFIX = 'banner-collection-';

export function collectionBannerName(collectionSlug: string): string {
  return `${COLLECTION_BANNER_PREFIX}${collectionSlug}`;
}

// One image slot per colour of each batch 1 product, in the colour order of the
// data (the first colour is the primary image). The seed and the image tooling
// both read this, so the file names the uploader expects match what the seed
// attaches.
export function getCatalogExpansionImageSlots(): DemoImageSlot[] {
  return BATCH1_PRODUCTS.flatMap((product) =>
    product.colours.map((colour) => ({
      productName: product.name,
      productSlug: product.slug,
      colorName: colour.name,
      colorSlug: createSlug(colour.name),
    })),
  );
}

// The banner-style images the batch 1 pages read: two category banners and one
// cover image for each collection.
export const CATALOG_EXPANSION_BANNER_NAMES: readonly string[] = [
  'category-activewear',
  'category-loungewear-sleepwear',
  ...BATCH1_COLLECTIONS.map((collection) =>
    collectionBannerName(collection.slug),
  ),
];
