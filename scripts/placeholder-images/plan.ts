// What the placeholder generator makes: one picture for each colour of each
// batch 1 product, and the banner-style pictures the batch 1 pages read. The
// file names come from the same data the seed and the upload script use, so a
// generated folder passes `images:upload --catalog all --dry-run`.

import { createSlug } from '../../src/catalog/slug';
import {
  BATCH1_BRANDS,
  BATCH1_CATEGORIES,
  BATCH1_COLLECTIONS,
  BATCH1_PRODUCTS,
} from '../../src/database/seeds/catalog-expansion/batch1.data';
import {
  collectionBannerName,
  getCatalogExpansionImageSlots,
} from '../../src/database/seeds/catalog-expansion/image-slots';
import {
  NEUTRAL_TONE,
  resolvePlaceholderColour,
  type PlaceholderColour,
} from './colours';

// Products are portrait 4:5; banners are the 3:2 landscape the storefront uses.
export const PRODUCT_SIZE = { width: 1024, height: 1280 } as const;
export const BANNER_SIZE = { width: 1536, height: 1024 } as const;
export const PLACEHOLDER_EXTENSION = '.jpg';

export interface PlaceholderItem {
  kind: 'product' | 'banner';
  // The file name the upload script expects, for example
  // "studio-high-rise-leggings__black.jpg" or "category-activewear.jpg".
  fileName: string;
  width: number;
  height: number;
  // The big line of text.
  title: string;
  // A small line above it: the category of a product, or what a banner is for.
  label: string;
  // The colour name (products) or a short description (banners).
  caption: string;
  colour: PlaceholderColour;
}

// Soft neutrals for banners, picked by a hash of the name so a banner always
// gets the same one.
const BANNER_TONES = [
  '#d8d2c6',
  '#cfd6cc',
  '#d6cfd3',
  '#cdd5dc',
  '#dccfbf',
  '#d3d8c9',
  '#d9d0cc',
  '#c9d0d4',
] as const;

export function bannerTone(name: string): string {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return BANNER_TONES[hash % BANNER_TONES.length] ?? NEUTRAL_TONE;
}

// The first sentence of a description (the picture wraps it onto two lines).
export function shortCaption(text: string, maxLength = 120): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0].trim();
  if (sentence.length <= maxLength) return sentence;
  return `${sentence.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildPlaceholderPlan(
  options: { brands?: boolean } = {},
): PlaceholderItem[] {
  const categoryOfProduct = new Map(
    BATCH1_PRODUCTS.map((product) => [product.name, product.category]),
  );
  const items: PlaceholderItem[] = getCatalogExpansionImageSlots().map(
    (slot) => ({
      kind: 'product',
      fileName: `${slot.productSlug}__${slot.colorSlug}${PLACEHOLDER_EXTENSION}`,
      ...PRODUCT_SIZE,
      title: slot.productName,
      label: categoryOfProduct.get(slot.productName) ?? '',
      caption: slot.colorName,
      colour: resolvePlaceholderColour(slot.colorName),
    }),
  );

  const banner = (
    name: string,
    label: string,
    title: string,
    caption: string,
  ): PlaceholderItem => ({
    kind: 'banner',
    fileName: `${name}${PLACEHOLDER_EXTENSION}`,
    ...BANNER_SIZE,
    title,
    label,
    caption,
    colour: { base: bannerTone(name), known: true },
  });

  for (const category of BATCH1_CATEGORIES) {
    items.push(
      banner(
        `category-${category.slug}`,
        'Category',
        category.name,
        shortCaption(category.description),
      ),
    );
  }
  for (const collection of BATCH1_COLLECTIONS) {
    items.push(
      banner(
        collectionBannerName(collection.slug),
        'Collection',
        collection.name,
        shortCaption(collection.description),
      ),
    );
  }
  if (options.brands ?? true) {
    for (const brand of BATCH1_BRANDS) {
      items.push(
        banner(
          `brand-${createSlug(brand.name)}`,
          'Brand',
          brand.name,
          shortCaption(brand.description),
        ),
      );
    }
  }
  return items;
}
