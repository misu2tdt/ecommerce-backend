import { createSlug } from '../../../catalog/slug';
import { CouponType } from '../../../promotions/entities/coupon-type.enum';
import {
  brandDefinitions,
  categoryDefinitions,
  getSeededVariantStock,
} from '../demo-seed';
import {
  BATCH1_BRANDS,
  BATCH1_CATEGORIES,
  BATCH1_COLLECTIONS,
  BATCH1_COUPONS,
  BATCH1_LOW_STOCK_VARIANTS,
  BATCH1_PRODUCTS,
  BATCH1_SOLD_OUT_VARIANTS,
} from './batch1.data';
import { getBaseProducts } from './catalog-expansion';
import {
  CATALOG_EXPANSION_BANNER_NAMES,
  getCatalogExpansionImageSlots,
} from './image-slots';
import { getBatch1Variants, sizeCode } from './variants';

const BRAND_CODES: Record<string, string> = {
  AeroThread: 'AT',
  'Kanso Basics': 'KB',
  'Veloce Active': 'VA',
  'Monolith Studio': 'MS',
  Tidewell: 'TW',
  Hushwell: 'HW',
  'Ardent Motion': 'AM',
  'Cinder & Oak': 'CO',
};

const baseProducts = getBaseProducts();
const baseNames = new Set(baseProducts.map((product) => product.name));
const baseSlugs = new Set(baseProducts.map((product) => product.slug));
const baseSkus = new Set(getSeededVariantStock().map(({ sku }) => sku));

