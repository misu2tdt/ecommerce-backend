import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeDemoImageFolder } from '../demo-image-files';
import { runDemoImagesCli } from '../demo-images-cli';
import { getDemoImageSlots } from '../demo-seed';
import {
  CATALOG_EXPANSION_BANNER_NAMES,
  getCatalogExpansionImageSlots,
} from './image-slots';

const fileName = (slot: { productSlug: string; colorSlug: string }) =>
  `${slot.productSlug}__${slot.colorSlug}.jpg`;

describe('images:upload --catalog all', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'catalog-images-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function folder(files: string[]) {
    const images = join(directory, 'images');
    rmSync(images, { recursive: true, force: true });
    mkdirSync(images, { recursive: true });
    for (const name of files) writeFileSync(join(images, name), 'x'.repeat(32));
    return images;
  }

  function io() {
    const lines: string[] = [];
    return {
      lines,
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
      text: () => lines.join('\n'),
    };
  }

  const baseFiles = () => getDemoImageSlots().map(fileName);
  const expansionFiles = () => getCatalogExpansionImageSlots().map(fileName);
  const expansionBanners = () =>
    CATALOG_EXPANSION_BANNER_NAMES.map((name) => `${name}.png`);

  it('expects 48 base images and 91 more: 139 in all', () => {
    expect(getDemoImageSlots()).toHaveLength(48);
    expect(getCatalogExpansionImageSlots()).toHaveLength(91);
  });

  it('a complete folder passes the dry run with the flag, with no credentials and no network call', async () => {
    const output = io();
    const createClient = jest.fn();

    const code = await runDemoImagesCli(
      [
        '--dir',
        folder([...baseFiles(), ...expansionFiles(), ...expansionBanners()]),
        '--catalog',
        'all',
        '--dry-run',
      ],
      {
        env: {},
        io: output,
        createClient,
        outputFile: join(directory, 'out.json'),
      },
    );

    expect(code).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(output.text()).toContain('Product images found: 139 of 139');
    expect(output.text()).toContain('Banner-style images found: 8');
    expect(output.text()).not.toContain('Expected banners not found');
  });

  it('with the flag, the 91 new images are reported missing when only the base ones are there', async () => {
    const output = io();

    const code = await runDemoImagesCli(
      ['--dir', folder(baseFiles()), '--catalog', 'all', '--dry-run'],
      { env: {}, io: output, outputFile: join(directory, 'out.json') },
    );

    expect(code).toBe(1);
    expect(output.text()).toContain('Product images found: 48 of 139');
    expect(output.text()).toContain('Missing product images (91)');
    expect(output.text()).toContain(
      'missing: studio-high-rise-leggings__black.jpg',
    );
  });

  it('with the flag, missing batch banners are only a note', async () => {
    const output = io();

    const code = await runDemoImagesCli(
      [
        '--dir',
        folder([
          ...baseFiles(),
          ...expansionFiles(),
          'category-activewear.png',
        ]),
        '--catalog',
        'all',
        '--dry-run',
      ],
      { env: {}, io: output, outputFile: join(directory, 'out.json') },
    );

    expect(code).toBe(0);
    expect(output.text()).toContain('Expected banners not found (7, optional)');
    expect(output.text()).toContain(
      'no banner: banner-collection-new-arrivals',
    );
    expect(output.text()).not.toContain('no banner: category-activewear');
  });

  it('accepts the category and collection banner names as banners', () => {
    const report = analyzeDemoImageFolder(folder(expansionBanners()), [], {
      expectedBanners: CATALOG_EXPANSION_BANNER_NAMES,
    });

    expect(report.bannerFiles.map((file) => file.name)).toEqual(
      [...CATALOG_EXPANSION_BANNER_NAMES].sort(),
    );
    expect(report.unexpected).toEqual([]);
    expect(report.missingBanners).toEqual([]);
  });

  it('without the flag nothing changes: 48 images are expected and a batch 1 image is unexpected', async () => {
    const complete = io();
    expect(
      await runDemoImagesCli(
        ['--dir', folder([...baseFiles(), 'banner-home.jpg']), '--dry-run'],
        { env: {}, io: complete, outputFile: join(directory, 'out.json') },
      ),
    ).toBe(0);
    expect(complete.text()).toContain('Product images found: 48 of 48');
    expect(complete.text()).not.toContain('Expected banners');

    const withNew = io();
    expect(
      await runDemoImagesCli(
        ['--dir', folder([...baseFiles(), ...expansionFiles()]), '--dry-run'],
        { env: {}, io: withNew, outputFile: join(directory, 'out.json') },
      ),
    ).toBe(1);
    expect(withNew.text()).toContain(
      'unknown product "studio-high-rise-leggings"',
    );
  });

  it('without the flag the report has no banner list at all', () => {
    const report = analyzeDemoImageFolder(
      folder(baseFiles()),
      getDemoImageSlots(),
    );

    expect(report.missingBanners).toBeUndefined();
  });

  it('refuses a --catalog value other than "all"', async () => {
    for (const argv of [
      ['--dir', directory, '--catalog', 'base'],
      ['--dir', directory, '--catalog'],
    ]) {
      const output = io();
      const code = await runDemoImagesCli(argv, {
        env: {},
        io: output,
        outputFile: join(directory, 'out.json'),
      });
      expect(code).toBe(2);
      expect(output.text()).toContain('--catalog only accepts the value "all"');
    }
  });

  it('a real run with the flag still needs credentials and uploads nothing without them', async () => {
    const createClient = jest.fn();
    const output = io();

    const code = await runDemoImagesCli(
      [
        '--dir',
        folder([...baseFiles(), ...expansionFiles()]),
        '--catalog',
        'all',
      ],
      {
        env: {},
        io: output,
        createClient,
        outputFile: join(directory, 'out.json'),
      },
    );

    expect(code).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(output.text()).toMatch(/CLOUDINARY_/);
  });
});
