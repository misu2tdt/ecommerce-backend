import {
  existsSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  CATALOG_EXPANSION_BANNER_NAMES,
  getCatalogExpansionImageSlots,
} from '../../src/database/seeds/catalog-expansion/image-slots';
import {
  analyzeDemoImageFolder,
  reportHasProblems,
} from '../../src/database/seeds/demo-image-files';
import {
  REPOSITORY_ROOT,
  defaultOutputDirectory,
  generatePlaceholders,
  isInsideRepository,
} from './generate';
import { buildPlaceholderPlan } from './plan';

describe('generating placeholders', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'placeholders-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes the whole plan, and the folder passes the upload check for batch 1', async () => {
    const plan = buildPlaceholderPlan();

    const result = await generatePlaceholders({
      outDir: directory,
      items: plan,
    });

    expect(result.written).toHaveLength(103);
    expect(result.skipped).toEqual([]);
    expect(readdirSync(directory).sort()).toEqual(
      plan.map((item) => item.fileName).sort(),
    );
    // The same check `images:upload --dry-run` makes, for the batch 1 slots.
    const report = analyzeDemoImageFolder(
      directory,
      getCatalogExpansionImageSlots(),
      {
        expectedBanners: CATALOG_EXPANSION_BANNER_NAMES,
      },
    );
    expect(reportHasProblems(report)).toBe(false);
    expect(report.productFiles).toHaveLength(91);
    expect(report.bannerFiles).toHaveLength(12);
    expect(report.missingBanners).toEqual([]);
    expect(result.bytes).toBe(
      plan.reduce(
        (sum, item) => sum + statSync(join(directory, item.fileName)).size,
        0,
      ),
    );
    // Every file is under the 10 MB limit the uploader enforces, by far.
    expect(
      Math.max(
        ...plan.map((item) => statSync(join(directory, item.fileName)).size),
      ),
    ).toBeLessThan(500_000);
  }, 120_000);

  it('writes real JPEGs of the right size', async () => {
    const plan = buildPlaceholderPlan().filter((item) =>
      [
        'studio-high-rise-leggings__sage.jpg',
        'category-activewear.jpg',
      ].includes(item.fileName),
    );

    await generatePlaceholders({ outDir: directory, items: plan });

    for (const item of plan) {
      const meta = await sharp(join(directory, item.fileName)).metadata();
      expect(meta.format).toBe('jpeg');
      expect([meta.width, meta.height]).toEqual([item.width, item.height]);
    }
  });

  it('gives the same bytes on every run', async () => {
    const plan = buildPlaceholderPlan().slice(0, 6);
    const other = mkdtempSync(join(tmpdir(), 'placeholders-'));
    try {
      await generatePlaceholders({ outDir: directory, items: plan });
      await generatePlaceholders({ outDir: other, items: plan });

      const different = plan.filter(
        (item) =>
          !readFileSync(join(directory, item.fileName)).equals(
            readFileSync(join(other, item.fileName)),
          ),
      );
      expect(different.map((item) => item.fileName)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps a file that is already there, so a real picture is never overwritten', async () => {
    const plan = buildPlaceholderPlan().slice(0, 3);
    await generatePlaceholders({ outDir: directory, items: plan.slice(0, 1) });
    const real = Buffer.from('a real picture');
    writeFileSync(join(directory, plan[0].fileName), real);

    const result = await generatePlaceholders({
      outDir: directory,
      items: plan,
    });

    expect(result.skipped).toEqual([plan[0].fileName]);
    expect(result.written).toEqual([plan[1].fileName, plan[2].fileName].sort());
    expect(readFileSync(join(directory, plan[0].fileName)).equals(real)).toBe(
      true,
    );
  });

  it('rewrites existing files only with force', async () => {
    const plan = buildPlaceholderPlan().slice(0, 2);
    await generatePlaceholders({ outDir: directory, items: plan });
    writeFileSync(join(directory, plan[0].fileName), Buffer.from('old'));

    const result = await generatePlaceholders({
      outDir: directory,
      items: plan,
      force: true,
    });

    expect(result.written).toHaveLength(2);
    expect(
      readFileSync(join(directory, plan[0].fileName)).length,
    ).toBeGreaterThan(1000);
  });

  it('leaves no temporary file behind, also when a picture fails', async () => {
    const plan = buildPlaceholderPlan().slice(0, 3);

    await expect(
      generatePlaceholders({
        outDir: directory,
        items: plan,
        concurrency: 1,
        render: (item) =>
          item === plan[1]
            ? Promise.reject(new Error('render failed'))
            : Promise.resolve(Buffer.from('jpeg')),
      }),
    ).rejects.toThrow('render failed');

    expect(
      readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('creates the folder when it does not exist yet', async () => {
    const nested = join(directory, 'a', 'b');
    await generatePlaceholders({
      outDir: nested,
      items: buildPlaceholderPlan().slice(0, 1),
      render: () => Promise.resolve(Buffer.from('jpeg')),
    });

    expect(existsSync(nested)).toBe(true);
  });
});

describe('where the pictures go', () => {
  it('defaults to a folder outside the repository', () => {
    const folder = defaultOutputDirectory();

    expect(isInsideRepository(folder)).toBe(false);
    expect(folder.endsWith(join('_catalog-input', 'images'))).toBe(true);
    expect(resolve(folder, '..', '..')).toBe(resolve(REPOSITORY_ROOT, '..'));
  });

  it('recognises a folder inside the repository', () => {
    expect(isInsideRepository(REPOSITORY_ROOT)).toBe(true);
    expect(isInsideRepository(join(REPOSITORY_ROOT, 'dist', 'images'))).toBe(
      true,
    );
    expect(isInsideRepository(join(REPOSITORY_ROOT, '..', 'elsewhere'))).toBe(
      false,
    );
    expect(isInsideRepository(tmpdir())).toBe(false);
  });
});
