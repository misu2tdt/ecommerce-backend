import { Agent } from 'node:http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { AppModule } from '../../src/app.module';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { createCategory, createVariant } from './catalog-fixtures';
import {
  cleanTestDatabase,
  createTestDataSource,
  initializeTestDatabase,
} from './test-database';

// Every date below is a UTC instant. Vietnam is UTC+7 all year, so local midnight
// is 17:00 UTC of the day before. The fixtures sit exactly on those edges.
const BASE = '/admin/analytics';

interface Range {
  from: string;
  to: string;
  days: number;
  timezone: string;
}
interface Figures {
  revenue: number;
  orderCount: number;
  averageOrderValue: number;
  placedOrders: number;
  cancelledOrders: number;
  cancelledRate: number;
  newCustomers: number;
}
interface OverviewBody {
  currency: string;
  revenueStatuses: string[];
  range: Range;
  previousRange: { from: string; to: string; days: number };
  current: Figures;
  previous: Figures;
}
interface DayBody {
  range: Range;
  days: Array<{ date: string; revenue: number; orders: number }>;
}
interface StatusBody {
  range: Range;
  totalOrders: number;
  statuses: Array<{ status: string; orderCount: number; totalValue: number }>;
}
interface Entry {
  id: number;
  name: string;
  slug: string;
  units: number;
  revenue: number;
  orders: number;
}
interface TopBody {
  range: Range;
  limit: number;
  products: Entry[];
  categories: Entry[];
}

// What the hand-built data below must produce for 2026-11-10 to 2026-11-12 in
// Asia/Ho_Chi_Minh. Worked out by hand in docs/analytics.md.
const CURRENT: Figures = {
  revenue: 1_550_000,
  orderCount: 5,
  averageOrderValue: 310_000,
  placedOrders: 7,
  cancelledOrders: 1,
  cancelledRate: 0.1429,
  newCustomers: 2,
};
const PREVIOUS: Figures = {
  revenue: 250_000,
  orderCount: 3,
  averageOrderValue: 83_333,
  placedOrders: 4,
  cancelledOrders: 1,
  cancelledRate: 0.25,
  newCustomers: 2,
};

