import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_QUANTITY_PER_LINE } from '../../validation/limits';

export class UpdateCartItemDto {
  @ApiProperty({
    type: 'integer',
    example: 2,
    minimum: 1,
    maximum: MAX_QUANTITY_PER_LINE,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY_PER_LINE)
  quantity!: number;
}
