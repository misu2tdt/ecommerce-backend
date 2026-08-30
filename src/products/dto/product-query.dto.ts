import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Trim } from '../../catalog/dto-validation';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum ProductSort {
  FEATURED = 'featured', // Deterministic default catalog ordering (name ASC, id ASC)
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
  NAME_ASC = 'name_asc',
  NAME_DESC = 'name_desc',
  NEWEST = 'newest',
}

export const TransformStringArray = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const rawList = Array.isArray(value) ? value : [value];
    const items: string[] = [];

    for (const raw of rawList) {
      if (typeof raw === 'string') {
        const parts = raw
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        items.push(...parts);
      } else if (raw !== undefined && raw !== null) {
        const str = String(raw).trim();
        if (str.length > 0) items.push(str);
      }
    }

    const unique = Array.from(new Set(items));
    return unique.length > 0 ? unique : undefined;
  });

export const TransformBoolean = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === 'true' || value === true || value === '1' || value === 1)
      return true;
    if (value === 'false' || value === false || value === '0' || value === 0)
      return false;
    return value;
  });

export const TransformPrice = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : NaN;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') return undefined;
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : NaN;
    }
    return NaN;
  });

export function IsLessThanOrEqualProperty(
  property: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isLessThanOrEqualProperty',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const constraints = args.constraints as string[];
          const relatedPropertyName = constraints[0];
          if (!relatedPropertyName) return true;
          const relatedValue = (args.object as Record<string, unknown>)[
            relatedPropertyName
          ];
          if (
            value === undefined ||
            value === null ||
            relatedValue === undefined ||
            relatedValue === null
          ) {
            return true;
          }
          if (typeof value !== 'number' || typeof relatedValue !== 'number') {
            return true;
          }
          if (Number.isNaN(value) || Number.isNaN(relatedValue)) {
            return true;
          }
          return value <= relatedValue;
        },
        defaultMessage(args: ValidationArguments) {
          const constraints = args.constraints as string[];
          const relatedPropertyName = constraints[0] ?? 'related field';
          return `${args.property} must be less than or equal to ${relatedPropertyName}`;
        },
      },
    });
  };
}

export class ProductQueryDto {
  @ApiPropertyOptional({
    example: 't-shirts-tops',
    description: 'Category slug.',
  })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  category?: string;

  @ApiPropertyOptional({
    example: 'aerothread',
    description: 'Brand slug.',
  })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  brand?: string;

  @ApiPropertyOptional({
    example: 'tee',
    description: 'Product name search.',
  })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  q?: string;

  @ApiPropertyOptional({
    example: ['M', 'L'],
    description:
      'Filter by variant size (single or multiple comma-separated / repeated).',
  })
  @TransformStringArray()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  size?: string[];

  @ApiPropertyOptional({
    example: ['Washed Black', 'Navy Blue'],
    description:
      'Filter by variant color (single or multiple comma-separated / repeated).',
  })
  @TransformStringArray()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  color?: string[];

  @ApiPropertyOptional({
    example: 199000,
    description: 'Minimum variant price in integer VND.',
  })
  @TransformPrice()
  @IsOptional()
  @IsInt()
  @Min(0)
  @IsLessThanOrEqualProperty('maxPrice', {
    message: 'minPrice cannot be greater than maxPrice',
  })
  minPrice?: number;

  @ApiPropertyOptional({
    example: 599000,
    description: 'Maximum variant price in integer VND.',
  })
  @TransformPrice()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Filter products with in-stock variants (stock > 0).',
  })
  @TransformBoolean()
  @IsOptional()
  @IsBoolean()
  inStock?: boolean;

  @ApiPropertyOptional({
    enum: ProductSort,
    example: ProductSort.PRICE_ASC,
    description:
      'Sort ordering for products list (featured = default catalog order).',
  })
  @IsOptional()
  @IsEnum(ProductSort)
  sort?: ProductSort;
}
