import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { NormalizeUpper } from '../../catalog/dto-validation';

export class QuoteCartDto {
  @ApiPropertyOptional({
    example: 'WELCOME10',
    description:
      'Optional coupon code to preview discount against current cart.',
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
