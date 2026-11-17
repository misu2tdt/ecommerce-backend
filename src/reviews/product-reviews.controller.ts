import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateProductReviewDto } from './dto/create-product-review.dto';
import { UpdateProductReviewDto } from './dto/update-product-review.dto';
import { ProductReviewsService } from './product-reviews.service';
import { ParseIdPipe } from '../validation/parse-id.pipe';

@Controller('products/:productId/reviews')
@ApiTags('Reviews')
export class ProductReviewsController {
  constructor(private readonly reviewsService: ProductReviewsService) {}

  @Get()
  @ApiOperation({
    summary: 'List visible public reviews for a Product',
    description: 'Hidden reviews are excluded.',
  })
  findPublic(@Param('productId', ParseIdPipe) productId: number) {
    return this.reviewsService.findPublic(productId);
  }

  @Get('mine')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Get the current user’s Product review' })
  @UseGuards(AuthGuard)
  findMine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseIdPipe) productId: number,
  ) {
    return this.reviewsService.findMine(user.id, productId);
  }

  @Post()
  @ApiForbiddenResponse({ description: 'A DELIVERED purchase is required.' })
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Create the current user’s Product review',
    description: 'Requires a DELIVERED purchase of the Product.',
  })
  @UseGuards(AuthGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseIdPipe) productId: number,
    @Body() dto: CreateProductReviewDto,
  ) {
    return this.reviewsService.create(user.id, productId, dto);
  }

  @Patch('mine')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Update the current user’s Product review' })
  @UseGuards(AuthGuard)
  updateMine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseIdPipe) productId: number,
    @Body() dto: UpdateProductReviewDto,
  ) {
    return this.reviewsService.updateMine(user.id, productId, dto);
  }

  @Delete('mine')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Delete the current user’s Product review' })
  @UseGuards(AuthGuard)
  removeMine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseIdPipe) productId: number,
  ) {
    return this.reviewsService.removeMine(user.id, productId);
  }
}
