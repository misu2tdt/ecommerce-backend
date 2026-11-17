import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseVndAmount } from '../money/vnd-money';
import {
  ANALYTICS_CURRENCY,
  REVENUE_ORDER_STATUSES,
  TOP_LIMIT_DEFAULT,
} from './analytics.constants';
import {
  resolveAnalyticsRange,
  type AnalyticsRange,
  type AnalyticsRangeInput,
  type DateSpan,
} from './analytics-range';
import {
  ordersByStatusStatement,
  overviewStatement,
  revenueByDayStatement,
  topProductsStatement,
  type Statement,
} from './analytics.queries';

export interface PeriodFigures {
  // Sum of the totals of paid orders (confirmed, processing, shipped, delivered),
  // in whole VND, after coupon discounts.
  revenue: number;
  // How many paid orders made that revenue.
  orderCount: number;
  // revenue / orderCount rounded half up to a whole VND; 0 with no orders.
  averageOrderValue: number;
  // Every order created in the period, whatever its status.
  placedOrders: number;
  cancelledOrders: number;
  // cancelledOrders / placedOrders, 0 to 1 with 4 decimals; 0 with no orders.
  cancelledRate: number;
  // Accounts with the USER role created in the period.
  newCustomers: number;
}

export interface TopEntry {
  id: number;
  name: string;
  slug: string;
  units: number;
  revenue: number;
  orders: number;
}

interface OverviewRow {
  period: 'current' | 'previous';
  revenue: string;
  orderCount: number;
  placedOrders: number;
  cancelledOrders: number;
  newCustomers: number;
}

interface TopRow {
  products: TopEntry[];
  categories: TopEntry[];
}

// Postgres: invalid_parameter_value, which a time zone the database does not
// know raises even though the JavaScript runtime accepted its name.
const INVALID_PARAMETER_VALUE = '22023';

@Injectable()
export class AnalyticsService {
  constructor(private readonly dataSource: DataSource) {}

  async overview(input: AnalyticsRangeInput, now: Date = new Date()) {
    const { range, previous } = resolveAnalyticsRange(input, now);
    const rows = await this.run<OverviewRow>(
      overviewStatement(range, previous),
    );
    const byPeriod = new Map(rows.map((row) => [row.period, row]));
    return {
      currency: ANALYTICS_CURRENCY,
      revenueStatuses: [...REVENUE_ORDER_STATUSES],
      range: rangeView(range),
      previousRange: { ...previous },
      current: figures(byPeriod.get('current')),
      previous: figures(byPeriod.get('previous')),
    };
  }

  async revenueByDay(input: AnalyticsRangeInput, now: Date = new Date()) {
    const { range } = resolveAnalyticsRange(input, now);
    const rows = await this.run<{
      date: string;
      revenue: string;
      orders: number;
    }>(revenueByDayStatement(range));
    return {
      currency: ANALYTICS_CURRENCY,
      revenueStatuses: [...REVENUE_ORDER_STATUSES],
      range: rangeView(range),
      days: rows.map((row) => ({
        date: row.date,
        revenue: parseVndAmount(row.revenue),
        orders: row.orders,
      })),
    };
  }

  async ordersByStatus(input: AnalyticsRangeInput, now: Date = new Date()) {
    const { range } = resolveAnalyticsRange(input, now);
    const rows = await this.run<{
      status: string;
      orderCount: number;
      totalValue: string;
    }>(ordersByStatusStatement(range));
    const statuses = rows.map((row) => ({
      status: row.status,
      orderCount: row.orderCount,
      totalValue: parseVndAmount(row.totalValue),
    }));
    return {
      currency: ANALYTICS_CURRENCY,
      range: rangeView(range),
      totalOrders: statuses.reduce((sum, row) => sum + row.orderCount, 0),
      statuses,
    };
  }

  async topProducts(
    input: AnalyticsRangeInput & { limit?: number },
    now: Date = new Date(),
  ) {
    const { range } = resolveAnalyticsRange(input, now);
    const limit = input.limit ?? TOP_LIMIT_DEFAULT;
    const [row] = await this.run<TopRow>(topProductsStatement(range, limit));
    return {
      currency: ANALYTICS_CURRENCY,
      revenueStatuses: [...REVENUE_ORDER_STATUSES],
      range: rangeView(range),
      limit,
      products: row.products.map(money),
      categories: row.categories.map(money),
    };
  }

  private async run<Row>(statement: Statement): Promise<Row[]> {
    try {
      return await this.dataSource.query<Row[]>(
        statement.sql,
        statement.params,
      );
    } catch (error) {
      const code = (error as { driverError?: { code?: string } }).driverError
        ?.code;
      if (code === INVALID_PARAMETER_VALUE) {
        throw new BadRequestException(
          'timezone is not known to the database; use an IANA name such as Asia/Ho_Chi_Minh',
        );
      }
      throw error;
    }
  }
}

function rangeView(range: AnalyticsRange) {
  return {
    from: range.from,
    to: range.to,
    days: range.days,
    timezone: range.timezone,
  };
}

function figures(row: OverviewRow | undefined): PeriodFigures {
  const revenue = parseVndAmount(row?.revenue ?? '0');
  const orderCount = row?.orderCount ?? 0;
  const placedOrders = row?.placedOrders ?? 0;
  const cancelledOrders = row?.cancelledOrders ?? 0;
  return {
    revenue,
    orderCount,
    averageOrderValue: averageOrderValue(revenue, orderCount),
    placedOrders,
    cancelledOrders,
    cancelledRate:
      placedOrders === 0
        ? 0
        : Math.round((cancelledOrders / placedOrders) * 10_000) / 10_000,
    newCustomers: row?.newCustomers ?? 0,
  };
}

// Whole VND, rounded half up, with integer arithmetic only.
export function averageOrderValue(revenue: number, orders: number): number {
  if (orders === 0) return 0;
  const count = BigInt(orders);
  return Number((BigInt(revenue) + count / 2n) / count);
}

function money(entry: TopEntry): TopEntry {
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    units: parseVndAmount(entry.units),
    revenue: parseVndAmount(entry.revenue),
    orders: entry.orders,
  };
}

export type { DateSpan };
