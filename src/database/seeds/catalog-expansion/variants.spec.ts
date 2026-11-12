import { BATCH1_PRODUCTS } from './batch1.data';
import type { CatalogProductDefinition } from './catalog-types';
import {
  buildCatalogVariants,
  formulaStock,
  getBatch1Variants,
  sizeCode,
  variantSku,
} from './variants';

function variantOf(productName: string, colour: string, size: string) {
  const variant = getBatch1Variants().find(
    (item) =>
      item.productName === productName &&
      item.attributes.color === colour &&
      item.attributes.size === size,
  );
  if (!variant)
    throw new Error(`No variant ${productName} / ${colour} / ${size}`);
  return variant;
}

describe('variant rules of the catalog expansion', () => {
  describe('size codes and SKUs', () => {
    it('maps the special sizes and keeps the others', () => {
      expect(
        [
          'One Size',
          'S/M',
          'L/XL',
          '38/39',
          '40/41',
          '42/43',
          'XS',
          'S',
          '30',
        ].map(sizeCode),
      ).toEqual(['OS', 'SM', 'LXL', '3839', '4041', '4243', 'XS', 'S', '30']);
    });

    it('builds {prefix}-{colour code}-{size code}', () => {
      expect(variantSku('AM-SHL', 'BLK', 'M')).toBe('AM-SHL-BLK-M');
      expect(variantSku('KB-TCS', 'CRM', '38/39')).toBe('KB-TCS-CRM-3839');
    });

    it('refuses a size it cannot turn into a code', () => {
      expect(() => sizeCode('Extra Large')).toThrow(/valid SKU code/);
    });
  });

  describe('stock formula', () => {
    it('is round(base x size factor x colour factor)', () => {
      // 22 x 0.8 = 17.6; 22 x 1.2 = 26.4; 22 x 0.8 x 0.85 = 14.96
      expect(formulaStock(22, 'S', 0)).toBe(18);
      expect(formulaStock(22, 'M', 0)).toBe(26);
      expect(formulaStock(22, 'S', 1)).toBe(15);
      // 18 x 1.1 = 19.8; 18 x 0.6 x 0.85 = 9.18
      expect(formulaStock(18, '32', 0)).toBe(20);
      expect(formulaStock(18, '36', 1)).toBe(9);
    });

    it('rounds a half up and never goes below 3', () => {
      expect(formulaStock(25, 'XS', 0)).toBe(13); // 12.5
      expect(formulaStock(3, 'XS', 1)).toBe(3); // 1.275 -> minimum
      expect(formulaStock(1, 'One Size', 0)).toBe(3);
    });

    it('gives the third colour the same factor as the second', () => {
      expect(formulaStock(30, 'M', 1)).toBe(formulaStock(30, 'M', 2));
    });

    it('refuses a size without a factor', () => {
      expect(() => formulaStock(10, 'XXL', 0)).toThrow(/no stock factor/);
    });
  });

  describe('recomputed by hand', () => {
    it('Studio High-Rise Leggings (base 22, 3 colours, 5 sizes)', () => {
      const first = variantOf('Studio High-Rise Leggings', 'Black', 'S');
      expect(first).toEqual({
        productName: 'Studio High-Rise Leggings',
        sku: 'AM-SHL-BLK-S',
        name: 'Black / S',
        price: 399000,
        compareAtPrice: null,
        stock: 18,
        attributes: { size: 'S', color: 'Black' },
        position: 1,
      });
      expect(variantOf('Studio High-Rise Leggings', 'Black', 'XS').stock).toBe(
        0, // sold-out override
      );
      expect(variantOf('Studio High-Rise Leggings', 'Black', 'XL').stock).toBe(
        15, // 22 x 0.7 = 15.4
      );
      const plum = variantOf('Studio High-Rise Leggings', 'Deep Plum', 'M');
      expect(plum.stock).toBe(22); // 22 x 1.2 x 0.85 = 22.44
      expect(plum.position).toBe(7); // second colour starts after 5 sizes
      expect(plum.sku).toBe('AM-SHL-PLM-M');
      expect(
        variantOf('Studio High-Rise Leggings', 'Sage', 'XL'),
      ).toMatchObject({
        stock: 13, // 22 x 0.7 x 0.85 = 13.09
        position: 14,
      });
    });

    it('Canvas Carpenter Pants (base 18, waist sizes, low-stock override)', () => {
      expect(variantOf('Canvas Carpenter Pants', 'Tan', '30').stock).toBe(13);
      expect(variantOf('Canvas Carpenter Pants', 'Tan', '32')).toMatchObject({
        sku: 'CO-CCP-TAN-32',
        name: 'Tan / 32',
        stock: 2, // override; the formula would give 20
      });
      expect(variantOf('Canvas Carpenter Pants', 'Tan', '34').stock).toBe(18);
      expect(variantOf('Canvas Carpenter Pants', 'Tan', '36').stock).toBe(11);
      expect(variantOf('Canvas Carpenter Pants', 'Black', '36').stock).toBe(9);
    });

    it('Pace 5-Inch Running Shorts (base 26)', () => {
      expect(variantOf('Pace 5-Inch Running Shorts', 'Black', 'S').stock).toBe(
        21, // 20.8
      );
      expect(variantOf('Pace 5-Inch Running Shorts', 'Cobalt', 'M').stock).toBe(
        27, // 26.52
      );
      expect(
        variantOf('Pace 5-Inch Running Shorts', 'Cobalt', 'XL').stock,
      ).toBe(
        1, // override
      );
    });

    it('a one-size product is named by its colour only and keeps a size attribute', () => {
      expect(
        variantOf('Merino Lounge Socks 2-Pack', 'Grey Marl', 'One Size'),
      ).toEqual({
        productName: 'Merino Lounge Socks 2-Pack',
        sku: 'KB-MLS-GMR-OS',
        name: 'Grey Marl',
        price: 159000,
        compareAtPrice: null,
        stock: 40,
        attributes: { size: 'One Size', color: 'Grey Marl' },
        position: 0,
      });
      expect(
        variantOf('Merino Lounge Socks 2-Pack', 'Oat', 'One Size').stock,
      ).toBe(34); // 40 x 0.85
    });

    it('paired sizes use their own codes and the compare-at price', () => {
      expect(variantOf('Terry Cloth Slides', 'Cream', '38/39')).toMatchObject({
        sku: 'KB-TCS-CRM-3839',
        stock: 14, // 18 x 0.8 = 14.4
      });
      expect(variantOf('Terry Cloth Slides', 'Black', '42/43')).toMatchObject({
        sku: 'KB-TCS-BLK-4243',
        stock: 12, // 18 x 0.8 x 0.85 = 12.24
      });
      expect(variantOf('Waffle Cotton Robe', 'Navy', 'S/M').stock).toBe(12);
      expect(variantOf('Waffle Cotton Robe', 'Navy', 'L/XL').stock).toBe(4);
      expect(variantOf('Modal Sleep Shorts', 'Black', 'M')).toMatchObject({
        price: 229000,
        compareAtPrice: 289000,
      });
    });

    it('a colour name with an ampersand keeps it in the variant and attributes', () => {
      expect(
        variantOf('Heritage Ringer Tee', 'Cream & Forest', 'S'),
      ).toMatchObject({
        sku: 'CO-HRT-CFR-S',
        name: 'Cream & Forest / S',
        stock: 3,
        attributes: { size: 'S', color: 'Cream & Forest' },
      });
    });
  });

  describe('buildCatalogVariants', () => {
    const product: CatalogProductDefinition = {
      ...BATCH1_PRODUCTS[0],
      colours: [{ name: 'Red', code: 'RED' }],
      sizes: ['S', 'M'],
      baseStock: 10,
    };

    it('lists colour by colour, size by size, with growing positions', () => {
      expect(
        buildCatalogVariants([product], []).map((v) => [v.sku, v.position]),
      ).toEqual([
        ['AM-SHL-RED-S', 0],
        ['AM-SHL-RED-M', 1],
      ]);
    });

    it('applies an override and fails on one that matches nothing', () => {
      const overridden = buildCatalogVariants(
        [product],
        [{ product: product.name, colour: 'Red', size: 'M', stock: 0 }],
      );
      expect(overridden.map((v) => v.stock)).toEqual([8, 0]);

      expect(() =>
        buildCatalogVariants(
          [product],
          [{ product: product.name, colour: 'Blue', size: 'M', stock: 0 }],
        ),
      ).toThrow(/match no variant/);
    });
  });
});
