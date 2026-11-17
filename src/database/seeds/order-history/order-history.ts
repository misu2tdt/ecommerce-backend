import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, In } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Address } from '../../../addresses/entities/address.entity';
import { OrderItem } from '../../../orders/entities/order-item.entity';
import { OrderStatus } from '../../../orders/entities/order-status.enum';
import { Order } from '../../../orders/entities/order.entity';
import { PaymentEvent } from '../../../payments/entities/payment-event.entity';
import { PaymentEventProcessingStatus } from '../../../payments/entities/payment-event-type.enum';
import { Payment } from '../../../payments/entities/payment.entity';
import { DEFAULT_PAYMENT_CURRENCY } from '../../../payments/payments.constants';
import { ProductStatus } from '../../../products/entities/product-status.enum';
import { ProductVariant } from '../../../products/entities/product-variant.entity';
import { Coupon } from '../../../promotions/entities/coupon.entity';
import { ProductReview } from '../../../reviews/entities/product-review.entity';
import { UserRole } from '../../../users/entities/user-role.enum';
import { User } from '../../../users/entities/user.entity';
import {
  assertSafeDemoSeedDatabase,
  type DemoSeedTarget,
} from '../demo-seed-safety';
import {
  HISTORY_PAYMENT_KEY_PREFIX,
  HISTORY_PAYMENT_PROVIDER,
} from './history-config';
import { HISTORY_EMAIL_DOMAIN } from './history-people';
import {
  buildHistoryPlan,
  type HistoryPlan,
  type HistoryProduct,
} from './history-plan';

const INSERT_CHUNK_SIZE = 200;
const BCRYPT_ROUNDS = 10;
const ADVISORY_LOCK_NAME = 'order-history-seed';
const BASE_SEED_HINT =
  'Run the base demo seed first (npm run seed:demo for development), then the catalog expansion if you want it, then this seed again.';

export interface OrderHistoryOptions {
  target: DemoSeedTarget;
  nodeEnvironment?: string;
  productionApproval?: {
    confirmation?: string;
    database?: string;
  };
  // The moment "now" means for the plan: orders spread over the 90 days before
  // it. Left out, the clock. Tests pass a fixed value.
  now?: Date;
}

export interface OrderHistorySummary {
  status: 'seeded' | 'already-seeded';
  customers: number;
  orders: number;
  orderItems: number;
  payments: number;
  paymentEvents: number;
  unresolvedEvents: number;
  resolvedEvents: number;
  reviews: number;
  ordersByStatus: Record<string, number>;
  // Units taken from stock by the pending orders (written only when seeding).
  reservedUnits?: number;
}

// Adds a synthetic order history on top of the demo catalog, for dashboards and
// analytics: about 40 customers, 400 orders over 90 days with their payments, a
// few payment events that need reconciliation, and reviews.
//
// It only inserts, and only when its marker is absent: the customers all have an
// address at demo-history.example.com, so a rerun finds them and does nothing.
// It never touches an existing row, never creates or changes an admin, and does
// not run on a database the demo seed guard refuses. One transaction.
//
// Time stamps follow the app's convention. "createdAt" and the other time stamp
// columns are "timestamp without time zone", filled by the database clock in its
// session time zone (the order expiry job reads them that way). Every time stamp
// here is written as the same wall clock: the instant, expressed in the session
// time zone of the connection that writes it.
//
// Stock: the history is background. Delivered, shipped, confirmed and cancelled
// orders do not change stock. The pending orders are different: like a real
// checkout they reserve their units (and the expiry job gives them back when it
// cancels them), so stock never ends up higher than it was before this seed.
export async function seedOrderHistory(
  dataSource: DataSource,
  options: OrderHistoryOptions,
): Promise<OrderHistorySummary> {
  assertSafeDemoSeedDatabase(
    dataSource,
    options.target,
    options.nodeEnvironment,
    options.productionApproval,
  );
  if (!dataSource.isInitialized) {
    throw new Error('Order history DataSource must be initialized');
  }
  const now = options.now ?? new Date();
  // One shared password hash that nobody knows: the secret is random, used once
  // and thrown away, so none of these accounts can ever be logged into.
  const unusablePasswordHash = await bcrypt.hash(
    randomBytes(32).toString('hex'),
    BCRYPT_ROUNDS,
  );

  return dataSource.transaction(async (manager) => {
    // Two runs at the same time: the second waits, then finds the marker.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      ADVISORY_LOCK_NAME,
    ]);

    if ((await countHistoryCustomers(manager)) > 0) {
      return {
        ...(await summariseHistory(manager)),
        status: 'already-seeded' as const,
      };
    }
    await assertNoStrayPayments(manager);

    const catalog = await loadCatalog(manager);
    const coupons = await manager
      .getRepository(Coupon)
      .find({ where: { isActive: true }, order: { id: 'ASC' } });
    const adminId = await findFirstAdminId(manager);

    const plan = buildHistoryPlan({ now, products: catalog, coupons });
    const reservedUnits = await writePlan(
      manager,
      plan,
      unusablePasswordHash,
      adminId,
    );

    const summary = await summariseHistory(manager);
    assertMatchesPlan(summary, plan);
    return { ...summary, status: 'seeded' as const, reservedUnits };
  });
}

