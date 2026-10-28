import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeDemoImageFolder,
  formatDemoImageReport,
  parseDemoImageFileName,
  reportHasProblems,
} from './demo-image-files';
import { getDemoImageSlots } from './demo-seed';
import type { DemoImageSlot } from './demo-image-manifest';

const slots: DemoImageSlot[] = [
  {
    productName: 'Alpha Tee',
    productSlug: 'alpha-tee',
    colorName: 'Black',
    colorSlug: 'black',
  },
  {
    productName: 'Alpha Tee',
    productSlug: 'alpha-tee',
    colorName: 'Sage Green',
    colorSlug: 'sage-green',
  },
  {
    productName: 'Beta Cap',
    productSlug: 'beta-cap',
    colorName: 'Navy',
    colorSlug: 'navy',
  },
];

describe('parseDemoImageFileName', () => {
  it('parses {product-slug}__{color-slug}.{ext} for every allowed extension', () => {
    for (const extension of ['jpg', 'jpeg', 'png', 'webp']) {
      expect(
        parseDemoImageFileName(`alpha-tee__sage-green.${extension}`),
      ).toEqual({
        kind: 'product',
        name: 'alpha-tee__sage-green',
        productSlug: 'alpha-tee',
        colorSlug: 'sage-green',
      });
    }
  });

  it('treats the extension and the slugs case-insensitively and lowercases the name', () => {
    expect(parseDemoImageFileName('Alpha-Tee__Sage-Green.JPG')).toEqual({
      kind: 'product',
      name: 'alpha-tee__sage-green',
      productSlug: 'alpha-tee',
      colorSlug: 'sage-green',
    });
    expect(parseDemoImageFileName('beta-cap__navy.WebP')?.kind).toBe('product');
  });

  it('recognises banner, category and brand files', () => {
    expect(parseDemoImageFileName('banner-home-hero.jpg')).toEqual({
      kind: 'banner',
      name: 'banner-home-hero',
    });
    expect(parseDemoImageFileName('category-tees.PNG')).toEqual({
      kind: 'banner',
      name: 'category-tees',
    });
    expect(parseDemoImageFileName('brand-aerothread.webp')).toEqual({
      kind: 'banner',
      name: 'brand-aerothread',
    });
  });

  it.each([
    'alpha-tee.jpg',
    'alpha-tee_black.jpg',
    'alpha-tee___black.jpg',
    'alpha-tee__black__extra.jpg',
    '__black.jpg',
    'alpha-tee__.jpg',
    'alpha tee__black.jpg',
    'alpha-tee__black.gif',
    'alpha-tee__black.jpg.txt',
    'alpha-tee__black',
    'banner-.jpg',
    'banners.jpg',
    'category.jpg',
    'readme.md',
    '.jpg',
  ])('rejects %s', (fileName) => {
    expect(parseDemoImageFileName(fileName)).toBeNull();
  });
});

