import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  LIST_PAGE_SIZE,
  ListPaginationQueryDto,
  listWithPaging,
  PAGINATION_HEADER_DOCS,
} from '../pagination/pagination';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
@UseGuards(AuthGuard)
@ApiTags('Orders')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  @ApiBadRequestResponse({
    description: 'Invalid, inactive, or insufficient-stock ProductVariant.',
  })
  @ApiNotFoundResponse({ description: 'Owned Address not found.' })
  @ApiOperation({
    summary: 'Create an Order by direct checkout',
    description:
      'Validates and decrements current ProductVariant stock transactionally. The saved Address is copied into an immutable shipping snapshot.',
  })
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createOrderDto: CreateOrderDto,
  ) {
    return this.ordersService.checkout(user.id, createOrderDto);
  }

  @Get()
  @ApiOkResponse({
    description:
      'All of the useru{2019}s Orders, or one page when `page` or `limit` is sent (limit defaults to 20, at most 100). Totals are in the X-Total-Count, X-Total-Pages, X-Page and X-Limit headers.',
    headers: PAGINATION_HEADER_DOCS,
  })
  @ApiOperation({ summary: 'List the current useru{2019}s Orders' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPaginationQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return listWithPaging(
      response,
      query,
      LIST_PAGE_SIZE,
      () => this.ordersService.findAllForUser(user.id),
      (paging) => this.ordersService.findPageForUser(user.id, paging),
    );
  }

  @Post(':id/cancel')
  @ApiConflictResponse({
    description: 'A succeeded Payment prevents cancellation.',
  })
  @ApiNotFoundResponse({ description: 'Owned Order not found.' })
  @ApiOperation({
    summary: 'Cancel an owned Order',
    description:
      'A succeeded/paid Order cannot be cancelled because refund support is not implemented.',
  })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.ordersService.cancelForUser(user.id, id);
  }

  @Get(':id')
  @ApiNotFoundResponse({ description: 'Owned Order not found.' })
  @ApiOperation({ summary: 'Get an owned Order' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.ordersService.findOneForUser(user.id, id);
  }
}
