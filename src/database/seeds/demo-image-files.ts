import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DemoImageSlot } from './demo-image-manifest';

export const MAX_DEMO_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp)$/i;
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const PRODUCT_NAME = new RegExp(`^(${SLUG})__(${SLUG})$`);
const BANNER_NAME = new RegExp(`^(?:banner|category|brand)-${SLUG}$`);
// Files that operating systems add on their own; they are not mistakes.
const IGNORED_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

export type ParsedDemoImageName =
  | {
      kind: 'product';
      name: string;
      productSlug: string;
      colorSlug: string;
    }
  | { kind: 'banner'; name: string };

export interface DemoImageFile {
  fileName: string;
  filePath: string;
  // File name without the extension, lowercased: the public id suffix.
  name: string;
  sizeBytes: number;
}

export interface DemoProductImageFile extends DemoImageFile {
  productSlug: string;
  colorSlug: string;
}

export interface DemoImageReport {
  productFiles: DemoProductImageFile[];
  bannerFiles: DemoImageFile[];
  missing: Array<{ productSlug: string; colorSlug: string }>;
  unexpected: Array<{ fileName: string; reason: string }>;
  duplicates: Array<{ name: string; files: string[] }>;
  oversized: Array<{ fileName: string; sizeBytes: number }>;
  unreadable: Array<{ fileName: string; reason: string }>;
}

export function parseDemoImageFileName(
  fileName: string,
): ParsedDemoImageName | null {
  if (!IMAGE_EXTENSION.test(fileName)) return null;
  const name = fileName.replace(IMAGE_EXTENSION, '').toLowerCase();

  if (name.includes('__')) {
    const match = PRODUCT_NAME.exec(name);
    if (!match) return null;
    return {
      kind: 'product',
      name,
      productSlug: match[1],
      colorSlug: match[2],
    };
  }
  return BANNER_NAME.test(name) ? { kind: 'banner', name } : null;
}

export function analyzeDemoImageFolder(
  directory: string,
  slots: readonly DemoImageSlot[],
  options: { maxBytes?: number } = {},
): DemoImageReport {
  const maxBytes = options.maxBytes ?? MAX_DEMO_IMAGE_BYTES;
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error('The image folder does not exist or is not a folder');
  }

  const colorsByProduct = new Map<string, string[]>();
  for (const slot of slots) {
    colorsByProduct.set(slot.productSlug, [
      ...(colorsByProduct.get(slot.productSlug) ?? []),
      slot.colorSlug,
    ]);
  }

  const report: DemoImageReport = {
    productFiles: [],
    bannerFiles: [],
    missing: [],
    unexpected: [],
    duplicates: [],
    oversized: [],
    unreadable: [],
  };
  const candidates = new Map<string, DemoImageFile[]>();

  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const entry of entries) {
    const fileName = entry.name;
    if (IGNORED_FILES.has(fileName.toLowerCase())) continue;
    if (!entry.isFile()) {
      report.unexpected.push({
        fileName,
        reason:
          'is a folder or not a regular file (sub-folders are not scanned)',
      });
      continue;
    }

    const parsed = parseDemoImageFileName(fileName);
    if (!parsed) {
      report.unexpected.push({
        fileName,
        reason:
          'name does not match {product-slug}__{color-slug}.jpg or banner-*, category-*, brand-*',
      });
      continue;
    }
    if (parsed.kind === 'product') {
      const colors = colorsByProduct.get(parsed.productSlug);
      if (!colors) {
        report.unexpected.push({
          fileName,
          reason: `unknown product "${parsed.productSlug}"`,
        });
        continue;
      }
      if (!colors.includes(parsed.colorSlug)) {
        report.unexpected.push({
          fileName,
          reason: `product "${parsed.productSlug}" has no colour "${parsed.colorSlug}" (expected: ${colors.join(', ')})`,
        });
        continue;
      }
    }

    const filePath = join(directory, fileName);
    const file: DemoImageFile = {
      fileName,
      filePath,
      name: parsed.name,
      sizeBytes: 0,
    };
    try {
      accessSync(filePath, constants.R_OK);
      file.sizeBytes = statSync(filePath).size;
    } catch (error) {
      report.unreadable.push({
        fileName,
        reason: error instanceof Error ? error.message : 'cannot be read',
      });
      continue;
    }
    if (file.sizeBytes === 0) {
      report.unreadable.push({ fileName, reason: 'file is empty' });
      continue;
    }
    if (file.sizeBytes > maxBytes) {
      report.oversized.push({ fileName, sizeBytes: file.sizeBytes });
    }

    candidates.set(parsed.name, [...(candidates.get(parsed.name) ?? []), file]);
  }

  for (const [name, files] of candidates) {
    if (files.length > 1) {
      report.duplicates.push({ name, files: files.map((f) => f.fileName) });
      continue;
    }
    const [file] = files;
    const parsed = parseDemoImageFileName(file.fileName);
    if (parsed?.kind === 'product') {
      report.productFiles.push({
        ...file,
        productSlug: parsed.productSlug,
        colorSlug: parsed.colorSlug,
      });
    } else {
      report.bannerFiles.push(file);
    }
  }

  // A duplicate or unreadable file is already reported on its own, so it is
  // not listed as missing as well.
  const present = new Set([
    ...report.productFiles.map((file) => file.name),
    ...report.duplicates.map((duplicate) => duplicate.name),
    ...report.unreadable.map((file) =>
      file.fileName.replace(IMAGE_EXTENSION, '').toLowerCase(),
    ),
  ]);
  for (const slot of slots) {
    if (!present.has(`${slot.productSlug}__${slot.colorSlug}`)) {
      report.missing.push({
        productSlug: slot.productSlug,
        colorSlug: slot.colorSlug,
      });
    }
  }

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  report.productFiles.sort(byName);
  report.bannerFiles.sort(byName);
  report.duplicates.sort(byName);
  return report;
}

