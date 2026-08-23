import {
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudinaryImageStorageService } from './cloudinary-image-storage.service';

const mockConfig = jest.fn();
const mockUploadStream = jest.fn();
const mockDestroy = jest.fn();

jest.mock('cloudinary', () => ({
  v2: {
    config: (...args: unknown[]) => mockConfig(...args),
    uploader: {
      upload_stream: (...args: unknown[]) => mockUploadStream(...args),
      destroy: (...args: unknown[]) => mockDestroy(...args),
    },
  },
}));

describe('CloudinaryImageStorageService', () => {
  let service: CloudinaryImageStorageService;
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    const values: Record<string, string> = {
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
    };
    service = new CloudinaryImageStorageService({
      get: (key: string) => values[key],
    } as ConfigService);
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => loggerErrorSpy.mockRestore());

  it('allows unrelated reads when Cloudinary is not configured', async () => {
    mockConfig.mockClear();
    const loggerWarnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation();
    const disabled = new CloudinaryImageStorageService({
      get: () => undefined,
    } as unknown as ConfigService);

    await expect(
      disabled.uploadProductImage(42, {
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
        mimetype: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mockConfig).not.toHaveBeenCalled();
    expect(mockUploadStream).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'Cloudinary image storage is disabled.',
    );
    loggerWarnSpy.mockRestore();
  });

  it('rejects partial Cloudinary configuration during bootstrap', () => {
    expect(
      () =>
        new CloudinaryImageStorageService({
          get: (key: string) =>
            key === 'CLOUDINARY_CLOUD_NAME' ? 'configured-cloud' : undefined,
        } as unknown as ConfigService),
    ).toThrow('CLOUDINARY_API_KEY must be configured');
  });

  it('uploads to the Product folder and returns secure provider metadata', async () => {
    mockUploadStream.mockImplementation((_options, callback) => ({
      end: () =>
        callback(undefined, {
          secure_url: 'https://res.cloudinary.com/demo/image.jpg',
          public_id: 'ecommerce/products/42/image',
        }),
    }));

    await expect(
      service.uploadProductImage(42, {
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
        mimetype: 'image/jpeg',
      }),
    ).resolves.toEqual({
      url: 'https://res.cloudinary.com/demo/image.jpg',
      storageKey: 'ecommerce/products/42/image',
    });
    expect(mockUploadStream).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'ecommerce/products/42' }),
      expect.any(Function),
    );
  });

  it('maps SDK upload errors without leaking provider details', async () => {
    const providerError = Object.assign(new Error('cloud_name mismatch'), {
      http_code: 401,
      api_secret: 'must-not-be-logged',
      signed_request: 'must-not-be-logged',
    });
    mockUploadStream.mockImplementation((_options, callback) => ({
      end: () => callback(providerError),
    }));

    const operation = service.uploadProductImage(42, {
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
      mimetype: 'image/jpeg',
    });

    await expect(operation).rejects.toEqual(
      expect.objectContaining({
        constructor: InternalServerErrorException,
        message: 'Image upload failed',
        cause: providerError,
      }),
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Cloudinary upload failed productId=42 name=Error status=401 message=cloud_name mismatch',
    );
    expect(loggerErrorSpy.mock.calls.flat().join(' ')).not.toContain(
      'must-not-be-logged',
    );
  });

  it('deletes by stable storage key', async () => {
    mockDestroy.mockResolvedValue({ result: 'ok' });

    await service.deleteImage('ecommerce/products/42/image');

    expect(mockDestroy).toHaveBeenCalledWith('ecommerce/products/42/image', {
      invalidate: true,
      resource_type: 'image',
    });
  });

  it('maps and safely logs provider delete failures', async () => {
    const providerError = {
      error: {
        message: 'Invalid credentials',
        http_code: 401,
        name: 'CloudinaryError',
        api_secret: 'must-not-be-logged',
      },
    };
    mockDestroy.mockRejectedValue(providerError);

    await expect(
      service.deleteImage('ecommerce/products/42/image'),
    ).rejects.toEqual(
      expect.objectContaining({
        constructor: InternalServerErrorException,
        message: 'Image cleanup failed',
        cause: providerError,
      }),
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Cloudinary delete failed name=CloudinaryError status=401 message=Invalid credentials',
    );
    expect(loggerErrorSpy.mock.calls.flat().join(' ')).not.toContain(
      'must-not-be-logged',
    );
  });
});
