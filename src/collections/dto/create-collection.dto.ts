import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from '../../catalog/dto-validation';

// Lowercase words joined by single dashes, like the slugs createSlug produces.
export const COLLECTION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COLLECTION_SLUG_MAX_LENGTH = 160;
export const COLLECTION_SORT_ORDER_MAX = 100_000;

export class CreateCollectionDto {
  @ApiProperty({
    example: 'Everyday Essentials',
    description: 'Collection name. The slug is generated from it.',
  })
  @Trim()
  @IsString()
  @Length(2, 120, { message: 'name must be between 2 and 120 characters' })
  name!: string;

  @ApiPropertyOptional({
    example: 'everyday-essentials',
    description:
      'Optional URL slug: lowercase letters and numbers joined by single dashes. Generated from the name when left out.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(COLLECTION_SLUG_MAX_LENGTH, {
    message: `slug must not be longer than ${COLLECTION_SLUG_MAX_LENGTH} characters`,
  })
  @Matches(COLLECTION_SLUG_PATTERN, {
    message:
      'slug may only contain lowercase letters and numbers joined by single dashes',
  })
  slug?: string;

  @ApiPropertyOptional({
    example: 'Simple pieces that go with everything.',
    description: 'Short text shown on the collection page.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000, {
    message: 'description must not be longer than 2000 characters',
  })
  description?: string | null;

  @ApiPropertyOptional({
    example: 'https://res.cloudinary.com/demo/image/upload/collection.jpg',
    description: 'Public https or http address of the hero image.',
  })
  @IsOptional()
  @Trim()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'heroImageUrl must be a valid http or https address' },
  )
  @MaxLength(2048, {
    message: 'heroImageUrl must not be longer than 2048 characters',
  })
  heroImageUrl?: string | null;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether the collection is shown publicly.',
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'isActive must be true or false' })
  isActive?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Marks the collection for prominent placement.',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'isFeatured must be true or false' })
  isFeatured?: boolean;

  @ApiPropertyOptional({
    example: 0,
    description: 'Lower values come first in the public list.',
    default: 0,
  })
  @IsOptional()
  @IsInt({ message: 'sortOrder must be a whole number' })
  @Min(0, { message: 'sortOrder must be 0 or more' })
  @Max(COLLECTION_SORT_ORDER_MAX, {
    message: `sortOrder must not be greater than ${COLLECTION_SORT_ORDER_MAX}`,
  })
  sortOrder?: number;
}
