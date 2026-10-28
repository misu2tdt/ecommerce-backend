import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { OrderExpiryService } from '../../src/orders/order-expiry.service';
import { OrdersService } from '../../src/orders/orders.service';
import { PaymentEventType } from '../../src/payments/entities/payment-event-type.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { PaymentsService } from '../../src/payments/payments.service';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import {
  createAddress,
  createCategory,
  createVariant,
} from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const LIST = '/admin/payments/reconciliation';
const resolveUrl = (eventId: number | string) => `${LIST}/${eventId}/resolve`;
const REFUND_ACTION =
  'Refund or manually fulfil: success after the order was cancelled';
const STOCK = 5;
const QUANTITY = 2;

interface ListBody {
  items: Array<{
    id: number;
    createdAt: string;
    eventType: string;
    processingMessage: string | null;
    provider: string;
    providerPaymentId: string;
    payment: { id: number; status: string; amount: number; currency: string };
    order: { id: number; status: string; userId: number };
    suggestedAction: string;
    resolvedAt: string | null;
    resolvedByUserId: number | null;
    resolutionNote: string | null;
  }>;
  page: number;
  limit: number;
  total: number;
}

describe('Payment reconciliation for admins (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let orders: OrdersService;
  let payments: PaymentsService;
  let admin: User;
  let customer: User;
  let adminToken: string;
  let customerToken: string;
  let eventCounter = 0;

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
    orders = app.get(OrdersService);
    payments = app.get(PaymentsService);
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    admin = await createUser('reconciliation-admin', UserRole.ADMIN);
    customer = await createUser('reconciliation-customer', UserRole.USER);
    adminToken = await tokenFor(admin);
    customerToken = await tokenFor(customer);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  describe('access control', () => {
    it('answers 401 without a token on both endpoints', async () => {
      await request(app.getHttpServer()).get(LIST).expect(401);
      await request(app.getHttpServer())
        .post(resolveUrl(1))
        .send({ note: 'handled' })
        .expect(401);
    });

    it('answers 403 for a non-admin on both endpoints', async () => {
      await request(app.getHttpServer())
        .get(LIST)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .post(resolveUrl(1))
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ note: 'handled' })
        .expect(403);
    });
  });

  describe('listing', () => {
    it('returns only unresolved requires_reconciliation events, newest first, with pagination', async () => {
      const { payment } = await cancelledOrderWithPayment('list-main');
      const base = Date.parse('2026-01-01T00:00:00Z');
      const created: number[] = [];
      for (let index = 0; index < 25; index += 1)
        created.push(
          await insertEvent(payment, {
            createdAt: new Date(base + index * 60_000),
          }),
        );
      for (let index = 0; index < 3; index += 1)
        await insertEvent(payment, {
          processingStatus: 'processed',
          createdAt: new Date(base + 99 * 60_000),
        });
      const resolvedIds = [
        await insertEvent(payment, { resolvedBy: admin.id }),
        await insertEvent(payment, { resolvedBy: admin.id }),
      ];

      const first = await getList('?page=1&limit=20');
      const second = await getList('?page=2&limit=20');
      const defaults = await getList('');

      expect(first).toMatchObject({ page: 1, limit: 20, total: 25 });
      expect(first.items.map((item) => item.id)).toEqual(
        [...created].reverse().slice(0, 20),
      );
      expect(second).toMatchObject({ page: 2, limit: 20, total: 25 });
      expect(second.items.map((item) => item.id)).toEqual(
        [...created].reverse().slice(20),
      );
      expect(defaults).toMatchObject({ page: 1, limit: 20, total: 25 });
      const everyId = [...first.items, ...second.items].map((item) => item.id);
      for (const id of resolvedIds) expect(everyId).not.toContain(id);
    });

    it('filters by status=resolved, unresolved and all', async () => {
      const { payment } = await cancelledOrderWithPayment('list-status');
      const open = await insertEvent(payment, {});
      const done = await insertEvent(payment, { resolvedBy: admin.id });
      await insertEvent(payment, { processingStatus: 'processed' });

      const unresolved = await getList('?status=unresolved');
      const resolved = await getList('?status=resolved');
      const all = await getList('?status=all');

      expect(unresolved.items.map((item) => item.id)).toEqual([open]);
      expect(resolved.items.map((item) => item.id)).toEqual([done]);
      expect(resolved.total).toBe(1);
      expect(all.total).toBe(2);
      expect(all.items.map((item) => item.id).sort()).toEqual(
        [open, done].sort(),
      );
    });

    it('describes each event with its payment, order and a suggested action', async () => {
      const cancelled = await cancelledOrderWithPayment('list-shape');
      const succeededLate = await insertEvent(cancelled.payment, {
        eventType: 'succeeded',
        message:
          'Provider success conflicts with terminal Payment or non-pending Order',
      });
      const paid = await cancelledOrderWithPayment('list-shape-failure', {
        orderStatus: 'confirmed',
        paymentStatus: 'succeeded',
      });
      const failedLate = await insertEvent(paid.payment, {
        eventType: 'failed',
        message: 'Provider failure arrived after success',
      });

      const body = await getList('');
      const late = body.items.find((item) => item.id === succeededLate);
      const failure = body.items.find((item) => item.id === failedLate);

      expect(late).toMatchObject({
        id: succeededLate,
        eventType: 'succeeded',
        processingMessage:
          'Provider success conflicts with terminal Payment or non-pending Order',
        provider: 'fake',
        providerPaymentId: cancelled.payment.providerPaymentId,
        payment: {
          id: cancelled.payment.id,
          status: 'cancelled',
          amount: 400_000,
          currency: 'VND',
        },
        order: {
          id: cancelled.order.id,
          status: 'cancelled',
          userId: cancelled.order.userId,
        },
        suggestedAction: REFUND_ACTION,
        resolvedAt: null,
        resolvedByUserId: null,
        resolutionNote: null,
      });
      expect(typeof late!.createdAt).toBe('string');
      expect(failure).toMatchObject({
        eventType: 'failed',
        suggestedAction: 'Review: failure arrived after success',
        order: { status: 'confirmed' },
      });
    });

    it.each(['limit=101', 'limit=0', 'page=0', 'status=bogus', 'page=1.5'])(
      'rejects invalid query %s with 400',
      async (query) => {
        await request(app.getHttpServer())
          .get(`${LIST}?${query}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(400);
      },
    );
  });

  describe('resolving', () => {
    it('records who handled it, once, without changing the order, payment or stock', async () => {
      const { payment, order, variantId } =
        await cancelledOrderWithPayment('resolve-once');
      const eventId = await insertEvent(payment, {});
      const before = await snapshot(order.id, payment.id, variantId);

      const response = await resolve(
        eventId,
        '  Refunded in the MoMo portal  ',
      ).expect(200);
      const resolved = response.body as ListBody['items'][number];

      expect(resolved).toMatchObject({
        id: eventId,
        resolvedByUserId: admin.id,
        resolutionNote: 'Refunded in the MoMo portal',
      });
      expect(typeof resolved.resolvedAt).toBe('string');
      expect(await snapshot(order.id, payment.id, variantId)).toEqual(before);

      const again = await resolve(eventId, 'Handled twice').expect(409);
      expect(JSON.stringify(again.body)).toContain('already resolved');
      const stored = await dataSource.query<{ resolutionNote: string }[]>(
        `SELECT "resolutionNote" FROM "payment_events" WHERE "id" = $1`,
        [eventId],
      );
      expect(stored[0].resolutionNote).toBe('Refunded in the MoMo portal');

      expect((await getList('')).total).toBe(0);
      expect(
        (await getList('?status=resolved')).items.map((item) => item.id),
      ).toEqual([eventId]);
    });

    it('answers 404 for an unknown event', async () => {
      await resolve(987_654, 'No such event').expect(404);
    });

    it('answers 409 for an event that did not need reconciliation', async () => {
      const { payment } = await cancelledOrderWithPayment('resolve-processed');
      const processed = await insertEvent(payment, {
        processingStatus: 'processed',
      });

      const response = await resolve(processed, 'Not needed').expect(409);

      expect(JSON.stringify(response.body)).toContain(
        'Only events that require reconciliation can be resolved',
      );
      const stored = await dataSource.query<{ resolvedAt: Date | null }[]>(
        `SELECT "resolvedAt" FROM "payment_events" WHERE "id" = $1`,
        [processed],
      );
      expect(stored[0].resolvedAt).toBeNull();
    });

    it.each([
      ['missing', {}],
      ['empty', { note: '' }],
      ['blank', { note: '    ' }],
      ['too short after trimming', { note: ' ab ' }],
      ['too long', { note: 'x'.repeat(501) }],
      ['not a string', { note: 42 }],
    ])('answers 400 for a note that is %s', async (_label, body) => {
      const { payment } = await cancelledOrderWithPayment('resolve-invalid');
      const eventId = await insertEvent(payment, {});

      await request(app.getHttpServer())
        .post(resolveUrl(eventId))
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body)
        .expect(400);
      const stored = await dataSource.query<{ resolvedAt: Date | null }[]>(
        `SELECT "resolvedAt" FROM "payment_events" WHERE "id" = $1`,
        [eventId],
      );
      expect(stored[0].resolvedAt).toBeNull();
    });
  });

  it('end to end: expired order, late success IPN, listed, resolved, order stays cancelled', async () => {
    const buyer = await createUser('reconciliation-buyer', UserRole.USER);
    const { order, variantId } = await checkout(buyer, 'e2e-scenario');
    const created = await payments.createForOrder(
      buyer.id,
      order.id,
      'e2e-scenario-key-1',
    );
    const stored = await dataSource
      .getRepository(Payment)
      .findOneByOrFail({ id: created.id });

    const sweep = await new OrderExpiryService(dataSource).expireOverdueOrders(
      new Date(Date.now() + 31 * 60_000),
    );
    expect(sweep.expired).toBe(1);
    const stockAfterExpiry = await stockOf(variantId);
    expect(stockAfterExpiry).toBe(STOCK);

    await payments.processEvent({
      provider: stored.provider,
      providerEventId: 'e2e-late-success',
      providerPaymentId: stored.providerPaymentId!,
      eventType: PaymentEventType.SUCCEEDED,
    });

    const listed = await getList('');
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      eventType: 'succeeded',
      suggestedAction: REFUND_ACTION,
      order: { id: order.id, status: 'cancelled', userId: buyer.id },
      payment: { id: created.id, status: 'cancelled' },
    });

    await resolve(
      listed.items[0].id,
      'Refunded manually in the MoMo portal',
    ).expect(200);

    expect((await orderOf(order.id)).status).toBe(OrderStatus.CANCELLED);
    expect(
      (
        await dataSource
          .getRepository(Payment)
          .findOneByOrFail({ id: created.id })
      ).status,
    ).toBe('cancelled');
    expect(await stockOf(variantId)).toBe(stockAfterExpiry);
    expect((await getList('')).total).toBe(0);
    expect((await getList('?status=resolved')).total).toBe(1);
  });

  // ---- helpers -----------------------------------------------------------

  async function getList(query: string): Promise<ListBody> {
    const response = await request(app.getHttpServer())
      .get(`${LIST}${query}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return response.body as ListBody;
  }

  function resolve(eventId: number | string, note: string) {
    return request(app.getHttpServer())
      .post(resolveUrl(eventId))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ note });
  }

  function createUser(suffix: string, role: UserRole) {
    return dataSource.getRepository(User).save({
      email: `${suffix}@reconciliation.test`,
      password: 'hash',
      role,
    });
  }

  function tokenFor(user: User) {
    return app
      .get(JwtService)
      .signAsync({ sub: user.id, email: user.email, role: user.role });
  }

  async function checkout(user: User, suffix: string) {
    const address = await createAddress(dataSource, user, suffix);
    const category = await createCategory(dataSource, suffix);
    const product = await dataSource.getRepository(Product).save({
      name: `Product ${suffix}`,
      slug: `product-${suffix}`,
      description: null,
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
      brandId: null,
    });
    const variant = await createVariant(dataSource, product, suffix, {
      price: 200_000,
      stock: STOCK,
    });
    const order = await orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: QUANTITY }],
    });
    return { order, variantId: variant.id };
  }

  // An order plus one payment, both forced into the given terminal states.
  async function cancelledOrderWithPayment(
    suffix: string,
    states: { orderStatus?: string; paymentStatus?: string } = {},
  ) {
    const { order, variantId } = await checkout(customer, suffix);
    await dataSource.query(
      `UPDATE "orders" SET "status" = $1 WHERE "id" = $2`,
      [states.orderStatus ?? 'cancelled', order.id],
    );
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "payments"
         ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status")
       VALUES ($1, 'fake', $2, $3, 400000, 'VND', $4)
       RETURNING "id"`,
      [
        order.id,
        `fake_payment_${suffix}`,
        `reconciliation-${suffix}`,
        states.paymentStatus ?? 'cancelled',
      ],
    );
    const payment = await dataSource
      .getRepository(Payment)
      .findOneByOrFail({ id: rows[0].id });
    return { order, variantId, payment };
  }

  async function insertEvent(
    payment: Payment,
    options: {
      eventType?: string;
      processingStatus?: string;
      message?: string;
      createdAt?: Date;
      resolvedBy?: number;
    },
  ) {
    eventCounter += 1;
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "payment_events"
         ("paymentId", "provider", "providerEventId", "providerPaymentId", "eventType",
          "processingStatus", "processingMessage", "createdAt",
          "resolvedAt", "resolvedByUserId", "resolutionNote")
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamp, now()),
               CASE WHEN $9::int IS NULL THEN NULL ELSE now() END, $9::int,
               CASE WHEN $9::int IS NULL THEN NULL ELSE 'handled by test' END)
       RETURNING "id"`,
      [
        payment.id,
        payment.provider,
        `event-${eventCounter}`,
        payment.providerPaymentId,
        options.eventType ?? 'succeeded',
        options.processingStatus ?? 'requires_reconciliation',
        options.message ??
          'Provider success conflicts with terminal Payment or non-pending Order',
        options.createdAt ?? null,
        options.resolvedBy ?? null,
      ],
    );
    return rows[0].id;
  }

  async function snapshot(
    orderId: number,
    paymentId: number,
    variantId: number,
  ) {
    return {
      order: (await orderOf(orderId)).status,
      payment: (
        await dataSource
          .getRepository(Payment)
          .findOneByOrFail({ id: paymentId })
      ).status,
      stock: await stockOf(variantId),
    };
  }

  function orderOf(id: number) {
    return dataSource.getRepository(Order).findOneByOrFail({ id });
  }

  async function stockOf(id: number) {
    return (
      await dataSource.getRepository(ProductVariant).findOneByOrFail({ id })
    ).stock;
  }
});
