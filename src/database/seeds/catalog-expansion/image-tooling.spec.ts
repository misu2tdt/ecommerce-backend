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

  describe('batch 1 product pictures must be .jpg', () => {
    const slot = getCatalogExpansionImageSlots()[0];
    const stem = `${slot.productSlug}__${slot.colorSlug}`;
    const withoutIt = () => [
      ...baseFiles(),
      ...expansionFiles().filter((name) => name !== `${stem}.jpg`),
    ];

    async function dryRun(
      files: string[],
      extra: string[] = ['--catalog', 'all'],
    ) {
      const output = io();
      const code = await runDemoImagesCli(
        ['--dir', folder(files), ...extra, '--dry-run'],
        { env: {}, io: output, outputFile: join(directory, 'out.json') },
      );
      return { code, text: output.text() };
    }

    it.each(['png', 'webp', 'jpeg', 'PNG'])(
      'refuses a .%s product picture with a clear message, and uploads nothing',
      async (extension) => {
        const createClient = jest.fn();
        const output = io();

        const code = await runDemoImagesCli(
          [
            '--dir',
            folder([
              ...withoutIt(),
              `${stem}.${extension}`,
              ...expansionBanners(),
            ]),
            '--catalog',
            'all',
          ],
          {
            env: {
              CLOUDINARY_CLOUD_NAME: 'my-real-looking-cloud',
              CLOUDINARY_API_KEY: '123456789012345',
              CLOUDINARY_API_SECRET: 'S3cr3t-value-that-must-never-be-printed',
            },
            io: output,
            createClient,
            outputFile: join(directory, 'out.json'),
          },
        );

        expect(code).toBe(1);
        expect(createClient).not.toHaveBeenCalled();
        expect(output.text()).toContain(
          `unexpected: ${stem}.${extension} - product pictures must be .jpg files. Save it as ${stem}.jpg`,
        );
        expect(output.text()).toContain('Nothing was uploaded');
      },
    );

    it('accepts the same picture as .jpg, in any letter case', async () => {
      for (const name of [`${stem}.jpg`, `${stem}.JPG`]) {
        const { code, text } = await dryRun([
          ...withoutIt(),
          name,
          ...expansionBanners(),
        ]);
        expect(code).toBe(0);
        expect(text).toContain('Product images found: 139 of 139');
      }
    });

    it('does not apply to banners: .png and .jpg banners are both fine', async () => {
      const banners = CATALOG_EXPANSION_BANNER_NAMES.map((name, index) =>
        index % 2 === 0 ? `${name}.png` : `${name}.jpg`,
      );

      const { code, text } = await dryRun([
        ...baseFiles(),
        ...expansionFiles(),
        ...banners,
      ]);

      expect(code).toBe(0);
      expect(text).toContain('Banner-style images found: 8');
    });

    it('does not apply to the base catalog, whose pictures exist as .png', async () => {
      const base = getDemoImageSlots();
      const files = [
        ...base.map((entry, index) =>
          index % 2 === 0
            ? `${fileName(entry)}`
            : `${fileName(entry).replace(/\.jpg$/, '.png')}`,
        ),
        ...expansionFiles(),
      ];

      const { code, text } = await dryRun(files);

      expect(code).toBe(0);
      expect(text).toContain('Product images found: 139 of 139');
    });

    it('is only asked for with --catalog all: without it nothing changes', async () => {
      const { code, text } = await dryRun(
        getDemoImageSlots().map((entry, index) =>
          index === 0
            ? `${fileName(entry).replace(/\.jpg$/, '.png')}`
            : fileName(entry),
        ),
        [],
      );

      expect(code).toBe(0);
      expect(text).toContain('Product images found: 48 of 48');
    });

    it('reports only the files of products that must be .jpg, at the level of the analysis', () => {
      const report = analyzeDemoImageFolder(
        folder([`${stem}.png`, 'other__black.png']),
        [
          {
            productName: 'A',
            productSlug: slot.productSlug,
            colorName: 'X',
            colorSlug: slot.colorSlug,
          },
          {
            productName: 'O',
            productSlug: 'other',
            colorName: 'Black',
            colorSlug: 'black',
          },
        ],
        { jpgOnlyProductSlugs: new Set([slot.productSlug]) },
      );

      expect(report.unexpected.map((entry) => entry.fileName)).toEqual([
        `${stem}.png`,
      ]);
      expect(report.productFiles.map((file) => file.name)).toEqual([
        'other__black',
      ]);
    });
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
