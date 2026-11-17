import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { REVENUE_ORDER_STATUSES } from './analytics.constants';
import {
  ordersByStatusStatement,
  overviewStatement,
  revenueByDayStatement,
  topProductsStatement,
} from './analytics.queries';
import { AnalyticsService, averageOrderValue } from './analytics.service';

const NOW = new Date('2026-11-17T09:30:00.000Z');

function serviceReturning(rows: unknown[]) {
  const query = jest.fn().mockResolvedValue(rows);
  return {
    query,
    service: new AnalyticsService({ query } as unknown as DataSource),
  };
}

describe('averageOrderValue', () => {
  it('is whole VND, rounded half up, with integer arithmetic only', () => {
    expect(averageOrderValue(0, 0)).toBe(0);
    expect(averageOrderValue(500_000, 0)).toBe(0);
    expect(averageOrderValue(5, 2)).toBe(3);
    expect(averageOrderValue(4, 3)).toBe(1);
    expect(averageOrderValue(5, 3)).toBe(2);
    expect(averageOrderValue(1_000_000, 4)).toBe(250_000);
    // Large enough that a floating point division could be off by one.
    expect(averageOrderValue(9_007_199_254_740_991, 3)).toBe(
      3_002_399_751_580_330,
    );
  });
});

describe('analytics statements', () => {
  const resolved = {
    from: '2026-10-19',
    to: '2026-11-17',
    days: 30,
    timezone: 'Asia/Ho_Chi_Minh',
  };

  it('bind the dates and the time zone as parameters, never inside the SQL text', () => {
    const hostile = { ...resolved, timezone: "UTC'; DROP TABLE orders; --" };
    const statements = [
      overviewStatement(hostile, {
        from: '2026-09-19',
        to: '2026-10-18',
        days: 30,
      }),
      revenueByDayStatement(hostile),
      ordersByStatusStatement(hostile),
      topProductsStatement(hostile, 10),
    ];

    for (const statement of statements) {
      expect(statement.sql).not.toContain('DROP TABLE');
      expect(statement.sql).not.toContain('2026-11');
      expect(statement.params).toContain("UTC'; DROP TABLE orders; --");
    }
  });

  it('count exactly the paid statuses as revenue', () => {
    expect([...REVENUE_ORDER_STATUSES]).toEqual([
      'confirmed',
      'processing',
      'shipped',
      'delivered',
    ]);
    for (const statement of [
      overviewStatement(resolved, {
        from: '2026-09-19',
        to: '2026-10-18',
        days: 30,
      }),
      revenueByDayStatement(resolved),
      topProductsStatement(resolved, 10),
    ]) {
      expect(statement.sql).toContain(
        `IN ('confirmed', 'processing', 'shipped', 'delivered')`,
      );
      expect(statement.sql).not.toContain("'pending'");
    }
  });

  it('read the end of the range as the day after its last day', () => {
    expect(revenueByDayStatement(resolved).params).toEqual([
      '2026-10-19',
      '2026-11-18',
      'Asia/Ho_Chi_Minh',
    ]);
  });
});

describe('AnalyticsService', () => {
  it('turns two overview rows into the current and the previous period', async () => {
    const { service, query } = serviceReturning([
      {
        period: 'previous',
        revenue: '1000000',
        orderCount: 2,
        placedOrders: 4,
        cancelledOrders: 1,
        newCustomers: 3,
      },
      {
        period: 'current',
        revenue: '2500000',
        orderCount: 3,
        placedOrders: 8,
        cancelledOrders: 2,
        newCustomers: 5,
      },
    ]);

    const result = await service.overview({}, NOW);

    expect(result.range).toEqual({
      from: '2026-10-19',
      to: '2026-11-17',
      days: 30,
      timezone: 'Asia/Ho_Chi_Minh',
    });
    expect(result.previousRange).toEqual({
      from: '2026-09-19',
      to: '2026-10-18',
      days: 30,
    });
    expect(result.current).toEqual({
      revenue: 2_500_000,
      orderCount: 3,
      averageOrderValue: 833_333,
      placedOrders: 8,
      cancelledOrders: 2,
      cancelledRate: 0.25,
      newCustomers: 5,
    });
    expect(result.previous).toEqual({
      revenue: 1_000_000,
      orderCount: 2,
      averageOrderValue: 500_000,
      placedOrders: 4,
      cancelledOrders: 1,
      cancelledRate: 0.25,
      newCustomers: 3,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('has zeros, not NaN, for a period without orders', async () => {
    const { service } = serviceReturning([
      {
        period: 'current',
        revenue: '0',
        orderCount: 0,
        placedOrders: 0,
        cancelledOrders: 0,
        newCustomers: 0,
      },
    ]);

    const { current, previous } = await service.overview({}, NOW);

    expect(current).toEqual({
      revenue: 0,
      orderCount: 0,
      averageOrderValue: 0,
      placedOrders: 0,
      cancelledOrders: 0,
      cancelledRate: 0,
      newCustomers: 0,
    });
    expect(previous.cancelledRate).toBe(0);
  });

  it('rounds the cancelled rate to four decimals', async () => {
    const { service } = serviceReturning([
      {
        period: 'current',
        revenue: '0',
        orderCount: 0,
        placedOrders: 3,
        cancelledOrders: 1,
        newCustomers: 0,
      },
    ]);

    expect((await service.overview({}, NOW)).current.cancelledRate).toBe(
      0.3333,
    );
  });

  it('validates the range before it touches the database', async () => {
    const { service, query } = serviceReturning([]);

    await expect(service.overview({ from: '2026-13-01' }, NOW)).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.revenueByDay({ timezone: 'Nowhere/Land' }, NOW),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.topProducts({ from: '2025-01-01', to: '2026-11-17' }, NOW),
    ).rejects.toThrow('at most 366 days');
    expect(query).not.toHaveBeenCalled();
  });

  it('answers 400 when the database does not know a time zone the runtime accepted', async () => {
    const query = jest
      .fn()
      .mockRejectedValue({ driverError: { code: '22023' } });
    const service = new AnalyticsService({ query } as unknown as DataSource);

    await expect(service.ordersByStatus({}, NOW)).rejects.toThrow(
      'timezone is not known to the database',
    );
  });

  it('passes other database errors on unchanged', async () => {
    const failure = new Error('connection lost');
    const service = new AnalyticsService({
      query: jest.fn().mockRejectedValue(failure),
    } as unknown as DataSource);

    await expect(service.revenueByDay({}, NOW)).rejects.toBe(failure);
  });

  it('uses 10 for the top list limit when none is given', async () => {
    const { service, query } = serviceReturning([
      { products: [], categories: [] },
    ]);

    const result = await service.topProducts({}, NOW);

    expect(result.limit).toBe(10);
    expect(query.mock.calls[0][1]).toContain(10);
    expect(result.products).toEqual([]);
  });
});
