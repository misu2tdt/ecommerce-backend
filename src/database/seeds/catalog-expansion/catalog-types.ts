import type { CouponType } from '../../../promotions/entities/coupon-type.enum';

export interface CatalogCategoryDefinition {
  name: string;
  slug: string;
  description: string;
}

export interface CatalogBrandDefinition {
  name: string;
  description: string;
}

export interface CatalogColour {
  name: string;
  // Short code used in the SKU, for example "BLK".
  code: string;
}

export interface CatalogProductDefinition {
  name: string;
  slug: string;
  // Category and brand are named; the seed finds them by slug.
  category: string;
  brand: string;
  // SKU prefix with the brand code, for example "AM-SHL".
  skuPrefix: string;
  price: number;
  compareAtPrice: number | null;
  colours: readonly CatalogColour[];
  sizes: readonly string[];
  baseStock: number;
  // Names of the collections this product belongs to (cross-checked against the
  // ordered member lists in the tests).
  collections: readonly string[];
  description: string;
}

export interface CatalogCollectionDefinition {
  name: string;
  slug: string;
  description: string;
  isFeatured: boolean;
  sortOrder: number;
  // Product names in display order: products of the base demo catalog and of
  // this batch.
  products: readonly string[];
}

export interface CatalogCouponDefinition {
  code: string;
  name: string;
  type: CouponType;
  value: number;
  minSubtotal: number | null;
  maxDiscount: number | null;
}

// An exact stock for one variant, applied after the stock formula.
export interface StockOverride {
  product: string;
  colour: string;
  size: string;
  stock: number;
}

export interface CatalogVariantDefinition {
  productName: string;
  sku: string;
  name: string;
  price: number;
  compareAtPrice: number | null;
  stock: number;
  attributes: { size: string; color: string };
  position: number;
}
