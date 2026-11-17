import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Trim } from '../../catalog/dto-validation';
import { INT_MAX } from '../../validation/limits';
import { ProductStatus } from '../entities/product-status.enum';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Updated Example Laptop' })
  @Trim()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ example: 'Updated fictional description.' })
  @Trim()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ type: 'integer', example: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INT_MAX)
  categoryId?: number;

  @ApiPropertyOptional({
    type: 'integer',
    example: 1,
    minimum: 1,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INT_MAX)
  brandId?: number | null;

  @ApiPropertyOptional({ enum: ProductStatus, example: ProductStatus.ACTIVE })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}
