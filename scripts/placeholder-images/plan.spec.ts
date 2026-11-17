import { parseDemoImageFileName } from '../../src/database/seeds/demo-image-files';
import {
  CATALOG_EXPANSION_BANNER_NAMES,
  getCatalogExpansionImageSlots,
} from '../../src/database/seeds/catalog-expansion/image-slots';
import {
  BANNER_SIZE,
  PRODUCT_SIZE,
  bannerTone,
  buildPlaceholderPlan,
  shortCaption,
} from './plan';

describe('placeholder plan', () => {
  const plan = buildPlaceholderPlan();
  const products = plan.filter((item) => item.kind === 'product');
  const banners = plan.filter((item) => item.kind === 'banner');
  const nameOf = (fileName: string) => fileName.replace(/\.jpg$/, '');

  it('makes one picture for each colour of each batch 1 product', () => {
    const slots = getCatalogExpansionImageSlots();
    expect(products).toHaveLength(91);
    expect(products.map((item) => item.fileName)).toEqual(
      slots.map((slot) => `${slot.productSlug}__${slot.colorSlug}.jpg`),
    );
  });

  it('uses file names the upload script accepts', () => {
    const rejected = plan.filter(
      (item) => parseDemoImageFileName(item.fileName)?.kind !== item.kind,
    );
    expect(rejected.map((item) => item.fileName)).toEqual([]);
  });

  it('has no duplicate file name', () => {
    expect(new Set(plan.map((item) => item.fileName)).size).toBe(plan.length);
  });

  it('makes every banner the batch 1 pages read, and the new brands', () => {
    const names = banners.map((item) => nameOf(item.fileName));
    for (const expected of CATALOG_EXPANSION_BANNER_NAMES) {
      expect(names).toContain(expected);
    }
    expect(names.filter((name) => name.startsWith('category-'))).toEqual([
      'category-activewear',
      'category-loungewear-sleepwear',
    ]);
    expect(
      names.filter((name) => name.startsWith('banner-collection-')),
    ).toHaveLength(6);
    expect(names.filter((name) => name.startsWith('brand-')).sort()).toEqual([
      'brand-ardent-motion',
      'brand-cinder-oak',
      'brand-hushwell',
      'brand-tidewell',
    ]);
    expect(banners).toHaveLength(12);
  });

  it('leaves the brand banners out on request', () => {
    const without = buildPlaceholderPlan({ brands: false });
    expect(without.filter((item) => item.kind === 'banner')).toHaveLength(8);
    expect(without.some((item) => item.fileName.startsWith('brand-'))).toBe(
      false,
    );
  });

  it('draws products as 4:5 portraits and banners as 3:2 landscapes', () => {
    for (const item of products) {
      expect([item.width, item.height]).toEqual([
        PRODUCT_SIZE.width,
        PRODUCT_SIZE.height,
      ]);
      expect(item.width / item.height).toBeCloseTo(4 / 5, 5);
    }
    for (const item of banners) {
      expect([item.width, item.height]).toEqual([
        BANNER_SIZE.width,
        BANNER_SIZE.height,
      ]);
      expect(item.width / item.height).toBeCloseTo(3 / 2, 5);
    }
  });

  it('labels a product with its category and a colour name', () => {
    const leggings = products.find(
      (item) => item.fileName === 'studio-high-rise-leggings__deep-plum.jpg',
    );
    expect(leggings).toMatchObject({
      title: 'Studio High-Rise Leggings',
      label: 'Activewear',
      caption: 'Deep Plum',
    });
    expect(leggings?.colour).toMatchObject({ base: '#4e2a45', known: true });
    expect(products.every((item) => item.label !== '')).toBe(true);
  });

  it('knows the colour of every product picture', () => {
    expect(products.filter((item) => !item.colour.known)).toEqual([]);
  });

  it('always gives a banner the same soft tone', () => {
    expect(bannerTone('category-activewear')).toBe(
      bannerTone('category-activewear'),
    );
    expect(bannerTone('category-activewear')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps the first sentence of a description', () => {
    expect(shortCaption('One. Two.')).toBe('One.');
    expect(shortCaption('A'.repeat(200))).toHaveLength(120);
    expect(shortCaption('A'.repeat(200)).endsWith('...')).toBe(true);
    expect(shortCaption('No full stop here')).toBe('No full stop here');
  });
});