describe('admin analytics API (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let customerToken: string;

  // One listening server and one reused connection for the whole file: this spec
  // sends a few hundred requests, and a new socket for each would crowd the ports
  // of the machine while the other suites run in parallel.
  const connection = new Agent({ keepAlive: true, maxSockets: 2 });
  const get = (path: string) =>
    request(app.getHttpServer()).get(path).agent(connection);
  const send = (path: string, token: string = adminToken) =>
    get(path).set('Authorization', `Bearer ${token}`);
  const body = async <T>(path: string): Promise<T> =>
    (await send(path).expect(200)).body as T;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    connection.destroy();
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  async function tokens() {
    const jwt = app.get(JwtService);
    const admin = await insertUser(
      dataSource,
      'token-admin',
      UserRole.ADMIN,
      '2026-10-01T00:00:00Z',
    );
    const customer = await insertUser(
      dataSource,
      'token-customer',
      UserRole.USER,
      '2026-10-01T00:00:00Z',
    );
    adminToken = await jwt.signAsync({
      sub: admin,
      email: 'token-admin@example.com',
      role: UserRole.ADMIN,
    });
    customerToken = await jwt.signAsync({
      sub: customer,
      email: 'token-customer@example.com',
      role: UserRole.USER,
    });
  }

  describe('hand-built orders on the edges of each day', () => {
    beforeAll(async () => {
      await cleanTestDatabase(dataSource);
      await tokens();
      await buildFixture(dataSource);
    });

    describe('GET /admin/analytics/overview', () => {
      it('gives exact figures for the period and for the previous one', async () => {
        const result = await body<OverviewBody>(
          `${BASE}/overview?from=2026-11-10&to=2026-11-12`,
        );

        expect(result.currency).toBe('VND');
        expect(result.revenueStatuses).toEqual([
          'confirmed',
          'processing',
          'shipped',
          'delivered',
        ]);
        expect(result.range).toEqual({
          from: '2026-11-10',
          to: '2026-11-12',
          days: 3,
          timezone: 'Asia/Ho_Chi_Minh',
        });
        expect(result.previousRange).toEqual({
          from: '2026-11-07',
          to: '2026-11-09',
          days: 3,
        });
        expect(result.current).toEqual(CURRENT);
        expect(result.previous).toEqual(PREVIOUS);
      });

      it('counts an order at 23:59:59 and one at 00:00:00 local on different days', async () => {
        // O1 is the last second of 9 November (previous period) and O2 the first
        // second of 10 November (this period).
        const first = await body<OverviewBody>(
          `${BASE}/overview?from=2026-11-10&to=2026-11-10`,
        );
        const before = await body<OverviewBody>(
          `${BASE}/overview?from=2026-11-09&to=2026-11-09`,
        );

        expect(before.current.revenue).toBe(100_000);
        expect(before.current.orderCount).toBe(1);
        // The first day holds O2 300,000 + O3 350,000 + O4 500,000.
        expect(first.current.revenue).toBe(1_150_000);
        expect(first.current.orderCount).toBe(3);
      });

      it('leaves out pending and cancelled orders from revenue but counts them as placed', async () => {
        const result = await body<OverviewBody>(
          `${BASE}/overview?from=2026-11-10&to=2026-11-12`,
        );

        // 7 placed: 5 paid, 1 cancelled (400,000 never counted) and 1 pending (100,000).
        expect(result.current.placedOrders).toBe(7);
        expect(
          result.current.orderCount + result.current.cancelledOrders + 1,
        ).toBe(7);
        expect(result.current.revenue).toBe(1_550_000);
      });

      it('counts only USER accounts as new customers, by their local creation day', async () => {
        const result = await body<OverviewBody>(
          `${BASE}/overview?from=2026-11-10&to=2026-11-12`,
        );

        // Counted: A (00:00:00 local on the 10th) and B (23:59:59 on the 12th).
        // Not counted: C (00:00:00 on the 13th) and a second ADMIN created in range.
        expect(result.current.newCustomers).toBe(2);
        // Previous: D, and F (the first second of the 7th); E (the last second
        // of the 6th) is outside.
        expect(result.previous.newCustomers).toBe(2);
      });

      it('defaults to the last 30 days ending today, with a previous period of 30 days', async () => {
        const result = await body<OverviewBody>(`${BASE}/overview`);
        const today = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Ho_Chi_Minh',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date());

        // Which fixtures fall inside depends on the real date, so only the shape
        // of the range is asserted here; the exact arithmetic is in the unit tests.
        expect(result.range.to).toBe(today);
        expect(result.range.days).toBe(30);
        expect(result.previousRange.days).toBe(30);
        expect(result.range.timezone).toBe('Asia/Ho_Chi_Minh');
        const start = Date.parse(`${result.range.from}T00:00:00Z`);
        const end = Date.parse(`${result.range.to}T00:00:00Z`);
        expect((end - start) / 86_400_000).toBe(29);
        expect(
          Date.parse(`${result.previousRange.to}T00:00:00Z`) + 86_400_000,
        ).toBe(start);
      });

      it('returns whole VND as integers in every money field', async () => {
        const result = await body<OverviewBody>(
          `${BASE}/overview?from=2026-11-10&to=2026-11-12`,
        );

        for (const figures of [result.current, result.previous]) {
          for (const value of [figures.revenue, figures.averageOrderValue]) {
            expect(Number.isSafeInteger(value)).toBe(true);
          }
        }
      });

      it('runs as one aggregation in the database', async () => {
        const spy = jest.spyOn(app.get(DataSource), 'query');
        try {
          await send(`${BASE}/overview?from=2026-11-10&to=2026-11-12`).expect(
            200,
          );
          await send(
            `${BASE}/revenue-by-day?from=2026-11-10&to=2026-11-12`,
          ).expect(200);
          await send(
            `${BASE}/orders-by-status?from=2026-11-10&to=2026-11-12`,
          ).expect(200);
          await send(
            `${BASE}/top-products?from=2026-11-10&to=2026-11-12`,
          ).expect(200);

          expect(spy).toHaveBeenCalledTimes(4);
        } finally {
          spy.mockRestore();
        }
      });
    });

    describe('GET /admin/analytics/revenue-by-day', () => {
      it('has exact revenue and order counts for each day of the range', async () => {
        const result = await body<DayBody>(
          `${BASE}/revenue-by-day?from=2026-11-10&to=2026-11-12`,
        );

        expect(result.days).toEqual([
          { date: '2026-11-10', revenue: 1_150_000, orders: 3 },
          { date: '2026-11-11', revenue: 100_000, orders: 1 },
          { date: '2026-11-12', revenue: 300_000, orders: 1 },
        ]);
      });

      it('has a row for every day, including days with no orders', async () => {
        const result = await body<DayBody>(
          `${BASE}/revenue-by-day?from=2026-11-08&to=2026-11-14`,
        );

        expect(result.days).toEqual([
          { date: '2026-11-08', revenue: 50_000, orders: 1 },
          { date: '2026-11-09', revenue: 100_000, orders: 1 },
          { date: '2026-11-10', revenue: 1_150_000, orders: 3 },
          { date: '2026-11-11', revenue: 100_000, orders: 1 },
          { date: '2026-11-12', revenue: 300_000, orders: 1 },
          // 00:00:00 local on the 13th: the first second of that day.
          { date: '2026-11-13', revenue: 800_000, orders: 1 },
          { date: '2026-11-14', revenue: 0, orders: 0 },
        ]);
        expect(result.range.days).toBe(7);
      });

      it('sums to the overview revenue', async () => {
        const days = await body<DayBody>(
          `${BASE}/revenue-by-day?from=2026-11-10&to=2026-11-12`,
        );
        const overview = await body<OverviewBody>(
          `${BASE}/overview?from=2026-11-10&to=2026-11-12`,
        );

        expect(days.days.reduce((sum, day) => sum + day.revenue, 0)).toBe(
          overview.current.revenue,
        );
        expect(days.days.reduce((sum, day) => sum + day.orders, 0)).toBe(
          overview.current.orderCount,
        );
      });

      it('moves the day edges with the requested time zone', async () => {
        const utc = await body<DayBody>(
          `${BASE}/revenue-by-day?from=2026-11-09&to=2026-11-10&timezone=UTC`,
        );
        const losAngeles = await body<DayBody>(
          `${BASE}/revenue-by-day?from=2026-11-09&to=2026-11-10&timezone=America/Los_Angeles`,
        );
        const vietnam = await body<DayBody>(
          `${BASE}/revenue-by-day?from=2026-11-09&to=2026-11-10`,
        );

        // UTC: O1 (16:59:59Z) and O2 (17:00:00Z) are both on the 9th.
        expect(utc.days).toEqual([
          { date: '2026-11-09', revenue: 400_000, orders: 2 },
          { date: '2026-11-10', revenue: 950_000, orders: 3 },
        ]);
        // Los Angeles is UTC-8 in November: the 9th ends at 08:00Z on the 10th.
        expect(losAngeles.days).toEqual([
          { date: '2026-11-09', revenue: 400_000, orders: 2 },
          { date: '2026-11-10', revenue: 950_000, orders: 3 },
        ]);
        // Vietnam: O1 is on the 9th, O2 on the 10th.
        expect(vietnam.days).toEqual([
          { date: '2026-11-09', revenue: 100_000, orders: 1 },
          { date: '2026-11-10', revenue: 1_150_000, orders: 3 },
        ]);
        expect(utc.range.timezone).toBe('UTC');
        expect(losAngeles.range.timezone).toBe('America/Los_Angeles');
      });
    });

    describe('GET /admin/analytics/orders-by-status', () => {
      it('lists every status in lifecycle order with exact counts and totals', async () => {
        const result = await body<StatusBody>(
          `${BASE}/orders-by-status?from=2026-11-10&to=2026-11-12`,
        );

        expect(result.statuses).toEqual([
          { status: 'pending', orderCount: 1, totalValue: 100_000 },
          { status: 'confirmed', orderCount: 1, totalValue: 500_000 },
          { status: 'processing', orderCount: 1, totalValue: 100_000 },
          { status: 'shipped', orderCount: 1, totalValue: 350_000 },
          { status: 'delivered', orderCount: 2, totalValue: 600_000 },
          { status: 'cancelled', orderCount: 1, totalValue: 400_000 },
        ]);
        expect(result.totalOrders).toBe(7);
      });

      it('agrees with the overview on placed orders', async () => {
        const status = await body<StatusBody>(
          `${BASE}/orders-by-status?from=2026-11-10&to=2026-11-12`,
        );
        const overview = await body<OverviewBody>(
          `${BASE}/overview?from=2026-11-10&to=2026-11-12`,
        );

        expect(status.totalOrders).toBe(overview.current.placedOrders);
        expect(
          status.statuses.find((row) => row.status === 'cancelled')?.orderCount,
        ).toBe(overview.current.cancelledOrders);
      });
    });

    describe('GET /admin/analytics/top-products', () => {
      it('ranks products and categories with exact units and revenue', async () => {
        const result = await body<TopBody>(
          `${BASE}/top-products?from=2026-11-10&to=2026-11-12`,
        );

        // Lines of the five paid orders, price x quantity, before coupon discounts:
        // P1 = 1x100,000 + 2x250,000 + 3x100,000; P2 = 4x50,000 + 2x50,000;
        // P3 = 1x400,000 (the 50,000 coupon is not taken off).
        expect(result.products).toEqual([
          {
            id: expect.any(Number),
            name: 'P1 Tee',
            slug: 'p1-tee',
            units: 6,
            revenue: 900_000,
            orders: 3,
          },
          {
            id: expect.any(Number),
            name: 'P3 Jacket',
            slug: 'p3-jacket',
            units: 1,
            revenue: 400_000,
            orders: 1,
          },
          {
            id: expect.any(Number),
            name: 'P2 Socks',
            slug: 'p2-socks',
            units: 6,
            revenue: 300_000,
            orders: 2,
          },
        ]);
        expect(result.categories).toEqual([
          {
            id: expect.any(Number),
            name: 'Category tops',
            slug: 'category-tops',
            units: 12,
            revenue: 1_200_000,
            orders: 4,
          },
          {
            id: expect.any(Number),
            name: 'Category outerwear',
            slug: 'category-outerwear',
            units: 1,
            revenue: 400_000,
            orders: 1,
          },
        ]);
        expect(result.limit).toBe(10);
      });

      it('does not count cancelled or pending orders', async () => {
        const result = await body<TopBody>(
          `${BASE}/top-products?from=2026-11-10&to=2026-11-12`,
        );

        // The cancelled order held 1 unit of P3 and the pending one 1 unit of P1.
        expect(
          result.products.find((row) => row.slug === 'p3-jacket')?.units,
        ).toBe(1);
        expect(
          result.products.find((row) => row.slug === 'p1-tee')?.units,
        ).toBe(6);
      });

      it('applies limit to both lists, with default 10 and maximum 50', async () => {
        const one = await body<TopBody>(
          `${BASE}/top-products?from=2026-11-10&to=2026-11-12&limit=1`,
        );
        const many = await body<TopBody>(
          `${BASE}/top-products?from=2026-11-10&to=2026-11-12&limit=50`,
        );

        expect(one.limit).toBe(1);
        expect(one.products.map((row) => row.slug)).toEqual(['p1-tee']);
        expect(one.categories.map((row) => row.slug)).toEqual([
          'category-tops',
        ]);
        expect(many.limit).toBe(50);
        expect(many.products).toHaveLength(3);
      });
    });

    describe('empty ranges', () => {
      const EMPTY = 'from=2025-01-01&to=2025-01-03';

      it('answers zeros, not errors, for a range with no orders', async () => {
        const overview = await body<OverviewBody>(`${BASE}/overview?${EMPTY}`);
        const days = await body<DayBody>(`${BASE}/revenue-by-day?${EMPTY}`);
        const status = await body<StatusBody>(
          `${BASE}/orders-by-status?${EMPTY}`,
        );
        const top = await body<TopBody>(`${BASE}/top-products?${EMPTY}`);

        const zero: Figures = {
          revenue: 0,
          orderCount: 0,
          averageOrderValue: 0,
          placedOrders: 0,
          cancelledOrders: 0,
          cancelledRate: 0,
          newCustomers: 0,
        };
        expect(overview.current).toEqual(zero);
        expect(overview.previous).toEqual(zero);
        expect(days.days).toEqual([
          { date: '2025-01-01', revenue: 0, orders: 0 },
          { date: '2025-01-02', revenue: 0, orders: 0 },
          { date: '2025-01-03', revenue: 0, orders: 0 },
        ]);
        expect(status.totalOrders).toBe(0);
        expect(status.statuses.map((row) => row.status)).toEqual([
          'pending',
          'confirmed',
          'processing',
          'shipped',
          'delivered',
          'cancelled',
        ]);
        expect(
          status.statuses.every(
            (row) => row.orderCount === 0 && row.totalValue === 0,
          ),
        ).toBe(true);
        expect(top.products).toEqual([]);
        expect(top.categories).toEqual([]);
      });

      it('answers a one-day range and the longest range', async () => {
        const oneDay = await body<DayBody>(
          `${BASE}/revenue-by-day?from=2026-11-11&to=2026-11-11`,
        );
        const longest = await body<DayBody>(
          `${BASE}/revenue-by-day?from=2026-01-01&to=2027-01-01`,
        );

        expect(oneDay.days).toEqual([
          { date: '2026-11-11', revenue: 100_000, orders: 1 },
        ]);
        expect(longest.days).toHaveLength(366);
        expect(longest.days.reduce((sum, day) => sum + day.revenue, 0)).toBe(
          1_550_000 + 250_000 + 800_000 + 400_000,
        );
      });
    });

    describe('access control', () => {
      const endpoints = [
        'overview',
        'revenue-by-day',
        'orders-by-status',
        'top-products',
      ];

      it.each(endpoints)(
        'answers 401 on %s without a token or with a bad one',
        async (name) => {
          await get(`${BASE}/${name}`).expect(401);
          await get(`${BASE}/${name}`)
            .set('Authorization', 'Bearer not-a-token')
            .expect(401);
        },
      );

      it.each(endpoints)('answers 403 on %s for a customer', async (name) => {
        await send(`${BASE}/${name}`, customerToken).expect(403);
      });

      it.each(endpoints)('answers 200 on %s for an admin', async (name) => {
        await send(`${BASE}/${name}`).expect(200);
      });
    });

    describe('invalid parameters', () => {
      const endpoints = [
        'overview',
        'revenue-by-day',
        'orders-by-status',
        'top-products',
      ];
      const bad = [
        'from=2026-02-30',
        'from=2026-13-01&to=2026-12-01',
        'from=20261110',
        'from=2026-11-10T00:00:00Z',
        'to=yesterday',
        'from=2026-11-12&to=2026-11-10',
        'from=2025-01-01&to=2026-11-17',
        'from=2026-01-01&to=2027-01-02',
        'timezone=Mars/Olympus',
        'timezone=%2B07:00',
        'timezone=',
        'unknown=1',
        'from=2026-11-10&from=2026-11-11',
      ];

      it.each(endpoints)(
        'answers 400 on %s for each invalid range or time zone',
        async (name) => {
          for (const query of bad) {
            const response = await send(`${BASE}/${name}?${query}`);
            expect({ query, status: response.status }).toEqual({
              query,
              status: 400,
            });
          }
        },
      );

      it('answers 400 for an invalid limit and names the problem', async () => {
        for (const limit of ['0', '51', '-1', '1.5', 'abc', '']) {
          await send(`${BASE}/top-products?limit=${limit}`).expect(400);
        }
        const response = await send(`${BASE}/top-products?limit=51`).expect(
          400,
        );
        expect(JSON.stringify(response.body)).toContain(
          'limit must not be greater than 50',
        );
      });

      it('names the problem for a range longer than 366 days', async () => {
        const response = await send(
          `${BASE}/overview?from=2026-01-01&to=2027-01-02`,
        ).expect(400);

        expect(JSON.stringify(response.body)).toContain('at most 366 days');
      });

      it('does not accept limit on the endpoints that have none', async () => {
        await send(`${BASE}/overview?limit=5`).expect(400);
      });
    });
  });

  describe('daylight saving: a 25-hour day', () => {
    beforeAll(async () => {
      await cleanTestDatabase(dataSource);
      await tokens();
      const category = await createCategory(dataSource, 'dst');
      const product = await saveProduct(
        dataSource,
        'DST Tee',
        'dst-tee',
        category.id,
      );
      const variant = await createVariant(dataSource, product, 'dst', {
        price: 100_000,
        stock: 50,
      });
      const buyer = await insertUser(
        dataSource,
        'dst-buyer',
        UserRole.USER,
        '2026-01-01T00:00:00Z',
      );
      // The US ended daylight saving on 1 November 2026: 01:00 to 02:00 happened
      // twice, so that day in Los Angeles is 25 hours long (07:00Z to 08:00Z next day).
      for (const at of [
        '2026-11-01T06:59:59Z', // 31 October 23:59:59 PDT
        '2026-11-01T07:00:00Z', // 1 November 00:00:00 PDT
        '2026-11-01T08:30:00Z', // 01:30 PDT
        '2026-11-01T09:30:00Z', // 01:30 PST, the repeated hour
        '2026-11-02T07:59:59Z', // 1 November 23:59:59 PST
        '2026-11-02T08:00:00Z', // 2 November 00:00:00 PST
      ]) {
        await insertOrder(dataSource, {
          userId: buyer,
          at,
          status: 'delivered',
          lines: [[variant, 1]],
        });
      }
    });

    it('puts the 25 hours of 1 November in Los Angeles in one day', async () => {
      const result = await body<DayBody>(
        `${BASE}/revenue-by-day?from=2026-10-31&to=2026-11-02&timezone=America/Los_Angeles`,
      );

      expect(result.days).toEqual([
        { date: '2026-10-31', revenue: 100_000, orders: 1 },
        { date: '2026-11-01', revenue: 400_000, orders: 4 },
        { date: '2026-11-02', revenue: 100_000, orders: 1 },
      ]);
    });

    it('buckets the same orders differently in UTC', async () => {
      const result = await body<DayBody>(
        `${BASE}/revenue-by-day?from=2026-11-01&to=2026-11-02&timezone=UTC`,
      );

      expect(result.days).toEqual([
        { date: '2026-11-01', revenue: 400_000, orders: 4 },
        { date: '2026-11-02', revenue: 200_000, orders: 2 },
      ]);
    });
  });

  describe('ranking ties', () => {
    beforeAll(async () => {
      await cleanTestDatabase(dataSource);
      await tokens();
      const category = await createCategory(dataSource, 'ties');
      const buyer = await insertUser(
        dataSource,
        'ties-buyer',
        UserRole.USER,
        '2026-01-01T00:00:00Z',
      );
      // Three products with the same revenue; two of them with the same units.
      const alpha = await createVariant(
        dataSource,
        await saveProduct(dataSource, 'Alpha', 'alpha', category.id),
        'alpha',
        { price: 100_000, stock: 50 },
      );
      const beta = await createVariant(
        dataSource,
        await saveProduct(dataSource, 'Beta', 'beta', category.id),
        'beta',
        { price: 100_000, stock: 50 },
      );
      const gamma = await createVariant(
        dataSource,
        await saveProduct(dataSource, 'Gamma', 'gamma', category.id),
        'gamma',
        { price: 50_000, stock: 50 },
      );
      await insertOrder(dataSource, {
        userId: buyer,
        at: '2026-11-10T03:00:00Z',
        status: 'delivered',
        lines: [
          [alpha, 1],
          [beta, 1],
          [gamma, 2],
        ],
      });
    });

    it('breaks ties by revenue, then units, then id, so the order is stable', async () => {
      const first = await body<TopBody>(
        `${BASE}/top-products?from=2026-11-10&to=2026-11-10`,
      );
      const second = await body<TopBody>(
        `${BASE}/top-products?from=2026-11-10&to=2026-11-10`,
      );

      // All three made 100,000. Gamma sold 2 units, so it ranks first; Alpha and
      // Beta tie on everything and Alpha (the lower id) comes first.
      expect(first.products.map((row) => row.slug)).toEqual([
        'gamma',
        'alpha',
        'beta',
      ]);
      expect(second.products).toEqual(first.products);
    });
  });

  describe('the database session time zone', () => {
    it('gives the same answers when the connection runs in another zone, for rows written by that connection', async () => {
      await cleanTestDatabase(dataSource);
      await tokens();
      const tokyo = new DataSource({
        ...(createTestDataSource().options as object),
        extra: { options: '-c TimeZone=Asia/Tokyo' },
      } as ConstructorParameters<typeof DataSource>[0]);
      await tokyo.initialize();
      try {
        const [zone] =
          await tokyo.query<Array<{ TimeZone: string }>>('SHOW TimeZone');
        expect(zone.TimeZone).toBe('Asia/Tokyo');
        await buildFixture(tokyo);
        const service = new AnalyticsService(tokyo);

        const overview = await service.overview({
          from: '2026-11-10',
          to: '2026-11-12',
        });
        const days = await service.revenueByDay({
          from: '2026-11-08',
          to: '2026-11-14',
        });
        const losAngeles = await service.revenueByDay({
          from: '2026-11-09',
          to: '2026-11-10',
          timezone: 'America/Los_Angeles',
        });

        expect(overview.current).toEqual(CURRENT);
        expect(overview.previous).toEqual(PREVIOUS);
        expect(days.days).toEqual([
          { date: '2026-11-08', revenue: 50_000, orders: 1 },
          { date: '2026-11-09', revenue: 100_000, orders: 1 },
          { date: '2026-11-10', revenue: 1_150_000, orders: 3 },
          { date: '2026-11-11', revenue: 100_000, orders: 1 },
          { date: '2026-11-12', revenue: 300_000, orders: 1 },
          { date: '2026-11-13', revenue: 800_000, orders: 1 },
          { date: '2026-11-14', revenue: 0, orders: 0 },
        ]);
        expect(losAngeles.days).toEqual([
          { date: '2026-11-09', revenue: 400_000, orders: 2 },
          { date: '2026-11-10', revenue: 950_000, orders: 3 },
        ]);
      } finally {
        await tokyo.destroy();
      }
    });
  });
});

