import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  LIST_PAGE_SIZE,
  ListPaginationQueryDto,
  listWithPaging,
  PAGINATION_HEADER_DOCS,
} from '../pagination/pagination';
import { CollectionsService } from './collections.service';

const publicCollectionSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer', example: 1 },
    slug: { type: 'string', example: 'everyday-essentials' },
    name: { type: 'string', example: 'Everyday Essentials' },
    description: {
      type: 'string',
      nullable: true,
      example: 'Simple pieces that go with everything.',
    },
    heroImageUrl: { type: 'string', nullable: true },
    isFeatured: { type: 'boolean', example: false },
    productCount: {
      type: 'integer',
      example: 7,
      description: 'Visible products only.',
    },
  },
};

@Controller('collections')
@ApiTags('Catalog - Collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List public collections',
    description:
      'Active collections that hold at least one visible product (an active product with an active variant), by sortOrder then id. Without page and limit the whole list is returned. Sending either one returns one page (limit defaults to 20, at most 100) with the totals in the X-Total-Count, X-Total-Pages, X-Page and X-Limit headers. The products of a collection are listed by GET /products?collection=<slug>.',
  })
  @ApiOkResponse({
    schema: { type: 'array', items: publicCollectionSchema },
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
      () => this.collectionsService.findAllPublic(),
      (paging) => this.collectionsService.findPagePublic(paging),
    );
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Get a public collection by slug',
    description:
      'Returns 404 when the slug is unknown, the collection is inactive, or it holds no visible product.',
  })
  @ApiOkResponse({ schema: publicCollectionSchema })
  @ApiNotFoundResponse({ description: 'Collection not found.' })
  findOne(@Param('slug') slug: string) {
    return this.collectionsService.findBySlugPublic(slug);
  }
}
