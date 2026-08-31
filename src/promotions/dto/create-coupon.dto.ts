import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { NormalizeUpper, Trim } from '../../catalog/dto-validation';
import { VND_MAX_AMOUNT } from '../../money/vnd-money';
import { CouponType } from '../entities/coupon-type.enum';

export class CreateCouponDto {
  @ApiProperty({
    example: 'WELCOME10',
    description: 'Unique coupon code (alphanumeric, underscores, dashes).',
  })
  @NormalizeUpper()
  @IsString()
  @Length(2, 64)
  @Matches(/^[A-Z0-9_-]+$/, {
    message:
      'Code may only contain uppercase letters, numbers, underscores, and dashes',
  })
  code!: string;

  @ApiProperty({
    example: '10% off for new customers',
    description: 'Coupon description/title.',
  })
  @Trim()
  @IsString()
  @Length(2, 255)
  name!: string;

  @ApiProperty({
    enum: CouponType,
    example: CouponType.PERCENTAGE,
    description: 'Coupon discount type: PERCENTAGE or FIXED.',
  })
  @IsEnum(CouponType)
  type!: CouponType;

  @ApiProperty({
    example: 10,
    description:
      'Discount value: 1-100 for PERCENTAGE, positive integer VND for FIXED.',
  })
  @IsInt()
  @Min(1)
  @Max(VND_MAX_AMOUNT)
  value!: number;

  @ApiPropertyOptional({
    example: 300000,
    description: 'Minimum subtotal in VND required to apply this coupon.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(VND_MAX_AMOUNT)
  minSubtotal?: number | null;

  @ApiPropertyOptional({
    example: 100000,
    description:
      'Maximum discount in VND (only applicable for PERCENTAGE type, must be > 0).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VND_MAX_AMOUNT)
  maxDiscount?: number | null;

  @ApiPropertyOptional({
    example: '2026-01-01T00:00:00Z',
    description: 'Start timestamp (ISO 8601 string).',
  })
  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @ApiPropertyOptional({
    example: '2026-12-31T23:59:59Z',
    description: 'Expiration timestamp (ISO 8601 string).',
  })
  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether the coupon is active.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
