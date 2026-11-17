import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { NormalizeUpper } from '../../catalog/dto-validation';
import { INT_MAX } from '../../validation/limits';

export class CheckoutCartDto {
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
