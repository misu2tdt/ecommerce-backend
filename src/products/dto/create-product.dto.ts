import {
  IsInt,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Trim } from '../../catalog/dto-validation';
import { INT_MAX } from '../../validation/limits';
import { ProductStatus } from '../entities/product-status.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'Example Laptop' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 'A fictional catalog product.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ type: 'integer', example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(INT_MAX)
  categoryId!: number;

  @ApiPropertyOptional({ type: 'integer', example: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INT_MAX)
  brandId?: number;

  @ApiPropertyOptional({ enum: ProductStatus, example: ProductStatus.ACTIVE })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}