describe('catalog expansion batch 1 data', () => {
  it('holds 2 categories, 4 brands, 44 products, 6 collections and 2 coupons', () => {
    expect(BATCH1_CATEGORIES).toHaveLength(2);
    expect(BATCH1_BRANDS).toHaveLength(4);
    expect(BATCH1_PRODUCTS).toHaveLength(44);
    expect(BATCH1_COLLECTIONS).toHaveLength(6);
    expect(BATCH1_COUPONS).toHaveLength(2);
    expect(baseProducts).toHaveLength(26);
  });

  it('uses only printable ASCII text', () => {
    const text = JSON.stringify([
      BATCH1_CATEGORIES,
      BATCH1_BRANDS,
      BATCH1_PRODUCTS,
      BATCH1_COLLECTIONS,
      BATCH1_COUPONS,
      BATCH1_SOLD_OUT_VARIANTS,
      BATCH1_LOW_STOCK_VARIANTS,
    ]);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
  });

  describe('products', () => {
    it('have unique names, slugs and SKUs, and slugs are the slugs of their names', () => {
      const names = BATCH1_PRODUCTS.map((product) => product.name);
      const slugs = BATCH1_PRODUCTS.map((product) => product.slug);
      const skus = getBatch1Variants().map((variant) => variant.sku);

      expect(new Set(names).size).toBe(44);
      expect(new Set(slugs).size).toBe(44);
      expect(new Set(skus).size).toBe(skus.length);
      for (const product of BATCH1_PRODUCTS) {
        expect(product.slug).toBe(createSlug(product.name));
      }
    });

    it('do not clash with the base seed names, slugs or SKUs', () => {
      for (const product of BATCH1_PRODUCTS) {
        expect(baseNames.has(product.name)).toBe(false);
        expect(baseSlugs.has(product.slug)).toBe(false);
      }
      for (const variant of getBatch1Variants()) {
        expect(baseSkus.has(variant.sku)).toBe(false);
      }
    });

    it('use a category and a brand that exist in the base seed or in this batch', () => {
      const categorySlugs = new Set([
        ...categoryDefinitions.map(({ name }) => createSlug(name)),
        ...BATCH1_CATEGORIES.map(({ slug }) => slug),
      ]);
      const brandSlugs = new Set([
        ...brandDefinitions.map(({ name }) => createSlug(name)),
        ...BATCH1_BRANDS.map(({ name }) => createSlug(name)),
      ]);
      for (const product of BATCH1_PRODUCTS) {
        expect(categorySlugs.has(createSlug(product.category))).toBe(true);
        expect(brandSlugs.has(createSlug(product.brand))).toBe(true);
      }
    });

    it('add categories and brands that the base seed does not have, with slugs of their names', () => {
      for (const category of BATCH1_CATEGORIES) {
        expect(category.slug).toBe(createSlug(category.name));
        expect(
          categoryDefinitions.some(
            ({ name }) => createSlug(name) === category.slug,
          ),
        ).toBe(false);
      }
      for (const brand of BATCH1_BRANDS) {
        expect(
          brandDefinitions.some(
            ({ name }) => createSlug(name) === createSlug(brand.name),
          ),
        ).toBe(false);
      }
      expect(BATCH1_CATEGORIES.map(({ slug }) => slug)).toEqual([
        'activewear',
        'loungewear-sleepwear',
      ]);
    });

    it('have prices the database accepts, and a compare-at price above the price', () => {
      let onSale = 0;
      for (const product of BATCH1_PRODUCTS) {
        expect(Number.isSafeInteger(product.price)).toBe(true);
        expect(product.price).toBeGreaterThan(0);
        if (product.compareAtPrice !== null) {
          onSale += 1;
          expect(Number.isSafeInteger(product.compareAtPrice)).toBe(true);
          expect(product.compareAtPrice).toBeGreaterThan(product.price);
        }
      }
      expect(onSale).toBe(7);
    });

    it('have a SKU prefix made of their brand code, and every colour and size code present', () => {
      for (const product of BATCH1_PRODUCTS) {
        expect(product.skuPrefix).toMatch(/^[A-Z]{2}-[A-Z]{3}$/);
        expect(
          product.skuPrefix.startsWith(`${BRAND_CODES[product.brand]}-`),
        ).toBe(true);
        expect(product.colours.length).toBeGreaterThan(0);
        expect(product.sizes.length).toBeGreaterThan(0);
        expect(new Set(product.colours.map((c) => c.code)).size).toBe(
          product.colours.length,
        );
        expect(new Set(product.colours.map((c) => c.name)).size).toBe(
          product.colours.length,
        );
        for (const colour of product.colours) {
          expect(colour.name.trim()).not.toBe('');
          expect(colour.code).toMatch(/^[A-Z0-9]{2,4}$/);
        }
        for (const size of product.sizes) {
          expect(sizeCode(size)).toMatch(/^[A-Z0-9]+$/);
        }
        expect(product.baseStock).toBeGreaterThan(0);
        expect(product.description.length).toBeGreaterThan(20);
      }
    });
  });

  describe('collections', () => {
    const everyKnownName = new Set([
      ...baseNames,
      ...BATCH1_PRODUCTS.map((product) => product.name),
    ]);

    it('are the six expected ones, in order, with slugs of their names', () => {
      expect(BATCH1_COLLECTIONS.map(({ name }) => name)).toEqual([
        'New Arrivals',
        'Office Essentials',
        'Weekend Casual',
        'Rainy Season',
        'Active Everyday',
        'Tet Gift Edit',
      ]);
      expect(BATCH1_COLLECTIONS.map(({ sortOrder }) => sortOrder)).toEqual([
        0, 1, 2, 3, 4, 5,
      ]);
      for (const collection of BATCH1_COLLECTIONS) {
        expect(collection.slug).toBe(createSlug(collection.name));
        expect(collection.description.length).toBeGreaterThan(10);
      }
    });

    it('only list products that exist in the base seed or in this batch, once each', () => {
      for (const collection of BATCH1_COLLECTIONS) {
        expect(new Set(collection.products).size).toBe(
          collection.products.length,
        );
        for (const name of collection.products) {
          expect(everyKnownName.has(name)).toBe(true);
        }
      }
    });

    it('have the expected number of members; New Arrivals has 12', () => {
      expect(
        Object.fromEntries(
          BATCH1_COLLECTIONS.map((c) => [c.name, c.products.length]),
        ),
      ).toEqual({
        'New Arrivals': 12,
        'Office Essentials': 13,
        'Weekend Casual': 13,
        'Rainy Season': 9,
        'Active Everyday': 13,
        'Tet Gift Edit': 10,
      });
    });

    it('are featured only for New Arrivals', () => {
      expect(
        BATCH1_COLLECTIONS.filter((c) => c.isFeatured).map((c) => c.name),
      ).toEqual(['New Arrivals']);
    });

    it('agree with the collections each product says it belongs to', () => {
      for (const product of BATCH1_PRODUCTS) {
        const memberOf = BATCH1_COLLECTIONS.filter((collection) =>
          collection.products.includes(product.name),
        ).map((collection) => collection.name);
        expect([...memberOf].sort()).toEqual([...product.collections].sort());
      }
    });
  });

  describe('variants', () => {
    const variants = getBatch1Variants();

    it('are every colour x size of every product: 323 in all', () => {
      expect(variants).toHaveLength(323);
      for (const product of BATCH1_PRODUCTS) {
        expect(
          variants.filter((variant) => variant.productName === product.name),
        ).toHaveLength(product.colours.length * product.sizes.length);
      }
    });

    it('apply exactly the 8 sold-out and 6 low-stock overrides', () => {
      expect(BATCH1_SOLD_OUT_VARIANTS).toHaveLength(8);
      expect(BATCH1_LOW_STOCK_VARIANTS).toHaveLength(6);

      const soldOut = variants.filter((variant) => variant.stock === 0);
      expect(soldOut).toHaveLength(8);
      for (const override of BATCH1_SOLD_OUT_VARIANTS) {
        expect(
          soldOut.some(
            (variant) =>
              variant.productName === override.product &&
              variant.attributes.color === override.colour &&
              variant.attributes.size === override.size,
          ),
        ).toBe(true);
      }
      for (const override of BATCH1_LOW_STOCK_VARIANTS) {
        const variant = variants.find(
          (item) =>
            item.productName === override.product &&
            item.attributes.color === override.colour &&
            item.attributes.size === override.size,
        );
        expect(variant?.stock).toBe(override.stock);
      }
      // The formula never goes below 3, so a stock under 3 is an override.
      expect(
        variants.filter((variant) => variant.stock > 0 && variant.stock < 3),
      ).toHaveLength(3);
      expect(
        variants.filter((variant) => variant.stock > 0 && variant.stock <= 4)
          .length,
      ).toBeGreaterThanOrEqual(6);
    });

    it('take the price and compare-at price of their product', () => {
      for (const variant of variants) {
        const product = BATCH1_PRODUCTS.find(
          (item) => item.name === variant.productName,
        )!;
        expect(variant.price).toBe(product.price);
        expect(variant.compareAtPrice).toBe(product.compareAtPrice);
        expect(variant.stock).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('coupons', () => {
    it('are TET2027 and RAINY100 as proposed', () => {
      expect(BATCH1_COUPONS).toEqual([
        {
          code: 'TET2027',
          name: expect.any(String) as string,
          type: CouponType.PERCENTAGE,
          value: 15,
          minSubtotal: 700000,
          maxDiscount: 150000,
        },
        {
          code: 'RAINY100',
          name: expect.any(String) as string,
          type: CouponType.FIXED,
          value: 100000,
          minSubtotal: 900000,
          maxDiscount: null,
        },
      ]);
    });
  });

  describe('image slots', () => {
    it('are one per colour of each product: 91, with unique file names', () => {
      const slots = getCatalogExpansionImageSlots();
      expect(slots).toHaveLength(91);
      expect(
        new Set(slots.map((slot) => `${slot.productSlug}__${slot.colorSlug}`))
          .size,
      ).toBe(91);
      expect(slots[0]).toEqual({
        productName: 'Studio High-Rise Leggings',
        productSlug: 'studio-high-rise-leggings',
        colorName: 'Black',
        colorSlug: 'black',
      });
      expect(
        slots.find((slot) => slot.colorName === 'Cream & Navy')?.colorSlug,
      ).toBe('cream-navy');
    });

    it('name 2 category banners and 6 collection covers', () => {
      expect(CATALOG_EXPANSION_BANNER_NAMES).toEqual([
        'category-activewear',
        'category-loungewear-sleepwear',
        'banner-collection-new-arrivals',
        'banner-collection-office-essentials',
        'banner-collection-weekend-casual',
        'banner-collection-rainy-season',
        'banner-collection-active-everyday',
        'banner-collection-tet-gift-edit',
      ]);
    });
  });
});
