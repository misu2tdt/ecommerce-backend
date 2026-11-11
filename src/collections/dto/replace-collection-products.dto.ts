import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, Min } from 'class-validator';

// The most products one collection can hold.
export const COLLECTION_MAX_PRODUCTS = 200;

export class ReplaceCollectionProductsDto {
  @ApiProperty({
    type: [Number],
    example: [12, 7, 31],
    description: `Product ids in display order (first is shown first). Replaces the whole membership; at most ${COLLECTION_MAX_PRODUCTS} products, no repeats. An empty list empties the collection.`,
  })
  @IsArray({ message: 'productIds must be an array of product ids' })
  @ArrayMaxSize(COLLECTION_MAX_PRODUCTS, {
    message: `productIds must not hold more than ${COLLECTION_MAX_PRODUCTS} products`,
  })
  @IsInt({ each: true, message: 'every product id must be a whole number' })
  @Min(1, { each: true, message: 'every product id must be 1 or more' })
  productIds!: number[];
}