// --- fixtures ---------------------------------------------------------------

// A time stamp column value, the way the app stores it: the instant as the wall
// clock of the connection's session time zone.
const WALL = (parameter: string) =>
  `(${parameter}::timestamptz AT TIME ZONE current_setting('TimeZone'))`;

async function insertUser(
  db: DataSource,
  label: string,
  role: UserRole,
  createdAt: string,
): Promise<number> {
  const rows = await db.query<Array<{ id: number }>>(
    `INSERT INTO "users" ("email", "password", "role", "createdAt")
     VALUES ($1, 'not-a-real-hash', $2, ${WALL('$3')}) RETURNING "id"`,
    [`${label}@example.com`, role, createdAt],
  );
  return rows[0].id;
}

async function saveProduct(
  db: DataSource,
  name: string,
  slug: string,
  categoryId: number,
): Promise<Product> {
  return db.getRepository(Product).save({
    name,
    slug,
    description: null,
    status: ProductStatus.ACTIVE,
    categoryId,
    brandId: null,
  });
}

interface OrderFixture {
  userId: number;
  at: string;
  status: string;
  lines: Array<[ProductVariant, number]>;
  discount?: number;
}

async function insertOrder(db: DataSource, order: OrderFixture): Promise<void> {
  const subtotal = order.lines.reduce(
    (sum, [variant, quantity]) => sum + variant.price * quantity,
    0,
  );
  const discount = order.discount ?? 0;
  const rows = await db.query<Array<{ id: number }>>(
    `INSERT INTO "orders"
       ("subtotalPrice", "discountPrice", "totalPrice", "couponCode", "couponType", "couponValue",
        "status", "shippingAddress", "userId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, ${WALL('$9')}, ${WALL('$9')})
     RETURNING "id"`,
    [
      subtotal,
      discount,
      subtotal - discount,
      discount > 0 ? 'FIXED50' : null,
      discount > 0 ? 'fixed' : null,
      discount > 0 ? discount : null,
      order.status,
      order.userId,
      order.at,
    ],
  );
  for (const [variant, quantity] of order.lines) {
    await db.query(
      `INSERT INTO "order_items" ("quantity", "price", "orderId", "variantId") VALUES ($1, $2, $3, $4)`,
      [quantity, variant.price, rows[0].id, variant.id],
    );
  }
}

