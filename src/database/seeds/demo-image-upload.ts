import { v2 as cloudinary } from 'cloudinary';
import type { DemoImageFile, DemoImageReport } from './demo-image-files';
import type {
  DemoBannerImageEntry,
  DemoImageManifest,
  DemoProductImageEntry,
} from './demo-image-manifest';

export const DEMO_IMAGE_PUBLIC_ID_PREFIX = 'evergreen/demo';
export const PRODUCT_IMAGE_MAX_WIDTH = 1600;
export const BANNER_IMAGE_MAX_WIDTH = 2400;
export const DEMO_IMAGE_QUALITY = 85;

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;
const CREDENTIAL_KEYS = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
] as const;
// Values that mean "not configured": the test setups, .env.example and
// copy-paste leftovers. Uploading with them could only fail or, worse, hit
// the wrong account.
const PLACEHOLDER_VALUE =
  /disabled|placeholder|changeme|change-me|replace[-_ ]?me|^your[-_ ]|^<.*>$|^x{3,}$|^example$|^todo$/i;
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export interface DemoImageUploadOptions {
  public_id: string;
  overwrite: true;
  invalidate: true;
  resource_type: 'image';
  use_filename: false;
  unique_filename: false;
  // Incoming transformation: limits the width, never crops or upscales (the
  // storefront crops with object-cover).
  transformation: Array<{ width: number; crop: 'limit'; quality: number }>;
}

export interface DemoImageUploadResult {
  secure_url: string;
  public_id: string;
  width: number;
  height: number;
}

export interface DemoImageUploadClient {
  upload(
    filePath: string,
    options: DemoImageUploadOptions,
  ): Promise<DemoImageUploadResult>;
}

export interface DemoImageUploadOutcome {
  manifest: DemoImageManifest;
  uploaded: number;
  skipped: number;
  failed: Array<{ fileName: string; reason: string }>;
}

export class DemoImageAuthError extends Error {
  constructor(
    readonly uploaded: number,
    readonly skipped: number,
    readonly failed: number,
  ) {
    super(
      'Cloudinary rejected the credentials (authentication failed). Check your CLOUDINARY_* values. The upload was stopped.',
    );
    this.name = 'DemoImageAuthError';
  }
}

export function readCloudinaryCredentials(
  env: Record<string, string | undefined>,
): CloudinaryCredentials {
  const unusable = CREDENTIAL_KEYS.filter((key) => {
    const value = env[key]?.trim();
    return !value || PLACEHOLDER_VALUE.test(value);
  });
  if (unusable.length > 0) {
    throw new Error(
      `Cloudinary credentials are missing or still placeholders: ${unusable.join(', ')}`,
    );
  }
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME!.trim(),
    apiKey: env.CLOUDINARY_API_KEY!.trim(),
    apiSecret: env.CLOUDINARY_API_SECRET!.trim(),
  };
}

export function createCloudinaryClient(
  credentials: CloudinaryCredentials,
): DemoImageUploadClient {
  cloudinary.config({
    cloud_name: credentials.cloudName,
    api_key: credentials.apiKey,
    api_secret: credentials.apiSecret,
    secure: true,
  });
  return {
    async upload(filePath, options) {
      const result = await cloudinary.uploader.upload(filePath, options);
      return {
        secure_url: result.secure_url,
        public_id: result.public_id,
        width: result.width,
        height: result.height,
      };
    },
  };
}

