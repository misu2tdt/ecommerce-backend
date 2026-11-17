import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/entities/user-role.enum';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsRangeQueryDto,
  TopProductsQueryDto,
} from './dto/analytics-range-query.dto';

const RANGE_EXAMPLE = {
  from: '2026-10-19',
  to: '2026-11-17',
  days: 30,
  timezone: 'Asia/Ho_Chi_Minh',
};

const FIGURES_EXAMPLE = {
  revenue: 184250000,
  orderCount: 112,
  averageOrderValue: 1645089,
  placedOrders: 124,
  cancelledOrders: 9,
  cancelledRate: 0.0726,
  newCustomers: 14,
};

const BAD_RANGE =
  'Invalid `from`, `to` or `timezone`: not a real calendar date, `from` after `to`, a range longer than 366 days, or a time zone that is not an IANA name.';

@Controller('admin/analytics')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin - Analytics')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
@ApiForbiddenResponse({ description: 'ADMIN role required.' })
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Revenue, orders, cancellations and new customers for a period',
    description:
      'ADMIN only. Revenue is the sum of the totals of paid orders (statuses confirmed, processing, shipped and delivered; pending and cancelled orders are excluded), in whole VND and after coupon discounts, by the day the order was created. `orderCount` is those paid orders and `averageOrderValue` is revenue divided by it, rounded half up. `cancelledRate` is cancelled orders over all orders placed in the period. `newCustomers` counts accounts with the USER role created in the period. The same figures are returned for the previous period of equal length that ends the day before `from`. Days are calendar days in `timezone`.',
  })
  @ApiBadRequestResponse({ description: BAD_RANGE })
  @ApiOkResponse({
    schema: {
      example: {
        currency: 'VND',
        revenueStatuses: ['confirmed', 'processing', 'shipped', 'delivered'],
        range: RANGE_EXAMPLE,
        previousRange: { from: '2026-09-19', to: '2026-10-18', days: 30 },
        current: FIGURES_EXAMPLE,
        previous: { ...FIGURES_EXAMPLE, revenue: 151900000, orderCount: 98 },
      },
    },
  })
  overview(@Query() query: AnalyticsRangeQueryDto) {
    return this.analyticsService.overview(query);
  }

  @Get('revenue-by-day')
  @ApiOperation({
    summary: 'Revenue and paid orders for every day of a period',
    description:
      'ADMIN only. One row per calendar day in `timezone` (default Asia/Ho_Chi_Minh), oldest first, including days with no orders (revenue 0, orders 0). A day is bucketed by the moment the order was created, in the requested time zone. Same revenue definition as the overview.',
  })
  @ApiBadRequestResponse({ description: BAD_RANGE })
  @ApiOkResponse({
    schema: {
      example: {
        currency: 'VND',
        revenueStatuses: ['confirmed', 'processing', 'shipped', 'delivered'],
        range: RANGE_EXAMPLE,
        days: [
          { date: '2026-10-19', revenue: 5320000, orders: 4 },
          { date: '2026-10-20', revenue: 0, orders: 0 },
        ],
      },
    },
  })
  revenueByDay(@Query() query: AnalyticsRangeQueryDto) {
    return this.analyticsService.revenueByDay(query);
  }

  @Get('orders-by-status')
  @ApiOperation({
    summary: 'How many orders are in each status',
    description:
      'ADMIN only. Every status is listed, in lifecycle order, with the number of orders created in the period and the sum of their totals (`totalValue`, whole VND). `totalValue` is only revenue for the paid statuses.',
  })
  @ApiBadRequestResponse({ description: BAD_RANGE })
  @ApiOkResponse({
    schema: {
      example: {
        currency: 'VND',
        range: RANGE_EXAMPLE,
        totalOrders: 124,
        statuses: [
          { status: 'pending', orderCount: 2, totalValue: 3100000 },
          { status: 'confirmed', orderCount: 3, totalValue: 4900000 },
          { status: 'processing', orderCount: 4, totalValue: 6200000 },
          { status: 'shipped', orderCount: 9, totalValue: 14800000 },
          { status: 'delivered', orderCount: 97, totalValue: 160000000 },
          { status: 'cancelled', orderCount: 9, totalValue: 13400000 },
        ],
      },
    },
  })
  ordersByStatus(@Query() query: AnalyticsRangeQueryDto) {
    return this.analyticsService.ordersByStatus(query);
  }

  @Get('top-products')
  @ApiOperation({
    summary: 'Best-selling products and categories',
    description:
      'ADMIN only. Units sold and revenue per product and per category, from the order lines of paid orders created in the period. Revenue here is price x quantity of the lines, before any order-level coupon discount, so the sum can be higher than the overview revenue. Ranked by revenue, then units, then id. `limit` (default 10, at most 50) applies to both lists. `orders` is the number of paid orders that contain the product or category.',
  })
  @ApiBadRequestResponse({
    description: `${BAD_RANGE} Or \`limit\` is not a whole number from 1 to 50.`,
  })
  @ApiOkResponse({
    schema: {
      example: {
        currency: 'VND',
        revenueStatuses: ['confirmed', 'processing', 'shipped', 'delivered'],
        range: RANGE_EXAMPLE,
        limit: 10,
        products: [
          {
            id: 12,
            name: 'Classic Crewneck Cotton Tee',
            slug: 'classic-crewneck-cotton-tee',
            units: 41,
            revenue: 12300000,
            orders: 33,
          },
        ],
        categories: [
          {
            id: 1,
            name: 'T-Shirts',
            slug: 't-shirts',
            units: 120,
            revenue: 36000000,
            orders: 80,
          },
        ],
      },
    },
  })
  topProducts(@Query() query: TopProductsQueryDto) {
    return this.analyticsService.topProducts(query);
  }
}
