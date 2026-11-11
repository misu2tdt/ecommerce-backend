import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { ReplaceCollectionProductsDto } from './dto/replace-collection-products.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';

@Controller('admin/collections')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin - Collections')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
@ApiForbiddenResponse({ description: 'The caller is not an ADMIN.' })
export class AdminCollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all collections',
    description:
      'ADMIN only. Includes inactive collections, with productCount (every product in it) and visibleProductCount (what the public sees). By sortOrder then id.',
  })
  @ApiOkResponse({
    description:
      'All collections, or one page when `page` or `limit` is sent (limit defaults to 20, at most 100). Totals are in the X-Total-Count, X-Total-Pages, X-Page and X-Limit headers.',
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
      () => this.collectionsService.findAllForAdmin(),
      (paging) => this.collectionsService.findPageForAdmin(paging),
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a collection with its products in display order',
    description: 'ADMIN only. Includes inactive products.',
  })
  @ApiNotFoundResponse({ description: 'Collection not found.' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.collectionsService.findOneForAdmin(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a collection',
    description:
      'ADMIN only. The slug is generated from the name unless a valid slug is sent. Products are set with PUT /admin/collections/{id}/products.',
  })
  @ApiConflictResponse({ description: 'The slug is already used.' })
  create(@Body() dto: CreateCollectionDto) {
    return this.collectionsService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a collection',
    description: 'ADMIN only. Changing the name does not change the slug.',
  })
  @ApiNotFoundResponse({ description: 'Collection not found.' })
  @ApiConflictResponse({ description: 'The slug is already used.' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collectionsService.update(id, dto);
  }

  @Patch(':id/toggle')
  @ApiOperation({
    summary: 'Toggle the active status of a collection',
    description: 'ADMIN only.',
  })
  @ApiNotFoundResponse({ description: 'Collection not found.' })
  toggleActive(@Param('id', ParseIntPipe) id: number) {
    return this.collectionsService.toggleActive(id);
  }

  @Put(':id/products')
  @ApiOperation({
    summary: 'Replace the products of a collection',
    description:
      'ADMIN only. `productIds` is the new membership in display order and replaces the old one in a single transaction: either all of it is saved or none. Every id must exist, ids must not repeat, and at most 200 are allowed. Inactive products are accepted (they stay hidden from the public endpoints). Returns the saved ordered list.',
  })
  @ApiNotFoundResponse({ description: 'Collection not found.' })
  replaceProducts(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReplaceCollectionProductsDto,
  ) {
    return this.collectionsService.replaceProducts(id, dto.productIds);
  }
}
