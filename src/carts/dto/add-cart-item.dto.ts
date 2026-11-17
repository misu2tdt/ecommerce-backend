import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { INT_MAX, MAX_QUANTITY_PER_LINE } from '../../validation/limits';

export class AddCartItemDto {
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
