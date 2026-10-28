import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// One product image: the picture of one colour of one product.
export interface DemoImageSlot {
  productName: string;
  productSlug: string;
  colorName: string;
  colorSlug: string;
}

export interface DemoProductImageEntry {
  productSlug: string;
  colorSlug: string;
  url: string;
  width: number;
  height: number;
}

export interface DemoBannerImageEntry {
  name: string;
  url: string;
  width: number;
  height: number;
}

// Public data only: the committed demo-images.json holds nothing secret.
export interface DemoImageManifest {
  products: DemoProductImageEntry[];
  banners: DemoBannerImageEntry[];
}

// Three folders up from src/database/seeds (and from dist/database/seeds) is
// the project root, so the same path works for ts-node and for the build.
export const DEMO_IMAGES_FILE = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'database',
  'seeds',
  'demo-images.json',
);

export function parseDemoImageManifest(raw: unknown): DemoImageManifest {
  if (!isRecord(raw)) throw new Error('Image manifest must be a JSON object');
  const { products, banners } = raw;
  if (!Array.isArray(products)) {
    throw new Error('Image manifest needs a "products" array');
  }
  if (!Array.isArray(banners)) {
    throw new Error('Image manifest needs a "banners" array');
  }

  return {
    products: products.map((entry, index) => {
      const where = `products[${index}]`;
      const record = requireRecord(entry, where);
      return {
        productSlug: requireText(record, 'productSlug', where),
        colorSlug: requireText(record, 'colorSlug', where),
        ...readImageFields(record, where),
      };
    }),
    banners: banners.map((entry, index) => {
      const where = `banners[${index}]`;
      const record = requireRecord(entry, where);
      return {
        name: requireText(record, 'name', where),
        ...readImageFields(record, where),
      };
    }),
  };
}

// Returns null when the file does not exist, so a fresh clone still seeds.
export function loadDemoImageManifest(
  file: string = DEMO_IMAGES_FILE,
): DemoImageManifest | null {
  if (!existsSync(file)) return null;
  try {
    return parseDemoImageManifest(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Cannot read ${basename(file)}: ${reason}`);
  }
}

// Sorted, so regenerating the file produces small, readable diffs.
export function serializeDemoImageManifest(
  manifest: DemoImageManifest,
): string {
  const products = [...manifest.products]
    .sort(
      (a, b) =>
        compareText(a.productSlug, b.productSlug) ||
        compareText(a.colorSlug, b.colorSlug),
    )
    .map(({ productSlug, colorSlug, url, width, height }) => ({
      productSlug,
      colorSlug,
      url,
      width,
      height,
    }));
  const banners = [...manifest.banners]
    .sort((a, b) => compareText(a.name, b.name))
    .map(({ name, url, width, height }) => ({ name, url, width, height }));
  return `${JSON.stringify({ products, banners }, null, 2)}\n`;
}

// Writes next to the target and renames, so a crash never leaves half a file.
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.tmp`,
  );
  try {
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// Cloudinary urls carry a version (/v1700000000/) that changes on every
// re-upload. Two urls with the same identity are the same picture.
export function demoImageIdentity(url: string): string {
  return url.replace(/\/v\d+\//, '/');
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  return value;
}

function requireText(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function readImageFields(record: Record<string, unknown>, where: string) {
  const url = requireText(record, 'url', where);
  if (!url.startsWith('https://')) {
    throw new Error(`${where}.url must be an https url`);
  }
  return {
    url,
    width: requireDimension(record, 'width', where),
    height: requireDimension(record, 'height', where),
  };
}

function requireDimension(
  record: Record<string, unknown>,
  key: string,
  where: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where}.${key} must be a positive integer`);
  }
  return value;
}
