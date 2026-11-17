import { resolve } from 'node:path';
import {
  defaultOutputDirectory,
  generatePlaceholders,
  isInsideRepository,
  type GenerateResult,
} from './generate';
import { buildPlaceholderPlan, type PlaceholderItem } from './plan';

const USAGE =
  'Usage: npm run images:placeholders -- [--out <folder>] [--force] [--no-brands]\n' +
  '  The folder defaults to PLACEHOLDER_IMAGES_DIR, then to ../_catalog-input/images\n' +
  '  (outside the repository). A file that is already there is kept unless --force.';

export interface PlaceholderCliDependencies {
  env: Record<string, string | undefined>;
  io: { log(line: string): void; error(line: string): void };
  generate?: (options: {
    outDir: string;
    items: readonly PlaceholderItem[];
    force: boolean;
  }) => Promise<GenerateResult>;
}

// Exit codes: 0 done, 1 failed, 2 bad usage.
export async function runPlaceholderCli(
  argv: readonly string[],
  dependencies: PlaceholderCliDependencies,
): Promise<number> {
  const { io } = dependencies;
  let out: string | undefined;
  let force = false;
  let brands = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out') {
      out = argv[index + 1];
      index += 1;
      if (!out || out.startsWith('--')) {
        io.error(`Missing folder after --out\n${USAGE}`);
        return 2;
      }
    } else if (argument === '--force') {
      force = true;
    } else if (argument === '--no-brands') {
      brands = false;
    } else {
      io.error(`Unknown argument: ${argument}\n${USAGE}`);
      return 2;
    }
  }

  const outDir = resolve(
    out ??
      (dependencies.env.PLACEHOLDER_IMAGES_DIR?.trim() ||
        defaultOutputDirectory()),
  );
  if (isInsideRepository(outDir)) {
    io.error(
      `Refusing to write into the repository (${outDir}). Generated pictures are not committed: pick a folder outside it.`,
    );
    return 2;
  }

  try {
    const items = buildPlaceholderPlan({ brands });
    const run = dependencies.generate ?? generatePlaceholders;
    const result = await run({ outDir, items, force });
    io.log(`Folder: ${outDir}`);
    io.log(
      `Placeholders: ${items.length} planned, ${result.written.length} written, ${result.skipped.length} kept as they were` +
        (result.skipped.length > 0 ? ' (use --force to rewrite them)' : ''),
    );
    io.log('Next, check the folder without any network call:');
    io.log(
      `  npm.cmd run images:upload -- --dir "${outDir}" --catalog all --dry-run`,
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : 'Unknown error');
    return 1;
  }
}
