import {
  BATCH1_LOW_STOCK_VARIANTS,
  BATCH1_PRODUCTS,
  BATCH1_SOLD_OUT_VARIANTS,
} from './batch1.data';
import type {
  CatalogProductDefinition,
  CatalogVariantDefinition,
  StockOverride,
} from './catalog-types';

// Size codes used in SKUs. A size that is not listed is its own code ("XS",
// "S", "30").
const SIZE_CODES: Readonly<Record<string, string>> = {
  'One Size': 'OS',
  'S/M': 'SM',
  'L/XL': 'LXL',
  '38/39': '3839',
  '40/41': '4041',
  '42/43': '4243',
};

// Stock multiplier of each size, in tenths (so 0.8 is 8): all arithmetic stays
// in whole numbers and rounds the same way everywhere.
const SIZE_FACTOR_TENTHS: Readonly<Record<string, number>> = {
  XS: 5,
  S: 8,
  M: 12,
  L: 12,
  XL: 7,
  'One Size': 10,
  'S/M': 10,
  'L/XL': 10,
  '30': 7,
  '32': 11,
  '34': 10,
  '36': 6,
  '38/39': 8,
  '40/41': 10,
  '42/43': 8,
};

// The first colour of a product keeps the full factor, later colours sell less.
const FIRST_COLOUR_FACTOR_PERCENT = 100;
const OTHER_COLOUR_FACTOR_PERCENT = 85;
export const MINIMUM_VARIANT_STOCK = 3;

export function sizeCode(size: string): string {
  const code = SIZE_CODES[size] ?? size;
  if (!/^[A-Z0-9]+$/.test(code)) {
    throw new Error(`Size "${size}" has no valid SKU code`);
  }
  return code;
}

export function variantSku(
  skuPrefix: string,
  colourCode: string,
  size: string,
): string {
  return `${skuPrefix}-${colourCode}-${sizeCode(size)}`;
}

// round(baseStock x size factor x colour factor), at least 3. Halves round up.
export function formulaStock(
  baseStock: number,
  size: string,
  colourIndex: number,
): number {
  const sizeFactor = SIZE_FACTOR_TENTHS[size];
  if (sizeFactor === undefined) {
    throw new Error(`Size "${size}" has no stock factor`);
  }
  const colourFactor =
    colourIndex === 0
      ? FIRST_COLOUR_FACTOR_PERCENT
      : OTHER_COLOUR_FACTOR_PERCENT;
  const rounded = Math.floor(
    (baseStock * sizeFactor * colourFactor + 500) / 1000,
  );
  return Math.max(MINIMUM_VARIANT_STOCK, rounded);
}

const overrideKey = (product: string, colour: string, size: string) =>
  `${product}|${colour}|${size}`;

// Every colour x size of every product, colour by colour, with the sold-out and
// low-stock overrides applied last. Throws when an override names a variant that
// does not exist, so a typo can never be silently ignored.
export function buildCatalogVariants(
  products: readonly CatalogProductDefinition[],
  overrides: readonly StockOverride[],
): CatalogVariantDefinition[] {
  const overrideStock = new Map(
    overrides.map((override) => [
      overrideKey(override.product, override.colour, override.size),
      override.stock,
    ]),
  );
  const applied = new Set<string>();
  const variants: CatalogVariantDefinition[] = [];

  for (const product of products) {
    const singleSize = product.sizes.length === 1;
    let position = 0;
    for (const [colourIndex, colour] of product.colours.entries()) {
      for (const size of product.sizes) {
        const key = overrideKey(product.name, colour.name, size);
        const override = overrideStock.get(key);
        if (override !== undefined) applied.add(key);
        variants.push({
          productName: product.name,
          sku: variantSku(product.skuPrefix, colour.code, size),
          name: singleSize ? colour.name : `${colour.name} / ${size}`,
          price: product.price,
          compareAtPrice: product.compareAtPrice,
          stock: override ?? formulaStock(product.baseStock, size, colourIndex),
          attributes: { size, color: colour.name },
          position,
        });
        position += 1;
      }
    }
  }

  const unmatched = [...overrideStock.keys()].filter(
    (key) => !applied.has(key),
  );
  if (unmatched.length > 0) {
    throw new Error(
      `Stock overrides match no variant: ${unmatched.join('; ')}`,
    );
  }
  return variants;
}

let batch1Variants: CatalogVariantDefinition[] | undefined;

export function getBatch1Variants(): CatalogVariantDefinition[] {
  batch1Variants ??= buildCatalogVariants(BATCH1_PRODUCTS, [
    ...BATCH1_SOLD_OUT_VARIANTS,
    ...BATCH1_LOW_STOCK_VARIANTS,
  ]);
  return batch1Variants;
}