export async function uploadDemoImages(params: {
  report: DemoImageReport;
  client: DemoImageUploadClient;
  concurrency?: number;
  maxAttempts?: number;
  // Values that must never appear in a message, such as the API key and secret.
  secrets?: readonly string[];
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<DemoImageUploadOutcome> {
  const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = params.sleep ?? defaultSleep;
  const secrets = params.secrets ?? [];

  const queue: Array<{ file: DemoImageFile; maxWidth: number }> = [
    ...params.report.productFiles.map((file) => ({
      file,
      maxWidth: PRODUCT_IMAGE_MAX_WIDTH,
    })),
    ...params.report.bannerFiles.map((file) => ({
      file,
      maxWidth: BANNER_IMAGE_MAX_WIDTH,
    })),
  ];
  const results = new Map<string, DemoImageUploadResult>();
  const failed: DemoImageUploadOutcome['failed'] = [];
  let authFailed = false;

  const worker = async () => {
    while (!authFailed) {
      const task = queue.shift();
      if (!task) return;
      try {
        results.set(task.file.name, await uploadOne(task.file, task.maxWidth));
      } catch (error) {
        if (error instanceof DemoImageAuthError) {
          authFailed = true;
          failed.push({
            fileName: task.file.fileName,
            reason: 'authentication',
          });
        } else {
          failed.push({
            fileName: task.file.fileName,
            reason: describeFailure(error, secrets),
          });
        }
      }
    }
  };

  async function uploadOne(
    file: DemoImageFile,
    maxWidth: number,
  ): Promise<DemoImageUploadResult> {
    const options: DemoImageUploadOptions = {
      public_id: `${DEMO_IMAGE_PUBLIC_ID_PREFIX}/${file.name}`,
      overwrite: true,
      invalidate: true,
      resource_type: 'image',
      use_filename: false,
      unique_filename: false,
      transformation: [
        { width: maxWidth, crop: 'limit', quality: DEMO_IMAGE_QUALITY },
      ],
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await params.client.upload(file.filePath, options);
        assertUsableResult(result);
        return result;
      } catch (error) {
        const details = readErrorDetails(error);
        if (isAuthError(details)) {
          throw new DemoImageAuthError(0, 0, 0);
        }
        if (isTransientError(details) && attempt < maxAttempts) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new UploadFailure(details, attempt);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );

  if (authFailed) {
    throw new DemoImageAuthError(results.size, queue.length, failed.length);
  }

  return {
    manifest: buildManifest(params.report, results),
    uploaded: results.size,
    skipped: 0,
    failed,
  };
}

class UploadFailure extends Error {
  constructor(
    readonly details: ErrorDetails,
    readonly attempts: number,
  ) {
    super(details.message);
  }
}

interface ErrorDetails {
  status?: number;
  code?: string;
  message: string;
}

function assertUsableResult(result: DemoImageUploadResult): void {
  const valid =
    typeof result?.secure_url === 'string' &&
    result.secure_url.startsWith('https://') &&
    Number.isInteger(result.width) &&
    result.width > 0 &&
    Number.isInteger(result.height) &&
    result.height > 0;
  if (!valid) {
    throw new UploadFailure(
      { message: 'Cloudinary returned an unusable result' },
      1,
    );
  }
}

function buildManifest(
  report: DemoImageReport,
  results: ReadonlyMap<string, DemoImageUploadResult>,
): DemoImageManifest {
  const products: DemoProductImageEntry[] = [];
  for (const file of report.productFiles) {
    const result = results.get(file.name);
    if (!result) continue;
    products.push({
      productSlug: file.productSlug,
      colorSlug: file.colorSlug,
      url: result.secure_url,
      width: result.width,
      height: result.height,
    });
  }
  const banners: DemoBannerImageEntry[] = [];
  for (const file of report.bannerFiles) {
    const result = results.get(file.name);
    if (!result) continue;
    banners.push({
      name: file.name,
      url: result.secure_url,
      width: result.width,
      height: result.height,
    });
  }
  return { products, banners };
}

function readErrorDetails(error: unknown): ErrorDetails {
  if (error instanceof UploadFailure) return error.details;
  // The Cloudinary SDK rejects with either an Error or { error: {...} }.
  const nested = readRecord(error, 'error');
  const source = nested ?? (isRecordLike(error) ? error : undefined);
  const status = Number(
    source?.http_code ?? source?.statusCode ?? source?.status,
  );
  return {
    status: Number.isFinite(status) ? status : undefined,
    code: typeof source?.code === 'string' ? source.code : undefined,
    message:
      typeof source?.message === 'string' && source.message
        ? source.message
        : 'Unknown upload error',
  };
}

function isAuthError(details: ErrorDetails): boolean {
  return (
    details.status === 401 ||
    details.status === 403 ||
    /invalid (api[_ ]?key|signature|credentials|cloud[_ ]?name)|unknown api key|must supply api_key/i.test(
      details.message,
    )
  );
}

function isTransientError(details: ErrorDetails): boolean {
  return (
    details.status === 408 ||
    details.status === 420 ||
    details.status === 429 ||
    (details.status !== undefined && details.status >= 500) ||
    (details.code !== undefined && TRANSIENT_NETWORK_CODES.has(details.code)) ||
    /timed? ?out|socket hang up|network/i.test(details.message)
  );
}

function describeFailure(error: unknown, secrets: readonly string[]): string {
  const details = readErrorDetails(error);
  const attempts = error instanceof UploadFailure ? error.attempts : 1;
  const status = details.status ? `HTTP ${details.status}` : 'error';
  const tries = attempts > 1 ? ` after ${attempts} attempts` : '';
  return redact(`${status}${tries}: ${details.message}`, secrets);
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((safe, secret) => safe.split(secret).join('***'), text);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecordLike(value)) return undefined;
  const property = value[key];
  return isRecordLike(property) ? property : undefined;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