// The data every figure in this file is worked out from. All instants are UTC;
// the local time in Vietnam (UTC+7) is in the comment. Prices: V1a 100,000 and
// V1b 250,000 (product P1), V2 50,000 (P2), V3 400,000 (P3).
async function buildFixture(db: DataSource): Promise<void> {
  const tops = await createCategory(db, 'tops');
  const outerwear = await createCategory(db, 'outerwear');
  const p1 = await saveProduct(db, 'P1 Tee', 'p1-tee', tops.id);
  const p2 = await saveProduct(db, 'P2 Socks', 'p2-socks', tops.id);
  const p3 = await saveProduct(db, 'P3 Jacket', 'p3-jacket', outerwear.id);
  const v1a = await createVariant(db, p1, 'v1a', { price: 100_000, stock: 99 });
  const v1b = await createVariant(db, p1, 'v1b', { price: 250_000, stock: 99 });
  const v2 = await createVariant(db, p2, 'v2', { price: 50_000, stock: 99 });
  const v3 = await createVariant(db, p3, 'v3', { price: 400_000, stock: 99 });

  const buyer = await insertUser(
    db,
    'buyer',
    UserRole.USER,
    '2026-09-01T00:00:00Z',
  );
  const order = (
    at: string,
    status: string,
    lines: Array<[ProductVariant, number]>,
    discount?: number,
  ) => insertOrder(db, { userId: buyer, at, status, lines, discount });

  // Previous period, 7 to 9 November.
  await order('2026-11-06T16:59:59Z', 'delivered', [[v3, 1]]); // 23:59:59 on the 6th: before it
  await order('2026-11-06T17:00:00Z', 'shipped', [[v1a, 1]]); // 00:00:00 on the 7th: first second
  await order('2026-11-07T10:00:00Z', 'cancelled', [[v1b, 1]]); // the 7th, 250,000 cancelled
  await order('2026-11-08T03:00:00Z', 'delivered', [[v2, 1]]); // the 8th, 50,000
  await order('2026-11-09T16:59:59Z', 'delivered', [[v1a, 1]]); // 23:59:59 on the 9th: last second

  // This period, 10 to 12 November.
  await order('2026-11-09T17:00:00Z', 'delivered', [
    [v1a, 1],
    [v2, 4],
  ]); // 00:00:00 on the 10th: 300,000
  await order('2026-11-10T09:00:00Z', 'shipped', [[v3, 1]], 50_000); // the 10th: 400,000 - 50,000 = 350,000
  await order('2026-11-10T16:59:59Z', 'confirmed', [[v1b, 2]]); // 23:59:59 on the 10th: 500,000
  await order('2026-11-10T17:00:00Z', 'processing', [[v2, 2]]); // 00:00:00 on the 11th: 100,000
  await order('2026-11-11T05:00:00Z', 'cancelled', [[v3, 1]]); // the 11th, 400,000 cancelled
  await order('2026-11-11T20:00:00Z', 'pending', [[v1a, 1]]); // 03:00 on the 12th, 100,000 pending
  await order('2026-11-12T16:59:59Z', 'delivered', [[v1a, 3]]); // 23:59:59 on the 12th: 300,000

  // After it.
  await order('2026-11-12T17:00:00Z', 'delivered', [[v3, 2]]); // 00:00:00 on the 13th: 800,000

  // New customers.
  await insertUser(db, 'cust-e', UserRole.USER, '2026-11-06T16:59:59Z'); // the 6th 23:59:59: outside
  await insertUser(db, 'cust-f', UserRole.USER, '2026-11-06T17:00:00Z'); // the 7th 00:00:00: previous
  await insertUser(db, 'cust-d', UserRole.USER, '2026-11-08T05:00:00Z'); // the 8th: previous
  await insertUser(db, 'cust-a', UserRole.USER, '2026-11-09T17:00:00Z'); // the 10th 00:00:00: this period
  await insertUser(db, 'admin-2', UserRole.ADMIN, '2026-11-11T00:00:00Z'); // an admin: never a customer
  await insertUser(db, 'cust-b', UserRole.USER, '2026-11-12T16:59:59Z'); // the 12th 23:59:59: this period
  await insertUser(db, 'cust-c', UserRole.USER, '2026-11-12T17:00:00Z'); // the 13th 00:00:00: outside
}
