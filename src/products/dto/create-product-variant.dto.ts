import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { Trim } from '../../catalog/dto-validation';
import {
  MAX_POSITION,
  MAX_PRICE_VND,
  MAX_STOCK,
} from '../../validation/limits';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductVariantDto {
  @ApiProperty({
    example: 'LAPTOP-16-512-BLK',
    maxLength: 64,
    description: 'Unique purchasable SKU.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sku!: string;

  @ApiProperty({ example: '16 GB / 512 GB / Black', maxLength: 255 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    type: 'integer',
    example: 24990000,
    minimum: 0,
    maximum: MAX_PRICE_VND,
    description: 'Integer VND; decimals are not accepted.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_VND)
  price!: number;

  @ApiPropertyOptional({
    type: 'integer',
    example: 29990000,
    minimum: 0,
    maximum: MAX_PRICE_VND,
    description:
      'Optional compare-at reference price in integer VND (must be > price).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_VND)
  compareAtPrice?: number | null;

  @ApiProperty({
    type: 'integer',
    example: 25,
    minimum: 0,
    maximum: MAX_STOCK,
  })
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  stock!: number;

  @ApiPropertyOptional({
    example: { ram: '16GB', storage: '512GB', color: 'black' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeAttributes(value))
  @IsObject()
  @IsStringRecord()
  attributes?: Record<string, string>;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    type: 'integer',
    example: 0,
    minimum: 0,
    maximum: MAX_POSITION,
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_POSITION)
  position?: number;
}

function IsStringRecord(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isStringRecord',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            Object.entries(value).every(
              ([key, item]) => key.length > 0 && typeof item === 'string',
            )
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must contain only string keys and values`;
        },
      },
    });
}

function normalizeAttributes(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.trim(),
      typeof item === 'string' ? item.trim() : item,
    ]),
  );
}