// Anything that would make a real upload unsafe or incomplete.
export function reportHasProblems(report: DemoImageReport): boolean {
  return (
    report.missing.length > 0 ||
    report.unexpected.length > 0 ||
    report.duplicates.length > 0 ||
    report.oversized.length > 0 ||
    report.unreadable.length > 0
  );
}

export function formatDemoImageReport(
  report: DemoImageReport,
  expectedProductImages: number,
): string[] {
  const lines = [
    `Product images found: ${report.productFiles.length} of ${expectedProductImages}`,
    `Banner-style images found: ${report.bannerFiles.length}`,
  ];
  for (const banner of report.bannerFiles)
    lines.push(`  banner: ${banner.name}`);

  if (report.missing.length > 0) {
    lines.push(`Missing product images (${report.missing.length}):`);
    for (const slot of report.missing) {
      lines.push(`  missing: ${slot.productSlug}__${slot.colorSlug}.jpg`);
    }
  }
  if (report.unexpected.length > 0) {
    lines.push(`Unexpected files (${report.unexpected.length}):`);
    for (const entry of report.unexpected) {
      lines.push(`  unexpected: ${entry.fileName} - ${entry.reason}`);
    }
  }
  if (report.duplicates.length > 0) {
    lines.push(`Duplicate names (${report.duplicates.length}):`);
    for (const duplicate of report.duplicates) {
      lines.push(
        `  duplicate: ${duplicate.name} <- ${duplicate.files.join(', ')}`,
      );
    }
  }
  if (report.oversized.length > 0) {
    lines.push(`Files over 10 MB (${report.oversized.length}):`);
    for (const file of report.oversized) {
      lines.push(
        `  too large: ${file.fileName} (${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
      );
    }
  }
  if (report.unreadable.length > 0) {
    lines.push(`Unreadable files (${report.unreadable.length}):`);
    for (const file of report.unreadable) {
      lines.push(`  unreadable: ${file.fileName} - ${file.reason}`);
    }
  }
  return lines;
}
