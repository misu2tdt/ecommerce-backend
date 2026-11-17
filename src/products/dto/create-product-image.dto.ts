import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from '../../catalog/dto-validation';
import { MAX_POSITION } from '../../validation/limits';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductImageDto {
  @ApiPropertyOptional({ example: 'Front view of the product', maxLength: 255 })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  altText?: string;

  @ApiPropertyOptional({ type: 'integer', example: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_POSITION)
  position?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isPrimary?: boolean;
}
