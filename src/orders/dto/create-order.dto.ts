import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { NormalizeUpper } from '../../catalog/dto-validation';

export class OrderItemDto {
  @ApiProperty({
    type: 'integer',
    example: 1,
    minimum: 1,
    description: 'ProductVariant ID.',
  })
  @IsInt()
  @Min(1)
  variantId!: number;

  @ApiProperty({ type: 'integer', example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
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
  addressId!: number;

  @ApiProperty({ type: [OrderItemDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
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
