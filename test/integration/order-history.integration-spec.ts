import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { seedCatalogExpansion } from '../../src/database/seeds/catalog-expansion/catalog-expansion';
import { seedDemoData } from '../../src/database/seeds/demo-seed';
import { PRODUCTION_DEMO_CONFIRMATION } from '../../src/database/seeds/demo-seed-safety';
import {
  HISTORY_EMAIL_DOMAIN,
  buildCustomers,
} from '../../src/database/seeds/order-history/history-people';
import { SeededRandom } from '../../src/database/seeds/order-history/history-random';
import { HISTORY_SEED } from '../../src/database/seeds/order-history/history-config';
import {
  seedOrderHistory,
  type OrderHistorySummary,
} from '../../src/database/seeds/order-history/order-history';
import { OrderExpiryService } from '../../src/orders/order-expiry.service';
import { Coupon } from '../../src/promotions/entities/coupon.entity';
import { calculateOrderPricing } from '../../src/promotions/promotions-calculator';
import {
  cleanTestDatabase,
  createTestDataSource,
  initializeTestDatabase,
} from './test-database';

const testOptions = { target: 'test' as const, nodeEnvironment: 'test' };
const MARKER = `%@${HISTORY_EMAIL_DOMAIN}`;
const CUSTOMERS = `(SELECT "id" FROM "users" WHERE "email" LIKE $1)`;

