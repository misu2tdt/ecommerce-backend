import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  UploadApiErrorResponse,
  UploadApiResponse,
  v2 as cloudinary,
} from 'cloudinary';
import { getRequiredConfig } from '../config/environment';
import {
  ImageStorageService,
  ProductImageUpload,
  StoredImage,
} from './image-storage.service';

@Injectable()
export class CloudinaryImageStorageService extends ImageStorageService {
  private readonly logger = new Logger(CloudinaryImageStorageService.name);
  private readonly enabled: boolean;

  constructor(configService: ConfigService) {
    super();
    const readConfig = (key: string) => configService.get<unknown>(key);
    const configuredKeys = [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ];
    const hasAnyConfiguration = configuredKeys.some((key) => {
      const value = readConfig(key);
      return typeof value === 'string' && value.trim().length > 0;
    });
    if (!hasAnyConfiguration) {
      this.enabled = false;
      this.logger.warn('Cloudinary image storage is disabled.');
      return;
    }

    this.enabled = true;
    cloudinary.config({
      cloud_name: getRequiredConfig(readConfig, 'CLOUDINARY_CLOUD_NAME'),
      api_key: getRequiredConfig(readConfig, 'CLOUDINARY_API_KEY'),
      api_secret: getRequiredConfig(readConfig, 'CLOUDINARY_API_SECRET'),
      secure: true,
    });
  }

  async uploadProductImage(
    productId: number,
    file: ProductImageUpload,
  ): Promise<StoredImage> {
    this.requireConfigured();
    try {
      const result = await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `ecommerce/products/${productId}`,
            resource_type: 'image',
          },
          (
            error: UploadApiErrorResponse | undefined,
            response: UploadApiResponse | undefined,
          ) => {
            if (error) {
              const providerError: unknown = error;
              if (providerError instanceof Error) {
                reject(providerError);
              } else {
                const details = this.getProviderErrorDetails(providerError);
                reject(
                  Object.assign(new Error(details.message), {
                    http_code: details.status,
                  }),
                );
              }
              return;
            }
            if (!response) {
              reject(new Error('Cloudinary upload failed'));
              return;
            }
            resolve(response);
          },
        );
        stream.end(file.buffer);
      });

      if (!result.secure_url.startsWith('https://') || !result.public_id) {
        throw new Error('Cloudinary returned an invalid image result');
      }

      return { url: result.secure_url, storageKey: result.public_id };
    } catch (error) {
      this.logProviderError('upload', error, productId);
      throw new InternalServerErrorException('Image upload failed', {
        cause: error,
      });
    }
  }

  async deleteImage(storageKey: string): Promise<void> {
    this.requireConfigured();
    try {
      await cloudinary.uploader.destroy(storageKey, {
        invalidate: true,
        resource_type: 'image',
      });
    } catch (error) {
      this.logProviderError('delete', error);
      throw new InternalServerErrorException('Image cleanup failed', {
        cause: error,
      });
    }
  }

  private requireConfigured(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException('Image storage is not configured');
    }
  }

  private logProviderError(
    operation: 'upload' | 'delete',
    error: unknown,
    productId?: number,
  ): void {
    const providerError = this.getProviderErrorDetails(error);
    const context = productId === undefined ? '' : ` productId=${productId}`;
    this.logger.error(
      `Cloudinary ${operation} failed${context} name=${providerError.name} status=${providerError.status} message=${providerError.message}`,
    );
  }

  private getProviderErrorDetails(error: unknown): {
    name: string;
    status: string;
    message: string;
  } {
    const nested = this.readObjectProperty(error, 'error');
    const source = nested ?? error;

    return {
      name: this.readStringProperty(source, 'name') ?? 'unknown',
      status:
        this.readScalarProperty(source, 'http_code') ??
        this.readScalarProperty(source, 'statusCode') ??
        this.readScalarProperty(source, 'status') ??
        'unknown',
      message:
        this.readStringProperty(source, 'message') ?? 'Unknown provider error',
    };
  }

  private readObjectProperty(
    value: unknown,
    key: string,
  ): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const property = (value as Record<string, unknown>)[key];
    return typeof property === 'object' && property !== null
      ? (property as Record<string, unknown>)
      : undefined;
  }

  private readStringProperty(value: unknown, key: string): string | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const property = (value as Record<string, unknown>)[key];
    return typeof property === 'string' && property.length > 0
      ? property
      : undefined;
  }

  private readScalarProperty(value: unknown, key: string): string | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const property = (value as Record<string, unknown>)[key];
    return typeof property === 'string' || typeof property === 'number'
      ? String(property)
      : undefined;
  }
}