export function formatOrderHistorySummary(
  summary: OrderHistorySummary,
): string[] {
  const lines = [
    `Customers: ${summary.customers}`,
    `Orders: ${summary.orders}`,
    `Order items: ${summary.orderItems}`,
    `Payments: ${summary.payments}`,
    `Payment events: ${summary.paymentEvents} (${summary.unresolvedEvents} unresolved, ${summary.resolvedEvents} resolved)`,
    `Reviews: ${summary.reviews}`,
    `Orders by status: ${Object.entries(summary.ordersByStatus)
      .map(([status, count]) => `${status} ${count}`)
      .join(', ')}`,
  ];
  if (summary.reservedUnits !== undefined) {
    lines.push(
      `Stock reserved by pending orders: ${summary.reservedUnits} unit(s)`,
    );
  }
  return lines;
}

// --- reading ----------------------------------------------------------------

const MARKER_PATTERN = `%@${HISTORY_EMAIL_DOMAIN}`;

async function countHistoryCustomers(manager: EntityManager): Promise<number> {
  const [row] = await manager.query<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM "users" WHERE "email" LIKE $1`,
    [MARKER_PATTERN],
  );
  return row.n;
}

// A payment key of this seed without any of its customers means someone removed
// the customers by hand; writing again could collide with what is left.
async function assertNoStrayPayments(manager: EntityManager): Promise<void> {
  const stray = await manager.query<unknown[]>(
    `SELECT 1 FROM "payments" WHERE "idempotencyKey" LIKE $1 LIMIT 1`,
    [`${HISTORY_PAYMENT_KEY_PREFIX}%`],
  );
  if (stray.length > 0) {
    throw new Error(
      'Payments of an earlier order history exist but its customers are gone. Remove them before seeding again.',
    );
  }
}

async function loadCatalog(manager: EntityManager): Promise<HistoryProduct[]> {
  const variants = await manager
    .getRepository(ProductVariant)
    .createQueryBuilder('variant')
    .innerJoin('variant.product', 'product')
    .where('product.status = :status', { status: ProductStatus.ACTIVE })
    .andWhere('variant.isActive = true')
    .orderBy('variant.productId', 'ASC')
    .addOrderBy('variant.id', 'ASC')
    .getMany();
  if (variants.length === 0) {
    throw new Error(
      `There are no active products to build orders from. ${BASE_SEED_HINT}`,
    );
  }
  const byProduct = new Map<number, ProductVariant[]>();
  for (const variant of variants) {
    const list = byProduct.get(variant.productId) ?? [];
    list.push(variant);
    byProduct.set(variant.productId, list);
  }
  return [...byProduct].map(([id, list]) => ({
    id,
    variants: list.map((variant) => ({
      id: variant.id,
      productId: variant.productId,
      price: variant.price,
      stock: variant.stock,
    })),
  }));
}

async function findFirstAdminId(
  manager: EntityManager,
): Promise<number | null> {
  const admin = await manager.getRepository(User).findOne({
    select: { id: true },
    where: { role: UserRole.ADMIN },
    order: { id: 'ASC' },
  });
  return admin?.id ?? null;
}

// What the history looks like in the database, found by its marker. The same
// answer after a fresh seed and on a rerun.
async function summariseHistory(
  manager: EntityManager,
): Promise<Omit<OrderHistorySummary, 'status' | 'reservedUnits'>> {
  const marker = [MARKER_PATTERN];
  const one = async (sql: string): Promise<number> => {
    const [row] = await manager.query<Array<{ n: number }>>(sql, marker);
    return row.n;
  };
  const customerIds = `SELECT "id" FROM "users" WHERE "email" LIKE $1`;

  const byStatus = await manager.query<Array<{ status: string; n: number }>>(
    `SELECT "status", COUNT(*)::int AS n FROM "orders" WHERE "userId" IN (${customerIds}) GROUP BY "status" ORDER BY "status"`,
    marker,
  );
  const ordersByStatus: Record<string, number> = {};
  for (const status of Object.values(OrderStatus)) ordersByStatus[status] = 0;
  for (const row of byStatus) ordersByStatus[row.status] = row.n;

  const events = (resolved: boolean) =>
    one(
      `SELECT COUNT(*)::int AS n FROM "payment_events" e
       INNER JOIN "payments" p ON p."id" = e."paymentId"
       INNER JOIN "orders" o ON o."id" = p."orderId"
       WHERE o."userId" IN (${customerIds})
         AND e."processingStatus" = '${PaymentEventProcessingStatus.REQUIRES_RECONCILIATION}'
         AND e."resolvedAt" IS ${resolved ? 'NOT NULL' : 'NULL'}`,
    );

  return {
    customers: await countHistoryCustomers(manager),
    orders: Object.values(ordersByStatus).reduce((sum, n) => sum + n, 0),
    orderItems: await one(
      `SELECT COUNT(*)::int AS n FROM "order_items" i INNER JOIN "orders" o ON o."id" = i."orderId" WHERE o."userId" IN (${customerIds})`,
    ),
    payments: await one(
      `SELECT COUNT(*)::int AS n FROM "payments" p INNER JOIN "orders" o ON o."id" = p."orderId" WHERE o."userId" IN (${customerIds})`,
    ),
    paymentEvents: await one(
      `SELECT COUNT(*)::int AS n FROM "payment_events" e
       INNER JOIN "payments" p ON p."id" = e."paymentId"
       INNER JOIN "orders" o ON o."id" = p."orderId"
       WHERE o."userId" IN (${customerIds})`,
    ),
    unresolvedEvents: await events(false),
    resolvedEvents: await events(true),
    reviews: await one(
      `SELECT COUNT(*)::int AS n FROM "product_reviews" WHERE "userId" IN (${customerIds})`,
    ),
    ordersByStatus,
  };
}

// The database must hold exactly what the plan said; otherwise the transaction
// rolls back and nothing is kept.
function assertMatchesPlan(
  summary: Omit<OrderHistorySummary, 'status' | 'reservedUnits'>,
  plan: HistoryPlan,
): void {
  const expected = {
    customers: plan.customers.length,
    orders: plan.orders.length,
    orderItems: plan.orders.reduce((sum, order) => sum + order.items.length, 0),
    payments: plan.orders.reduce(
      (sum, order) => sum + order.payments.length,
      0,
    ),
    reviews: plan.reviews.length,
  };
  for (const [name, count] of Object.entries(expected)) {
    const actual = summary[name as keyof typeof expected];
    if (actual !== count) {
      throw new Error(
        `Order history check failed: expected ${count} ${name}, found ${actual}`,
      );
    }
  }
}

// --- writing ----------------------------------------------------------------

// A time stamp column value: the instant as the wall clock of the writing
// connection's session time zone. The ISO text comes from Date#toISOString, so
// it can only be digits, "T", "-", ":", "." and "Z".
const wall = (date: Date) => (): string =>
  `(TIMESTAMPTZ '${date.toISOString()}' AT TIME ZONE current_setting('TimeZone'))`;

async function writePlan(
  manager: EntityManager,
  plan: HistoryPlan,
  passwordHash: string,
  adminId: number | null,
): Promise<number> {
  // Customers and their default address.
  await insertChunks(
    manager,
    User,
    plan.customers.map((customer) => ({
      email: customer.email,
      password: passwordHash,
      role: UserRole.USER,
      createdAt: wall(customer.createdAt),
    })),
  );
  const users = await manager.getRepository(User).find({
    select: { id: true, email: true },
    where: { email: In(plan.customers.map((customer) => customer.email)) },
  });
  const userIdByEmail = new Map(users.map((user) => [user.email, user.id]));
  const userIds = plan.customers.map((customer) => {
    const id = userIdByEmail.get(customer.email);
    if (id === undefined)
      throw new Error(`Customer ${customer.email} was not written`);
    return id;
  });
  await insertChunks(
    manager,
    Address,
    plan.customers.map((customer, index) => ({
      userId: userIds[index],
      label: 'Home',
      ...customer.address,
      isDefault: true,
      createdAt: wall(customer.createdAt),
      updatedAt: wall(customer.createdAt),
    })),
  );

  // Orders and payments get their ids first, so the rows that point at them can
  // be written without reading anything back.
  const orderIds = await reserveIds(manager, 'orders', plan.orders.length);
  const paymentCount = plan.orders.reduce(
    (sum, order) => sum + order.payments.length,
    0,
  );
  const paymentIds = await reserveIds(manager, 'payments', paymentCount);

  await insertChunks(
    manager,
    Order,
    plan.orders.map((order, index) => ({
      id: orderIds[index],
      userId: userIds[order.customerIndex],
      status: order.status,
      subtotalPrice: order.subtotalPrice,
      discountPrice: order.discountPrice,
      totalPrice: order.totalPrice,
      couponCode: order.couponCode,
      couponType: order.couponType,
      couponValue: order.couponValue,
      shippingAddress: plan.customers[order.customerIndex].address,
      createdAt: wall(order.createdAt),
      updatedAt: wall(order.updatedAt),
    })),
  );
  await insertChunks(
    manager,
    OrderItem,
    plan.orders.flatMap((order, index) =>
      order.items.map((item) => ({
        orderId: orderIds[index],
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.price,
      })),
    ),
  );

  const paymentRows: Array<QueryDeepPartialEntity<Payment>> = [];
  const eventRows: Array<QueryDeepPartialEntity<PaymentEvent>> = [];
  let nextPayment = 0;
  plan.orders.forEach((order, index) => {
    for (const payment of order.payments) {
      const id = paymentIds[nextPayment];
      nextPayment += 1;
      const providerPaymentId = `demo_payment_${id}`;
      paymentRows.push({
        id,
        orderId: orderIds[index],
        provider: HISTORY_PAYMENT_PROVIDER,
        providerPaymentId,
        idempotencyKey: `${HISTORY_PAYMENT_KEY_PREFIX}${order.key}-${payment.attempt}`,
        amount: payment.amount,
        currency: DEFAULT_PAYMENT_CURRENCY,
        status: payment.status,
        failureCode: payment.failureCode,
        failureMessage: payment.failureMessage,
        createdAt: wall(payment.createdAt),
        updatedAt: wall(payment.updatedAt),
        succeededAt: payment.succeededAt ? wall(payment.succeededAt) : null,
      });
      for (const event of payment.events) {
        eventRows.push({
          paymentId: id,
          provider: HISTORY_PAYMENT_PROVIDER,
          providerEventId: `demo:${id}:${event.kind}`,
          providerPaymentId,
          eventType: event.eventType,
          processingStatus: event.processingStatus,
          processingMessage: event.processingMessage,
          createdAt: wall(event.createdAt),
          processedAt: wall(event.processedAt),
          resolvedAt: event.resolution
            ? wall(event.resolution.resolvedAt)
            : null,
          // The first admin account of the database, never a new one. Without
          // an admin the event is resolved with no person recorded.
          resolvedByUserId: event.resolution ? adminId : null,
          resolutionNote: event.resolution?.note ?? null,
        });
      }
    }
  });
  await insertChunks(manager, Payment, paymentRows);
  await insertChunks(manager, PaymentEvent, eventRows);

  await insertChunks(
    manager,
    ProductReview,
    plan.reviews.map((review) => ({
      userId: userIds[review.customerIndex],
      productId: review.productId,
      rating: review.rating,
      title: review.title,
      body: review.body,
      isVisible: true,
      createdAt: wall(review.createdAt),
      updatedAt: wall(review.createdAt),
    })),
  );

  return reserveStockForPendingOrders(manager, plan);
}

// Pending orders hold their units, as checkout does. The plan only picked
// variants that had enough, and the update refuses to go below zero.
async function reserveStockForPendingOrders(
  manager: EntityManager,
  plan: HistoryPlan,
): Promise<number> {
  const reserved = new Map<number, number>();
  for (const order of plan.orders) {
    if (order.status !== OrderStatus.PENDING) continue;
    for (const item of order.items) {
      reserved.set(
        item.variantId,
        (reserved.get(item.variantId) ?? 0) + item.quantity,
      );
    }
  }
  let units = 0;
  for (const [variantId, quantity] of [...reserved].sort(([a], [b]) => a - b)) {
    const result = await manager
      .createQueryBuilder()
      .update(ProductVariant)
      .set({ stock: () => `"stock" - ${Math.trunc(quantity)}` })
      .where('"id" = :variantId AND "stock" >= :quantity', {
        variantId,
        quantity,
      })
      .execute();
    if (result.affected !== 1) {
      throw new Error(
        `Variant ${variantId} no longer has ${quantity} unit(s) in stock for a pending order`,
      );
    }
    units += quantity;
  }
  return units;
}

async function reserveIds(
  manager: EntityManager,
  table: string,
  count: number,
): Promise<number[]> {
  if (count === 0) return [];
  const rows = await manager.query<Array<{ id: number }>>(
    `SELECT nextval(pg_get_serial_sequence($1, 'id'))::int AS id FROM generate_series(1, $2)`,
    [table, count],
  );
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

async function insertChunks<Entity extends object>(
  manager: EntityManager,
  entity: new () => Entity,
  rows: ReadonlyArray<QueryDeepPartialEntity<Entity>>,
): Promise<void> {
  if (rows.length === 0) return;
  // The column list is explicit because, without one, TypeORM leaves out an
  // auto-increment id even when the row carries it, and these rows carry the
  // ids that other rows point at. Every row of a table has the same keys.
  const columns = Object.keys(rows[0]);
  for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
    await manager
      .createQueryBuilder()
      .insert()
      .into(entity, columns)
      .values(rows.slice(index, index + INSERT_CHUNK_SIZE) as never)
      .execute();
  }
}
