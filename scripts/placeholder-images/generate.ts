import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { PlaceholderItem } from './plan';
import { renderPlaceholder } from './render';

// The project root: two folders up from scripts/placeholder-images.
export const REPOSITORY_ROOT = resolve(__dirname, '..', '..');

// Next to the repositories, outside them, where the catalog input already
// lives. Generated pictures are never committed.
export function defaultOutputDirectory(): string {
  return resolve(REPOSITORY_ROOT, '..', '_catalog-input', 'images');
}

export function isInsideRepository(directory: string): boolean {
  const path = relative(REPOSITORY_ROOT, resolve(directory));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export interface GenerateOptions {
  outDir: string;
  items: readonly PlaceholderItem[];
  // Rewrite a file that is already there. Off by default, so a real picture
  // that was put in the folder in place of a placeholder is never overwritten.
  force?: boolean;
  render?: (item: PlaceholderItem) => Promise<Buffer>;
  concurrency?: number;
}

export interface GenerateResult {
  written: string[];
  skipped: string[];
  bytes: number;
}

// Writes next to the target and renames, so a crash never leaves half a file.
function writeAtomic(file: string, data: Buffer): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export async function generatePlaceholders(
  options: GenerateOptions,
): Promise<GenerateResult> {
  const render = options.render ?? renderPlaceholder;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  mkdirSync(options.outDir, { recursive: true });

  const result: GenerateResult = { written: [], skipped: [], bytes: 0 };
  const queue = [...options.items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const target = join(options.outDir, item.fileName);
      if (existsSync(target) && !options.force) {
        result.skipped.push(item.fileName);
        continue;
      }
      const data = await render(item);
      writeAtomic(target, data);
      result.written.push(item.fileName);
      result.bytes += data.length;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  // Workers finish in any order; the lists are always sorted.
  result.written.sort();
  result.skipped.sort();
  return result;
}
