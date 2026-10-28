import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemoImagesCli } from './demo-images-cli';
import { analyzeDemoImageFolder } from './demo-image-files';
import {
  DemoImageAuthError,
  readCloudinaryCredentials,
  uploadDemoImages,
  type DemoImageUploadClient,
  type DemoImageUploadOptions,
} from './demo-image-upload';
import {
  parseDemoImageManifest,
  serializeDemoImageManifest,
  type DemoImageSlot,
} from './demo-image-manifest';
import { getDemoImageSlots } from './demo-seed';

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

const SECRET = 'S3cr3t-value-that-must-never-be-printed';
const API_KEY = '123456789012345';
const CLOUD = 'my-real-looking-cloud';
const validEnv = {
  CLOUDINARY_CLOUD_NAME: CLOUD,
  CLOUDINARY_API_KEY: API_KEY,
  CLOUDINARY_API_SECRET: SECRET,
};

type UploadCall = { filePath: string; options: DemoImageUploadOptions };

function successResult(options: DemoImageUploadOptions) {
  return {
    secure_url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/${options.public_id}.jpg`,
    public_id: options.public_id,
    width: options.public_id.includes('banner') ? 1536 : 1024,
    height: options.public_id.includes('banner') ? 1024 : 1536,
  };
}

function createClient(
  behaviour?: (call: UploadCall, attempt: number) => unknown,
) {
  const calls: UploadCall[] = [];
  const attempts = new Map<string, number>();
  const upload = jest.fn(
    async (filePath: string, options: DemoImageUploadOptions) => {
      calls.push({ filePath, options });
      const attempt = (attempts.get(options.public_id) ?? 0) + 1;
      attempts.set(options.public_id, attempt);
      if (behaviour) {
        const outcome = behaviour({ filePath, options }, attempt);
        if (
          outcome instanceof Error ||
          (outcome && typeof outcome === 'object' && 'error' in outcome)
        ) {
          // The Cloudinary SDK rejects with a plain { error } object as well.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw outcome;
        }
        if (outcome) return outcome as ReturnType<typeof successResult>;
      }
      return successResult(options);
    },
  );
  return { client: { upload } as DemoImageUploadClient, upload, calls };
}

describe('demo image tooling', () => {
  let directory: string;
  let outputFile: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'demo-images-upload-'));
    outputFile = join(directory, 'out', 'demo-images.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function imageFolder(files: string[]) {
    const folder = join(directory, 'images');
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    for (const name of files) writeFileSync(join(folder, name), 'x'.repeat(32));
    return folder;
  }

  const allProductFiles = [
    'alpha-tee__black.jpg',
    'alpha-tee__sage-green.jpg',
    'beta-cap__navy.png',
  ];

  describe('readCloudinaryCredentials', () => {
    it('returns the three values when they look real', () => {
      expect(readCloudinaryCredentials(validEnv)).toEqual({
        cloudName: CLOUD,
        apiKey: API_KEY,
        apiSecret: SECRET,
      });
    });

    it('names the missing variables but never prints any value', () => {
      let message = '';
      try {
        readCloudinaryCredentials({
          CLOUDINARY_CLOUD_NAME: CLOUD,
          CLOUDINARY_API_SECRET: SECRET,
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('CLOUDINARY_API_KEY');
      expect(message).not.toContain('CLOUDINARY_CLOUD_NAME');
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(CLOUD);
    });

    it.each([
      'e2e-disabled',
      'browser-disabled',
      'placeholder',
      'your-cloud-name',
      'YOUR_API_KEY',
      '<cloud-name>',
      'changeme',
      '   ',
    ])('refuses the placeholder value %p', (value) => {
      expect(() =>
        readCloudinaryCredentials({ ...validEnv, CLOUDINARY_API_KEY: value }),
      ).toThrow(/CLOUDINARY_API_KEY/);
    });
  });

  describe('uploadDemoImages', () => {
    function plan(
      files = allProductFiles.concat([
        'banner-home.jpg',
        'brand-kanso.jpg',
        'category-tees.jpg',
      ]),
    ) {
      return analyzeDemoImageFolder(imageFolder(files), slots);
    }

    it('uploads with deterministic public ids, overwrite and a width limit, without cropping', async () => {
      const { client, calls } = createClient();

      const outcome = await uploadDemoImages({
        report: plan(),
        client,
        sleep: async () => undefined,
      });

      expect(outcome.uploaded).toBe(6);
      expect(outcome.skipped).toBe(0);
      expect(outcome.failed).toEqual([]);
      const byId = Object.fromEntries(
        calls.map((call) => [call.options.public_id, call.options]),
      );
      expect(Object.keys(byId).sort()).toEqual([
        'evergreen/demo/alpha-tee__black',
        'evergreen/demo/alpha-tee__sage-green',
        'evergreen/demo/banner-home',
        'evergreen/demo/beta-cap__navy',
        'evergreen/demo/brand-kanso',
        'evergreen/demo/category-tees',
      ]);
      for (const options of Object.values(byId)) {
        expect(options.overwrite).toBe(true);
        expect(options.resource_type).toBe('image');
        expect(options.transformation).toHaveLength(1);
        const [step] = options.transformation;
        expect(step.crop).toBe('limit');
        expect(step.quality).toBeGreaterThanOrEqual(70);
        expect(step.quality).toBeLessThanOrEqual(95);
      }
      expect(
        byId['evergreen/demo/alpha-tee__black'].transformation[0].width,
      ).toBe(1600);
      expect(byId['evergreen/demo/banner-home'].transformation[0].width).toBe(
        2400,
      );
      expect(byId['evergreen/demo/brand-kanso'].transformation[0].width).toBe(
        2400,
      );
    });

    it('builds a sorted manifest with only public data', async () => {
      // The first product image finishes last on purpose: the manifest must
      // still come out sorted, not in completion order.
      const upload = jest.fn(
        async (_filePath: string, options: DemoImageUploadOptions) => {
          if (options.public_id.endsWith('alpha-tee__black')) {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          return successResult(options);
        },
      );

      const { manifest } = await uploadDemoImages({
        report: plan(),
        client: { upload },
        sleep: async () => undefined,
      });

      expect(manifest.products).toEqual([
        {
          productSlug: 'alpha-tee',
          colorSlug: 'black',
          url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/evergreen/demo/alpha-tee__black.jpg`,
          width: 1024,
          height: 1536,
        },
        expect.objectContaining({
          productSlug: 'alpha-tee',
          colorSlug: 'sage-green',
        }),
        expect.objectContaining({ productSlug: 'beta-cap', colorSlug: 'navy' }),
      ]);
      expect(manifest.banners.map((banner) => banner.name)).toEqual([
        'banner-home',
        'brand-kanso',
        'category-tees',
      ]);
      expect(Object.keys(manifest.banners[0]).sort()).toEqual([
        'height',
        'name',
        'url',
        'width',
      ]);

      const text = serializeDemoImageManifest(manifest);
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(directory);
      expect(parseDemoImageManifest(JSON.parse(text))).toEqual(manifest);
    });

    it('is idempotent: running twice produces the same public ids and the same manifest text', async () => {
      const first = createClient();
      const second = createClient();

      const a = await uploadDemoImages({
        report: plan(),
        client: first.client,
        sleep: async () => undefined,
      });
      const b = await uploadDemoImages({
        report: plan(),
        client: second.client,
        sleep: async () => undefined,
      });

      expect(second.calls.map((c) => c.options.public_id).sort()).toEqual(
        first.calls.map((c) => c.options.public_id).sort(),
      );
      expect(serializeDemoImageManifest(b.manifest)).toBe(
        serializeDemoImageManifest(a.manifest),
      );
    });

    it('retries transient failures with a growing delay and then succeeds', async () => {
      const sleeps: number[] = [];
      const { client, upload } = createClient((call, attempt) =>
        call.options.public_id.endsWith('beta-cap__navy') && attempt <= 2
          ? Object.assign(new Error('Service unavailable'), { http_code: 503 })
          : undefined,
      );

      const outcome = await uploadDemoImages({
        report: plan(allProductFiles),
        client,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      expect(outcome.uploaded).toBe(3);
      expect(outcome.failed).toEqual([]);
      expect(upload).toHaveBeenCalledTimes(5);
      expect(sleeps).toHaveLength(2);
      expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    });

    it('recognises network errors and the nested Cloudinary error shape as transient', async () => {
      const { client, upload } = createClient((call, attempt) => {
        if (attempt > 1) return undefined;
        if (call.options.public_id.endsWith('alpha-tee__black')) {
          return Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
          });
        }
        if (call.options.public_id.endsWith('beta-cap__navy')) {
          return { error: { message: 'Rate limit', http_code: 420 } };
        }
        return undefined;
      });

      const outcome = await uploadDemoImages({
        report: plan(allProductFiles),
        client,
        sleep: async () => undefined,
      });

      expect(outcome.uploaded).toBe(3);
      expect(upload).toHaveBeenCalledTimes(5);
    });

    it('gives up on a file after the maximum attempts but still uploads the others', async () => {
      const { client, upload } = createClient((call) =>
        call.options.public_id.endsWith('beta-cap__navy')
          ? Object.assign(new Error('Service unavailable'), { http_code: 503 })
          : undefined,
      );

      const outcome = await uploadDemoImages({
        report: plan(allProductFiles),
        client,
        maxAttempts: 3,
        sleep: async () => undefined,
      });

      expect(outcome.uploaded).toBe(2);
      expect(outcome.failed).toEqual([
        {
          fileName: 'beta-cap__navy.png',
          reason: expect.stringContaining('503'),
        },
      ]);
      expect(
        upload.mock.calls.filter(([, o]) =>
          o.public_id.endsWith('beta-cap__navy'),
        ),
      ).toHaveLength(3);
    });

    it('does not retry a permanent error such as a rejected image', async () => {
      const { client, upload } = createClient((call) =>
        call.options.public_id.endsWith('beta-cap__navy')
          ? Object.assign(new Error('Invalid image file'), { http_code: 400 })
          : undefined,
      );

      const outcome = await uploadDemoImages({
        report: plan(allProductFiles),
        client,
        sleep: async () => undefined,
      });

      expect(outcome.failed.map((f) => f.fileName)).toEqual([
        'beta-cap__navy.png',
      ]);
      expect(
        upload.mock.calls.filter(([, o]) =>
          o.public_id.endsWith('beta-cap__navy'),
        ),
      ).toHaveLength(1);
    });

    it('fails a file whose result is not an https url', async () => {
      const { client } = createClient((call) => ({
        ...successResult(call.options),
        secure_url: 'http://insecure.example/x.jpg',
      }));

      const outcome = await uploadDemoImages({
        report: plan(allProductFiles),
        client,
        sleep: async () => undefined,
      });

      expect(outcome.uploaded).toBe(0);
      expect(outcome.failed).toHaveLength(3);
    });

    it('stops at the first authentication failure without printing secrets', async () => {
      const { client, upload } = createClient(() => ({
        error: {
          message: `Invalid api_key ${API_KEY} for ${SECRET}`,
          http_code: 401,
        },
      }));

      const failure = await uploadDemoImages({
        report: plan(),
        client,
        concurrency: 1,
        secrets: [SECRET, API_KEY],
        sleep: async () => undefined,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DemoImageAuthError);
      const error = failure as DemoImageAuthError;
      expect(error.message).toMatch(/authentication/i);
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain(API_KEY);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(error.uploaded).toBe(0);
      expect(error.skipped).toBe(5);
    });

    it('never runs more uploads at once than the concurrency limit', async () => {
      let active = 0;
      let peak = 0;
      const upload = jest.fn(
        async (_filePath: string, options: DemoImageUploadOptions) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return successResult(options);
        },
      );

      await uploadDemoImages({
        report: plan(),
        client: { upload },
        concurrency: 2,
        sleep: async () => undefined,
      });

      expect(upload).toHaveBeenCalledTimes(6);
      expect(peak).toBe(2);
    });
  });

  describe('manifest parsing', () => {
    it('rejects malformed manifests with a clear message', () => {
      expect(() => parseDemoImageManifest(null)).toThrow(/manifest/i);
      expect(() => parseDemoImageManifest({ products: [] })).toThrow(/banners/);
      expect(() =>
        parseDemoImageManifest({
          products: [
            {
              productSlug: 'a',
              colorSlug: 'b',
              url: 'http://x/y.jpg',
              width: 1,
              height: 1,
            },
          ],
          banners: [],
        }),
      ).toThrow(/https/);
      expect(() =>
        parseDemoImageManifest({
          products: [
            {
              productSlug: 'a',
              colorSlug: 'b',
              url: 'https://x/y.jpg',
              width: 0,
              height: 1,
            },
          ],
          banners: [],
        }),
      ).toThrow(/width/);
    });
  });

  describe('images:upload command', () => {
    function io() {
      const lines: string[] = [];
      return {
        lines,
        log: (line: string) => lines.push(line),
        error: (line: string) => lines.push(line),
        text: () => lines.join('\n'),
      };
    }

    function fullCatalogFolder(extra: string[] = []) {
      const names = getDemoImageSlots().map(
        (slot) => `${slot.productSlug}__${slot.colorSlug}.jpg`,
      );
      return imageFolder(
        names.concat(
          ['banner-home.jpg', 'category-tees.jpg', 'brand-kanso.jpg'],
          extra,
        ),
      );
    }

    it('dry run passes for a complete folder, needs no credentials and makes no network call', async () => {
      const output = io();
      const createClientSpy = jest.fn();

      const code = await runDemoImagesCli(
        ['--dir', fullCatalogFolder(), '--dry-run'],
        { env: {}, io: output, createClient: createClientSpy, outputFile },
      );

      expect(code).toBe(0);
      expect(createClientSpy).not.toHaveBeenCalled();
      expect(existsSync(outputFile)).toBe(false);
      expect(output.text()).toContain('Product images found: 48 of 48');
      expect(output.text()).toContain('Banner-style images found: 3');
      expect(output.text()).toMatch(/dry run/i);
    });

    it('dry run exits non-zero and lists a missing product image', async () => {
      const folder = fullCatalogFolder();
      rmSync(join(folder, 'classic-crewneck-cotton-tee__white.jpg'));
      const output = io();

      const code = await runDemoImagesCli(['--dir', folder, '--dry-run'], {
        env: {},
        io: output,
        outputFile,
      });

      expect(code).toBe(1);
      expect(output.text()).toContain('classic-crewneck-cotton-tee__white');
      expect(output.text()).toContain('Product images found: 47 of 48');
    });

    it('dry run exits non-zero for an unexpected file', async () => {
      const output = io();

      const code = await runDemoImagesCli(
        ['--dir', fullCatalogFolder(['mystery__file.jpg']), '--dry-run'],
        { env: {}, io: output, outputFile },
      );

      expect(code).toBe(1);
      expect(output.text()).toContain('mystery__file.jpg');
    });

    it('exits with a usage error when --dir is missing or the folder does not exist', async () => {
      const missingDir = io();
      expect(
        await runDemoImagesCli(['--dry-run'], {
          env: {},
          io: missingDir,
          outputFile,
        }),
      ).toBe(2);
      expect(missingDir.text()).toMatch(/--dir/);

      const badDir = io();
      expect(
        await runDemoImagesCli(
          ['--dir', join(directory, 'nope'), '--dry-run'],
          {
            env: {},
            io: badDir,
            outputFile,
          },
        ),
      ).toBe(1);
      expect(badDir.text()).toMatch(/folder/i);
    });

    it('refuses a real run when credentials are missing or placeholders, before any upload', async () => {
      const createClientSpy = jest.fn();
      for (const env of [
        {},
        {
          CLOUDINARY_CLOUD_NAME: 'e2e-disabled',
          CLOUDINARY_API_KEY: 'e2e-disabled',
          CLOUDINARY_API_SECRET: 'e2e-disabled',
        },
      ]) {
        const output = io();
        const code = await runDemoImagesCli(['--dir', fullCatalogFolder()], {
          env,
          io: output,
          createClient: createClientSpy,
          outputFile,
        });
        expect(code).toBe(1);
        expect(output.text()).toMatch(/CLOUDINARY_/);
      }
      expect(createClientSpy).not.toHaveBeenCalled();
      expect(existsSync(outputFile)).toBe(false);
    });

    it('refuses a real run when the folder has problems and uploads nothing', async () => {
      const folder = fullCatalogFolder();
      rmSync(join(folder, 'classic-crewneck-cotton-tee__white.jpg'));
      const { client, upload } = createClient();

      const code = await runDemoImagesCli(['--dir', folder], {
        env: validEnv,
        io: io(),
        createClient: () => client,
        outputFile,
      });

      expect(code).toBe(1);
      expect(upload).not.toHaveBeenCalled();
      expect(existsSync(outputFile)).toBe(false);
    });

    it('uploads everything, writes the manifest atomically and prints a summary without secrets', async () => {
      const { client, upload } = createClient();
      const output = io();

      const code = await runDemoImagesCli(['--dir', fullCatalogFolder()], {
        env: validEnv,
        io: output,
        createClient: () => client,
        outputFile,
        sleep: async () => undefined,
      });

      expect(code).toBe(0);
      expect(upload).toHaveBeenCalledTimes(51);
      expect(output.text()).toMatch(/uploaded: 51/i);
      expect(output.text()).toMatch(/skipped: 0/i);
      expect(output.text()).toMatch(/failed: 0/i);

      const text = readFileSync(outputFile, 'utf8');
      const manifest = parseDemoImageManifest(JSON.parse(text));
      expect(manifest.products).toHaveLength(48);
      expect(manifest.banners).toHaveLength(3);
      expect(readdirSync(join(directory, 'out'))).toEqual(['demo-images.json']);
      for (const haystack of [text, output.text()]) {
        expect(haystack).not.toContain(SECRET);
        expect(haystack).not.toContain(API_KEY);
        expect(haystack).not.toContain(directory);
      }

      // A re-run is idempotent: same public ids, byte-identical file.
      const again = await runDemoImagesCli(['--dir', fullCatalogFolder()], {
        env: validEnv,
        io: io(),
        createClient: () => client,
        outputFile,
        sleep: async () => undefined,
      });
      expect(again).toBe(0);
      expect(readFileSync(outputFile, 'utf8')).toBe(text);
    });

    it('keeps an existing manifest untouched when an upload fails', async () => {
      mkdirSync(join(directory, 'out'), { recursive: true });
      writeFileSync(outputFile, 'previous good content\n');
      const { client } = createClient((call) =>
        call.options.public_id.endsWith('classic-pique-cotton-polo__white')
          ? Object.assign(new Error('Invalid image file'), { http_code: 400 })
          : undefined,
      );
      const output = io();

      const code = await runDemoImagesCli(['--dir', fullCatalogFolder()], {
        env: validEnv,
        io: output,
        createClient: () => client,
        outputFile,
        sleep: async () => undefined,
      });

      expect(code).toBe(1);
      expect(readFileSync(outputFile, 'utf8')).toBe('previous good content\n');
      expect(readdirSync(join(directory, 'out'))).toEqual(['demo-images.json']);
      expect(output.text()).toMatch(/failed: 1/i);
      expect(output.text()).toContain('classic-pique-cotton-polo__white.jpg');
    });

    it('stops with a clear message on an authentication failure and keeps secrets out of the output', async () => {
      const { client } = createClient(() => ({
        error: {
          message: `Invalid api_key ${API_KEY} ${SECRET}`,
          http_code: 401,
        },
      }));
      const output = io();

      const code = await runDemoImagesCli(['--dir', fullCatalogFolder()], {
        env: validEnv,
        io: output,
        createClient: () => client,
        outputFile,
        sleep: async () => undefined,
      });

      expect(code).toBe(1);
      expect(existsSync(outputFile)).toBe(false);
      expect(output.text()).toMatch(/authentication/i);
      expect(output.text()).not.toContain(SECRET);
      expect(output.text()).not.toContain(API_KEY);
    });
  });
});
