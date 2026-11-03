import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  LIST_PAGE_SIZE,
  ListPaginationQueryDto,
  listWithPaging,
  PAGINATION_HEADER_DOCS,
} from '../pagination/pagination';
import { UserRole } from '../users/entities/user-role.enum';
import { UpdateReviewVisibilityDto } from './dto/update-review-visibility.dto';
import { ProductReviewsService } from './product-reviews.service';

@Controller('admin/reviews')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin - Reviews')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
@ApiForbiddenResponse({ description: 'ADMIN role required.' })
export class AdminReviewsController {
  constructor(private readonly reviewsService: ProductReviewsService) {}

  @Get()
  @ApiOperation({
    summary: 'List Product reviews for moderation',
    description:
      'ADMIN only. Includes visibility, reviewer ID, and safe Product context.',
  })
  @ApiOkResponse({
    description:
      'All reviews, or one page when `page` or `limit` is sent (limit defaults to 20, at most 100). Totals are in the X-Total-Count, X-Total-Pages, X-Page and X-Limit headers.',
    headers: PAGINATION_HEADER_DOCS,
  })
  findAll(
    @Query() query: ListPaginationQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return listWithPaging(
      response,
      query,
      LIST_PAGE_SIZE,
      () => this.reviewsService.findAllForAdmin(),
      (paging) => this.reviewsService.findPageForAdmin(paging),
    );
  }

  @Patch(':reviewId/visibility')
  @ApiOperation({
    summary: 'Set public visibility of a Product review',
    description: 'ADMIN only.',
  })
  setVisibility(
    @Param('reviewId', ParseIntPipe) reviewId: number,
    @Body() dto: UpdateReviewVisibilityDto,
  ) {
    return this.reviewsService.setVisibility(reviewId, dto.isVisible);
  }
}