describe('seeded order history on isolated PostgreSQL', () => {
  let dataSource: DataSource;

  const sql = <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => dataSource.query<T[]>(text, params);
  const one = async (text: string, params: unknown[] = []): Promise<number> => {
    const rows = await sql<{ n: number }>(text, params);
    return rows[0].n;
  };
  const tableCounts = async () => ({
    users: await one(`SELECT COUNT(*)::int AS n FROM users`),
    addresses: await one(`SELECT COUNT(*)::int AS n FROM addresses`),
    orders: await one(`SELECT COUNT(*)::int AS n FROM orders`),
    items: await one(`SELECT COUNT(*)::int AS n FROM order_items`),
    payments: await one(`SELECT COUNT(*)::int AS n FROM payments`),
    events: await one(`SELECT COUNT(*)::int AS n FROM payment_events`),
    reviews: await one(`SELECT COUNT(*)::int AS n FROM product_reviews`),
  });
  const stockById = async () =>
    new Map(
      (
        await sql<{ id: number; stock: number }>(
          `SELECT id, stock FROM product_variants ORDER BY id`,
        )
      ).map((row) => [row.id, row.stock]),
    );

  async function seedCatalog(): Promise<void> {
    await cleanTestDatabase(dataSource);
    await seedDemoData(dataSource, testOptions);
    await seedCatalogExpansion(dataSource, testOptions);
  }

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  describe('a seeded database', () => {
    let summary: OrderHistorySummary;
    let stockBefore: Map<number, number>;
    let baseUsersBefore: unknown[];
    let adminId: number;

    beforeAll(async () => {
      await seedCatalog();
      stockBefore = await stockById();
      baseUsersBefore = await sql(`SELECT * FROM users ORDER BY id`);
      adminId = (
        await sql<{ id: number }>(
          `SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`,
        )
      )[0].id;
      summary = await seedOrderHistory(dataSource, testOptions);
    });

    it('creates 40 customers and 400 orders with the planned mix', () => {
      expect(summary.status).toBe('seeded');
      expect(summary.customers).toBe(40);
      expect(summary.orders).toBe(400);
      expect(summary.ordersByStatus.cancelled).toBe(32);
      expect(summary.ordersByStatus.pending).toBe(6);
      expect(summary.ordersByStatus.delivered).toBeGreaterThan(300);
      expect(summary.ordersByStatus.shipped).toBeGreaterThan(0);
      expect(
        summary.ordersByStatus.confirmed + summary.ordersByStatus.processing,
      ).toBeGreaterThan(0);
      expect(summary.paymentEvents).toBeGreaterThan(300);
      expect(summary.unresolvedEvents).toBe(4);
      expect(summary.resolvedEvents).toBe(2);
      expect(summary.reviews).toBeGreaterThanOrEqual(60);
      expect(summary.reviews).toBeLessThanOrEqual(100);
    });

    it('marks every customer with the synthetic domain and creates no admin', async () => {
      const added = await sql<{ email: string; role: string }>(
        `SELECT email, role FROM users WHERE email LIKE $1`,
        [MARKER],
      );

      expect(added).toHaveLength(40);
      for (const user of added) {
        expect(user.role).toBe('user');
        expect(user.email).toMatch(/@demo-history\.example\.com$/);
      }
      expect(
        await one(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'`),
      ).toBe(1);
      expect(
        await one(
          `SELECT COUNT(*)::int AS n FROM users WHERE email NOT LIKE $1`,
          [MARKER],
        ),
      ).toBe(baseUsersBefore.length);
    });

    it('leaves the users that already existed exactly as they were', async () => {
      const after = await sql(
        `SELECT * FROM users WHERE email NOT LIKE $1 ORDER BY id`,
        [MARKER],
      );

      expect(after).toEqual(baseUsersBefore);
    });

    it('gives the customers a password hash nobody can use', async () => {
      const hashes = await sql<{ password: string }>(
        `SELECT password FROM users WHERE email LIKE $1`,
        [MARKER],
      );

      // One random secret, hashed once and shared; the secret is not kept.
      const unique = [...new Set(hashes.map((row) => row.password))];
      expect(hashes).toHaveLength(40);
      expect(unique).toHaveLength(1);
      for (const password of unique) {
        expect(password).toMatch(/^\$2[aby]\$10\$/);
        for (const guess of [
          'DemoOnly!2026',
          'password',
          'Password123!',
          'demo-history',
          'changeme',
          '',
        ]) {
          expect(await bcrypt.compare(guess, password)).toBe(false);
        }
      }
    });

    it('gives each customer one default address, and orders carry a copy of it', async () => {
      expect(
        await one(
          `SELECT COUNT(*)::int AS n FROM addresses WHERE "userId" IN ${CUSTOMERS} AND "isDefault" = true`,
          [MARKER],
        ),
      ).toBe(40);
      const mismatches = await sql(
        `SELECT o.id FROM orders o
         JOIN addresses a ON a."userId" = o."userId"
         WHERE o."userId" IN ${CUSTOMERS}
           AND (o."shippingAddress" ->> 'addressLine1' <> a."addressLine1"
             OR o."shippingAddress" ->> 'city' <> a.city
             OR o."shippingAddress" ->> 'recipientName' <> a."recipientName")`,
        [MARKER],
      );
      expect(mismatches).toEqual([]);
    });

    it('prices every order the way checkout does', async () => {
      const wrongTotals = await sql(
        `SELECT o.id FROM orders o
         LEFT JOIN (SELECT "orderId", SUM(price * quantity) AS s FROM order_items GROUP BY "orderId") i
           ON i."orderId" = o.id
         WHERE o."userId" IN ${CUSTOMERS}
           AND (COALESCE(i.s, 0) <> o."subtotalPrice"
             OR o."totalPrice" <> o."subtotalPrice" - o."discountPrice"
             OR o."discountPrice" > o."subtotalPrice"
             OR o."totalPrice" < 1000)`,
        [MARKER],
      );
      const wrongPrices = await sql(
        `SELECT i.id FROM order_items i
         JOIN orders o ON o.id = i."orderId"
         JOIN product_variants v ON v.id = i."variantId"
         WHERE o."userId" IN ${CUSTOMERS} AND i.price <> v.price`,
        [MARKER],
      );
      const itemsPerOrder = await sql<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM order_items i JOIN orders o ON o.id = i."orderId"
         WHERE o."userId" IN ${CUSTOMERS} GROUP BY o.id`,
        [MARKER],
      );

      expect(wrongTotals).toEqual([]);
      expect(wrongPrices).toEqual([]);
      expect(Math.min(...itemsPerOrder.map((row) => row.n))).toBe(1);
      expect(Math.max(...itemsPerOrder.map((row) => row.n))).toBe(4);
    });

    it('applies only coupons that exist, with the discount the calculator gives', async () => {
      const coupons = new Map(
        (await dataSource.getRepository(Coupon).find()).map((coupon) => [
          coupon.code,
          coupon,
        ]),
      );
      const couponOrders = await sql<{
        couponCode: string;
        couponType: string;
        couponValue: string;
        subtotalPrice: string;
        discountPrice: string;
        createdAt: Date;
      }>(
        `SELECT "couponCode", "couponType", "couponValue", "subtotalPrice", "discountPrice", "createdAt"
         FROM orders WHERE "userId" IN ${CUSTOMERS} AND "couponCode" IS NOT NULL`,
        [MARKER],
      );

      expect(couponOrders.length).toBeGreaterThan(30);
      expect(
        new Set(couponOrders.map((order) => order.couponCode)).size,
      ).toBeGreaterThan(1);
      for (const order of couponOrders) {
        const coupon = coupons.get(order.couponCode);
        expect(coupon).toBeDefined();
        expect(order.couponType).toBe(coupon!.type);
        expect(Number(order.couponValue)).toBe(coupon!.value);
        const expected = calculateOrderPricing(
          Number(order.subtotalPrice),
          coupon,
          new Date(),
        );
        expect(Number(order.discountPrice)).toBe(expected.discount);
      }
      expect(
        await one(
          `SELECT COUNT(*)::int AS n FROM orders WHERE "userId" IN ${CUSTOMERS}
             AND "couponCode" IS NULL AND ("discountPrice" <> 0 OR "couponType" IS NOT NULL OR "couponValue" IS NOT NULL)`,
          [MARKER],
        ),
      ).toBe(0);
    });

    it('keeps payments consistent with the order status and the payment model', async () => {
      const rows = await sql<{
        id: number;
        status: string;
        totalPrice: string;
        payments: Array<{
          status: string;
          amount: string;
          provider: string;
          currency: string;
          providerPaymentId: string;
          paymentId: number;
          succeeded: boolean;
          afterOrder: boolean;
        }>;
      }>(
        `SELECT o.id, o.status, o."totalPrice",
                COALESCE(json_agg(json_build_object(
                  'status', p.status, 'amount', p.amount, 'provider', p.provider,
                  'currency', p.currency, 'providerPaymentId', p."providerPaymentId",
                  'paymentId', p.id,
                  'succeeded', p."succeededAt" IS NOT NULL,
                  'afterOrder', p."createdAt" >= o."createdAt" AND (p."succeededAt" IS NULL OR p."succeededAt" > o."createdAt")
                ) ORDER BY p.id) FILTER (WHERE p.id IS NOT NULL), '[]'::json) AS payments
         FROM orders o LEFT JOIN payments p ON p."orderId" = o.id
         WHERE o."userId" IN ${CUSTOMERS} GROUP BY o.id`,
        [MARKER],
      );

      expect(rows).toHaveLength(400);
      const paidStatuses = ['confirmed', 'processing', 'shipped', 'delivered'];
      for (const order of rows) {
        const succeeded = order.payments.filter(
          (p) => p.status === 'succeeded',
        );
        const active = order.payments.filter((p) =>
          ['pending', 'processing', 'succeeded'].includes(p.status),
        );
        expect(active.length).toBeLessThanOrEqual(1);
        if (paidStatuses.includes(order.status)) {
          expect(succeeded).toHaveLength(1);
          expect(Number(succeeded[0].amount)).toBe(Number(order.totalPrice));
        } else {
          expect(succeeded).toHaveLength(0);
        }
        if (order.status === 'cancelled') expect(active).toHaveLength(0);
        for (const payment of order.payments) {
          expect(payment.provider).toBe('demo');
          expect(payment.currency).toBe('VND');
          expect(payment.providerPaymentId).toBe(
            `demo_payment_${payment.paymentId}`,
          );
          expect(Number(payment.amount)).toBe(Number(order.totalPrice));
          expect(payment.succeeded).toBe(payment.status === 'succeeded');
          expect(payment.afterOrder).toBe(true);
        }
      }
    });

    it('has pending orders only from the last hour', async () => {
      const pending = await sql<{ ageMinutes: number }>(
        `SELECT EXTRACT(EPOCH FROM ((now() AT TIME ZONE current_setting('TimeZone')) - "createdAt")) / 60 AS "ageMinutes"
         FROM orders WHERE "userId" IN ${CUSTOMERS} AND status = 'pending'`,
        [MARKER],
      );

      expect(pending).toHaveLength(6);
      for (const order of pending) {
        expect(Number(order.ageMinutes)).toBeGreaterThan(0);
        expect(Number(order.ageMinutes)).toBeLessThan(60);
      }
      expect(
        await one(
          `SELECT COUNT(*)::int AS n FROM orders WHERE "userId" IN ${CUSTOMERS}
             AND status <> 'pending'
             AND "createdAt" > (now() AT TIME ZONE current_setting('TimeZone')) - interval '1 hour'`,
          [MARKER],
        ),
      ).toBe(0);
    });

    it('spreads orders over the last 90 days, none in the future', async () => {
      const [range] = await sql<{
        oldestDays: number;
        newest: number;
        later: number;
      }>(
        `SELECT EXTRACT(EPOCH FROM ((now() AT TIME ZONE current_setting('TimeZone')) - MIN("createdAt"))) / 86400 AS "oldestDays",
                (MAX("createdAt") > (now() AT TIME ZONE current_setting('TimeZone')))::int AS newest,
                (SELECT COUNT(*)::int FROM orders WHERE "userId" IN ${CUSTOMERS}
                   AND ("updatedAt" > (now() AT TIME ZONE current_setting('TimeZone')) OR "updatedAt" < "createdAt")) AS later
         FROM orders WHERE "userId" IN ${CUSTOMERS}`,
        [MARKER],
      );

      expect(Number(range.oldestDays)).toBeGreaterThan(80);
      expect(Number(range.oldestDays)).toBeLessThan(91);
      expect(range.newest).toBe(0);
      expect(range.later).toBe(0);
    });

    it('has the reconciliation events a payment callback would have produced', async () => {
      const events = await sql<{
        eventType: string;
        processingMessage: string;
        resolvedAt: Date | null;
        resolvedByUserId: number | null;
        resolutionNote: string | null;
        orderStatus: string;
        paymentStatus: string;
        providerEventId: string;
        paymentId: number;
      }>(
        `SELECT e."eventType", e."processingMessage", e."resolvedAt", e."resolvedByUserId", e."resolutionNote",
                e."providerEventId", e."paymentId", o.status AS "orderStatus", p.status AS "paymentStatus"
         FROM payment_events e
         JOIN payments p ON p.id = e."paymentId"
         JOIN orders o ON o.id = p."orderId"
         WHERE o."userId" IN ${CUSTOMERS} AND e."processingStatus" = 'requires_reconciliation'
         ORDER BY e.id`,
        [MARKER],
      );

      expect(events).toHaveLength(6);
      expect(events.filter((event) => event.resolvedAt === null)).toHaveLength(
        4,
      );
      for (const event of events) {
        expect(event.providerEventId).toBe(
          `demo:${event.paymentId}:${event.eventType === 'succeeded' ? 'success' : 'failure'}`,
        );
        if (event.eventType === 'succeeded') {
          expect(event.processingMessage).toBe(
            'Provider success conflicts with terminal Payment or non-pending Order',
          );
          expect(event.orderStatus).toBe('cancelled');
          expect(event.paymentStatus).toBe('cancelled');
        } else {
          expect(event.processingMessage).toBe(
            'Provider failure arrived after success',
          );
          expect(event.paymentStatus).toBe('succeeded');
        }
        if (event.resolvedAt === null) {
          expect(event.resolvedByUserId).toBeNull();
          expect(event.resolutionNote).toBeNull();
        } else {
          expect(event.resolvedByUserId).toBe(adminId);
          expect(event.resolutionNote!.length).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it('records the ordinary callbacks too: a processed success for every paid order', async () => {
      const paidWithoutEvent = await sql(
        `SELECT p.id FROM payments p JOIN orders o ON o.id = p."orderId"
         WHERE o."userId" IN ${CUSTOMERS} AND p.status = 'succeeded'
           AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e."paymentId" = p.id
                           AND e."eventType" = 'succeeded' AND e."processingStatus" = 'processed')`,
        [MARKER],
      );

      expect(paidWithoutEvent).toEqual([]);
    });

    it('lets only customers with a delivered order review the product, once each', async () => {
      const unsupported = await sql(
        `SELECT r.id FROM product_reviews r
         WHERE r."userId" IN ${CUSTOMERS}
           AND NOT EXISTS (
             SELECT 1 FROM orders o
             JOIN order_items i ON i."orderId" = o.id
             JOIN product_variants v ON v.id = i."variantId"
             WHERE o."userId" = r."userId" AND o.status = 'delivered'
               AND v."productId" = r."productId" AND o."updatedAt" < r."createdAt")`,
        [MARKER],
      );
      const ratings = await sql<{ rating: number; n: number }>(
        `SELECT rating, COUNT(*)::int AS n FROM product_reviews WHERE "userId" IN ${CUSTOMERS} GROUP BY rating`,
        [MARKER],
      );
      const total = ratings.reduce((sum, row) => sum + row.n, 0);
      const high = ratings
        .filter((row) => row.rating >= 4)
        .reduce((sum, row) => sum + row.n, 0);

      expect(unsupported).toEqual([]);
      expect(high / total).toBeGreaterThan(0.6);
      expect(ratings.some((row) => row.rating <= 2)).toBe(true);
      expect(
        await one(
          `SELECT COUNT(*)::int AS n FROM product_reviews WHERE "userId" IN ${CUSTOMERS}
             AND (title IS NULL OR title = '' OR rating NOT BETWEEN 1 AND 5 OR "isVisible" = false)`,
          [MARKER],
        ),
      ).toBe(0);
    });

    it('does not change stock except for the units pending orders reserve', async () => {
      const after = await stockById();
      const reserved = new Map(
        (
          await sql<{ id: number; q: number }>(
            `SELECT i."variantId" AS id, SUM(i.quantity)::int AS q
             FROM order_items i JOIN orders o ON o.id = i."orderId"
             WHERE o."userId" IN ${CUSTOMERS} AND o.status = 'pending'
             GROUP BY i."variantId"`,
            [MARKER],
          )
        ).map((row) => [row.id, row.q]),
      );

      expect(reserved.size).toBeGreaterThan(0);
      expect([...after.keys()]).toEqual([...stockBefore.keys()]);
      let units = 0;
      for (const [id, before] of stockBefore) {
        const expected = before - (reserved.get(id) ?? 0);
        expect(after.get(id)).toBe(expected);
        expect(after.get(id)!).toBeGreaterThanOrEqual(0);
        units += reserved.get(id) ?? 0;
      }
      expect(summary.reservedUnits).toBe(units);
    });

    it('does not touch the catalog', async () => {
      expect(await one(`SELECT COUNT(*)::int AS n FROM products`)).toBe(70);
      expect(await one(`SELECT COUNT(*)::int AS n FROM coupons`)).toBe(4);
    });

    it('adds nothing on a rerun and says it is already seeded', async () => {
      const before = await tableCounts();
      const stock = await stockById();

      const again = await seedOrderHistory(dataSource, testOptions);

      expect(again.status).toBe('already-seeded');
      expect(again.customers).toBe(40);
      expect(again.orders).toBe(400);
      expect(again.reservedUnits).toBeUndefined();
      expect(await tableCounts()).toEqual(before);
      expect(await stockById()).toEqual(stock);
    });
  });

  describe('safety and failure', () => {
    beforeEach(async () => {
      await seedCatalog();
    });

    it('runs twice at the same time and seeds exactly once', async () => {
      const results = await Promise.all([
        seedOrderHistory(dataSource, testOptions),
        seedOrderHistory(dataSource, testOptions),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        'already-seeded',
        'seeded',
      ]);
      expect(await one(`SELECT COUNT(*)::int AS n FROM orders`)).toBe(401);
      expect(
        await one(`SELECT COUNT(*)::int AS n FROM users WHERE email LIKE $1`, [
          MARKER,
        ]),
      ).toBe(40);
    });

    it('gives the reserved stock back when the expiry job cancels the pending orders', async () => {
      const before = await stockById();
      await seedOrderHistory(dataSource, testOptions);
      const reservedStock = await stockById();
      expect(
        [...reservedStock].some(([id, stock]) => stock < before.get(id)!),
      ).toBe(true);

      // Two hours on, every pending order is past its payment window.
      const result = await new OrderExpiryService(
        dataSource,
      ).expireOverdueOrders(new Date(Date.now() + 2 * 60 * 60 * 1000));

      expect(result.expired).toBe(6);
      expect(result.failed).toBe(0);
      expect(await stockById()).toEqual(before);
      expect(
        await one(
          `SELECT COUNT(*)::int AS n FROM orders WHERE "userId" IN ${CUSTOMERS} AND status = 'pending'`,
          [MARKER],
        ),
      ).toBe(0);
    });

    it('leaves recent pending orders alone when the expiry job runs now', async () => {
      await seedOrderHistory(dataSource, testOptions);

      const result = await new OrderExpiryService(
        dataSource,
      ).expireOverdueOrders();

      // Created in the last 28 minutes with a 30 minute window: at most the
      // oldest ones are close, and a seeded old pending order cannot exist.
      expect(result.failed).toBe(0);
      expect(
        await one(
          `SELECT COUNT(*)::int AS n FROM orders WHERE "userId" IN ${CUSTOMERS} AND status = 'pending'`,
          [MARKER],
        ),
      ).toBeGreaterThanOrEqual(4);
    });

    it('writes time stamps in the session time zone, as the app reads them', async () => {
      // A connection whose session time zone is not UTC.
      const tokyo = new DataSource({
        ...(createTestDataSource().options as object),
        extra: { options: '-c TimeZone=Asia/Tokyo' },
      } as ConstructorParameters<typeof DataSource>[0]);
      await tokyo.initialize();
      try {
        const [zone] =
          await tokyo.query<Array<{ TimeZone: string }>>('SHOW TimeZone');
        expect(zone.TimeZone).toBe('Asia/Tokyo');

        await seedOrderHistory(tokyo, testOptions);

        const rows = await tokyo.query<
          Array<{ ageMinutes: string; future: number }>
        >(
          `SELECT EXTRACT(EPOCH FROM ((now() AT TIME ZONE current_setting('TimeZone')) - "createdAt")) / 60 AS "ageMinutes",
                  ("createdAt" > (now() AT TIME ZONE current_setting('TimeZone')))::int AS future
           FROM orders WHERE "userId" IN ${CUSTOMERS} AND status = 'pending'`,
          [MARKER],
        );
        expect(rows).toHaveLength(6);
        for (const row of rows) {
          expect(Number(row.ageMinutes)).toBeGreaterThan(0);
          expect(Number(row.ageMinutes)).toBeLessThan(35);
          expect(row.future).toBe(0);
        }
        // The expiry job compares in the same convention: nothing recent is old.
        expect(
          (await new OrderExpiryService(tokyo).expireOverdueOrders()).failed,
        ).toBe(0);
      } finally {
        await tokyo.destroy();
      }
    });

    it('refuses a target that does not match the database, and writes nothing', async () => {
      const before = await tableCounts();

      await expect(
        seedOrderHistory(dataSource, {
          target: 'development',
          nodeEnvironment: 'test',
        }),
      ).rejects.toThrow('requires database ecommerce_dev');
      await expect(
        seedOrderHistory(dataSource, {
          target: 'production',
          nodeEnvironment: 'test',
          productionApproval: {
            confirmation: PRODUCTION_DEMO_CONFIRMATION,
            database: 'ecommerce_test',
          },
        }),
      ).rejects.toThrow('requires NODE_ENV=production');
      await expect(
        seedOrderHistory(dataSource, {
          target: 'production',
          nodeEnvironment: 'production',
        }),
      ).rejects.toThrow('explicit confirmation');
      await expect(
        seedOrderHistory(dataSource, {
          target: 'production',
          nodeEnvironment: 'production',
          productionApproval: {
            confirmation: PRODUCTION_DEMO_CONFIRMATION,
            database: 'some_other_database',
          },
        }),
      ).rejects.toThrow('database confirmation does not match');
      await expect(
        seedOrderHistory(dataSource, {
          target: 'test',
          nodeEnvironment: 'development',
        }),
      ).rejects.toThrow('requires NODE_ENV=test');

      expect(await tableCounts()).toEqual(before);
    });

    it('stops with a clear message when there is no catalog, and writes nothing', async () => {
      await cleanTestDatabase(dataSource);

      await expect(seedOrderHistory(dataSource, testOptions)).rejects.toThrow(
        'no active products',
      );

      expect(await tableCounts()).toEqual({
        users: 0,
        addresses: 0,
        orders: 0,
        items: 0,
        payments: 0,
        events: 0,
        reviews: 0,
      });
    });

    it('refuses to write over payments of an earlier history whose customers are gone', async () => {
      // A failed payment (not an active one) under a key of this seed, on the
      // base seed's delivered order: someone removed the customers by hand and
      // left this behind.
      const [order] = await sql<{ id: number; totalPrice: string }>(
        `SELECT id, "totalPrice" FROM orders ORDER BY id LIMIT 1`,
      );
      await sql(
        `INSERT INTO payments ("orderId", provider, "providerPaymentId", "idempotencyKey", amount, currency, status)
         VALUES ($1, 'demo', 'demo_payment_stray', 'history-seed-999-1', $2, 'VND', 'failed')`,
        [order.id, order.totalPrice],
      );
      const before = await tableCounts();

      await expect(seedOrderHistory(dataSource, testOptions)).rejects.toThrow(
        'customers are gone',
      );

      expect(await tableCounts()).toEqual(before);
    });

    it('plans the same customers every time (the marker and emails are stable)', () => {
      const first = buildCustomers(new SeededRandom(HISTORY_SEED), 40)[0].email;

      expect(first).toMatch(/^[a-z]+\.[a-z]+@demo-history\.example\.com$/);
      expect(buildCustomers(new SeededRandom(HISTORY_SEED), 40)[0].email).toBe(
        first,
      );
    });
  });
});