describe('analyzeDemoImageFolder', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'demo-images-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function put(name: string, size = 16) {
    writeFileSync(join(directory, name), Buffer.alloc(size, 1));
  }

  function putAllProductFiles() {
    put('alpha-tee__black.jpg');
    put('alpha-tee__sage-green.jpg');
    put('beta-cap__navy.png');
  }

  it('accepts a complete folder and reports banners separately', () => {
    putAllProductFiles();
    put('banner-home.jpg');
    put('category-tees.jpg');
    put('brand-aerothread.jpg');

    const report = analyzeDemoImageFolder(directory, slots);

    expect(report.productFiles.map((file) => file.name)).toEqual([
      'alpha-tee__black',
      'alpha-tee__sage-green',
      'beta-cap__navy',
    ]);
    expect(report.bannerFiles.map((file) => file.name)).toEqual([
      'banner-home',
      'brand-aerothread',
      'category-tees',
    ]);
    expect(report.missing).toEqual([]);
    expect(report.unexpected).toEqual([]);
    expect(report.duplicates).toEqual([]);
    expect(report.oversized).toEqual([]);
    expect(report.unreadable).toEqual([]);
    expect(reportHasProblems(report)).toBe(false);
  });

  it('lists every expected product image that is missing', () => {
    put('alpha-tee__black.jpg');

    const report = analyzeDemoImageFolder(directory, slots);

    expect(report.missing).toEqual([
      { productSlug: 'alpha-tee', colorSlug: 'sage-green' },
      { productSlug: 'beta-cap', colorSlug: 'navy' },
    ]);
    expect(reportHasProblems(report)).toBe(true);
  });

  it('flags files that match no product or colour, with a reason', () => {
    putAllProductFiles();
    put('gamma-hat__black.jpg');
    put('alpha-tee__purple.jpg');
    put('notes.txt');
    put('alpha-tee_black.jpg');
    mkdirSync(join(directory, 'old'));

    const report = analyzeDemoImageFolder(directory, slots);
    const byName = Object.fromEntries(
      report.unexpected.map((entry) => [entry.fileName, entry.reason]),
    );

    expect(Object.keys(byName).sort()).toEqual([
      'alpha-tee__purple.jpg',
      'alpha-tee_black.jpg',
      'gamma-hat__black.jpg',
      'notes.txt',
      'old',
    ]);
    expect(byName['gamma-hat__black.jpg']).toMatch(/unknown product/i);
    expect(byName['alpha-tee__purple.jpg']).toMatch(/black, sage-green/);
    expect(byName['notes.txt']).toMatch(/name/i);
    expect(byName['old']).toMatch(/folder/i);
    expect(reportHasProblems(report)).toBe(true);
  });

  it('treats banner-hero and banner-hero-wide as two separate banner slots', () => {
    putAllProductFiles();
    put('banner-hero.jpg');
    put('banner-hero-wide.jpg');

    const report = analyzeDemoImageFolder(directory, slots);

    expect(report.bannerFiles.map((file) => file.name)).toEqual([
      'banner-hero',
      'banner-hero-wide',
    ]);
    expect(report.duplicates).toEqual([]);
    expect(report.unexpected).toEqual([]);
    expect(reportHasProblems(report)).toBe(false);
  });

  it('ignores operating-system junk files', () => {
    putAllProductFiles();
    put('Thumbs.db');
    put('desktop.ini');
    put('.DS_Store');

    expect(analyzeDemoImageFolder(directory, slots).unexpected).toEqual([]);
  });

  it('reports two files that map to the same image as duplicates', () => {
    putAllProductFiles();
    put('alpha-tee__black.jpeg');
    put('banner-home.jpg');
    put('banner-home.png');

    const report = analyzeDemoImageFolder(directory, slots);

    expect(report.duplicates).toEqual([
      {
        name: 'alpha-tee__black',
        files: ['alpha-tee__black.jpeg', 'alpha-tee__black.jpg'],
      },
      { name: 'banner-home', files: ['banner-home.jpg', 'banner-home.png'] },
    ]);
    expect(report.missing).toEqual([]);
    expect(reportHasProblems(report)).toBe(true);
  });

  it('flags files over the size limit', () => {
    putAllProductFiles();
    put('alpha-tee__black.jpg', 21);

    const report = analyzeDemoImageFolder(directory, slots, { maxBytes: 20 });

    expect(report.oversized).toEqual([
      { fileName: 'alpha-tee__black.jpg', sizeBytes: 21 },
    ]);
    expect(reportHasProblems(report)).toBe(true);
  });

  it('applies a 10 MB limit by default', () => {
    putAllProductFiles();
    put('alpha-tee__black.jpg', 10 * 1024 * 1024 + 1);

    const report = analyzeDemoImageFolder(directory, slots);

    expect(report.oversized.map((file) => file.fileName)).toEqual([
      'alpha-tee__black.jpg',
    ]);
  });

  it('flags empty files as unreadable', () => {
    putAllProductFiles();
    put('beta-cap__navy.png', 0);

    const report = analyzeDemoImageFolder(directory, slots);

    expect(report.unreadable).toEqual([
      {
        fileName: 'beta-cap__navy.png',
        reason: expect.stringMatching(/empty/i),
      },
    ]);
    expect(reportHasProblems(report)).toBe(true);
  });

  it('throws a clear error when the folder does not exist', () => {
    expect(() =>
      analyzeDemoImageFolder(join(directory, 'nope'), slots),
    ).toThrow(/folder/i);
  });

  it('expects exactly the 48 product images of the real demo catalog', () => {
    const catalog = getDemoImageSlots();

    expect(catalog).toHaveLength(48);
    expect(
      new Set(catalog.map((slot) => `${slot.productSlug}__${slot.colorSlug}`))
        .size,
    ).toBe(48);
    expect(new Set(catalog.map((slot) => slot.productSlug)).size).toBe(26);
    // The same slug function as the seed: "&" and spaces collapse to "-".
    expect(catalog).toContainEqual({
      productName: 'Seamless Modal Trunks 2-Pack',
      productSlug: 'seamless-modal-trunks-2-pack',
      colorName: 'Black & Grey',
      colorSlug: 'black-grey',
    });
    // Colours keep the order of the product's variants in the seed.
    expect(
      catalog
        .filter((slot) => slot.productSlug === 'classic-crewneck-cotton-tee')
        .map((slot) => slot.colorSlug),
    ).toEqual(['black', 'white']);
  });

  it('prints a readable report', () => {
    put('alpha-tee__black.jpg');
    put('stray.txt');
    put('banner-home.jpg');

    const lines = formatDemoImageReport(
      analyzeDemoImageFolder(directory, slots),
      slots.length,
    ).join('\n');

    expect(lines).toContain('Product images found: 1 of 3');
    expect(lines).toContain('alpha-tee__sage-green');
    expect(lines).toContain('stray.txt');
    expect(lines).toContain('banner-home');
    expect(lines).not.toContain(directory);
  });
});
