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
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrdersService } from './orders.service';

@Controller('admin/orders')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin - Orders')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
@ApiForbiddenResponse({ description: 'ADMIN role required.' })
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiOkResponse({
    description:
      'All Orders, or one page when `page` or `limit` is sent (limit defaults to 20, at most 100). Totals are in the X-Total-Count, X-Total-Pages, X-Page and X-Limit headers.',
    headers: PAGINATION_HEADER_DOCS,
  })
  @ApiOperation({ summary: 'List all Orders', description: 'ADMIN only.' })
  findAll(
    @Query() query: ListPaginationQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return listWithPaging(
      response,
      query,
      LIST_PAGE_SIZE,
      () => this.ordersService.findAllForAdmin(),
      (paging) => this.ordersService.findPageForAdmin(paging),
    );
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Transition an Order status',
    description:
      'ADMIN only. Only configured lifecycle transitions are accepted. An Order is confirmed only by a successful payment, so CONFIRMED is rejected here, and PROCESSING, SHIPPED and DELIVERED require a succeeded payment.',
  })
  @ApiConflictResponse({
    description:
      'CONFIRMED requested by an admin, or the Order has no succeeded payment.',
  })
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateStatus(id, dto.status);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get any Order',
    description:
      'ADMIN only. The Order as in the list, plus `payments`: its Payment attempts, newest first, in the same safe view the customer gets (no idempotency key, provider payment id or raw provider data). `payments` is an empty array for an Order that was never paid for.',
  })
  @ApiNotFoundResponse({ description: 'Order not found.' })
  @ApiOkResponse({
    schema: {
      example: {
        id: 7,
        userId: 3,
        status: 'cancelled',
        totalPrice: 24990000,
        payments: [
          {
            id: 42,
            provider: 'momo',
            amount: 24990000,
            currency: 'VND',
            status: 'cancelled',
            createdAt: '2026-10-28T09:00:00.000Z',
            updatedAt: '2026-10-28T09:20:00.000Z',
            succeededAt: null,
          },
        ],
      },
    },
  })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.findOneForAdmin(id);
  }
}
