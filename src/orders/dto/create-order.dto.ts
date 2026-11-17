import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { NormalizeUpper } from '../../catalog/dto-validation';
import {
  INT_MAX,
  MAX_LINES,
  MAX_QUANTITY_PER_LINE,
} from '../../validation/limits';

export class OrderItemDto {
  @ApiProperty({
    type: 'integer',
    example: 1,
    minimum: 1,
    description: 'ProductVariant ID.',
  })
  @IsInt()
  @Min(1)
  @Max(INT_MAX)
  variantId!: number;

  @ApiProperty({
    type: 'integer',
    example: 1,
    minimum: 1,
    maximum: MAX_QUANTITY_PER_LINE,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY_PER_LINE)
  quantity!: number;
}

export class CreateOrderDto {
  @ApiProperty({
    type: 'integer',
    example: 1,
    minimum: 1,
    description: 'Owned saved Address ID.',
  })
  @IsInt()
  @Min(1)
  @Max(INT_MAX)
  addressId!: number;

  @ApiProperty({ type: [OrderItemDto], minItems: 1, maxItems: MAX_LINES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @ApiPropertyOptional({
    example: 'WELCOME10',
    description: 'Optional promotional coupon code.',
  })
  @NormalizeUpper()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Z0-9_-]+$/, {
    message:
      'Code may only contain uppercase letters, numbers, underscores, and dashes',
  })
  couponCode?: string;
}
