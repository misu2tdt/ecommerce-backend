import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { INT_MAX } from '../../validation/limits';

export class AddWishlistItemDto {
  @ApiProperty({ type: 'integer', example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(INT_MAX)
  productId!: number;
}
