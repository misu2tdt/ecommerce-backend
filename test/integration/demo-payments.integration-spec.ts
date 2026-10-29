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
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from '../../src/payments/entities/payment-event-type.enum';
import { PaymentEvent } from '../../src/payments/entities/payment-event.entity';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
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

const MINUTE = 60_000;
const STOCK = 5;
const QUANTITY = 2;
const TOTAL = 400_000;

interface CompletionBody {
  outcome: 'success' | 'failure' | 'cancel';
  result: 'applied' | 'already_applied' | 'recorded_for_review';
  payment: {
    id: number;
    provider: string;
    amount: number;
    currency: string;
    status: string;
    succeededAt: string | null;
  };
  order: { id: number; status: string };
}

describe('Demo payments (PostgreSQL, full HTTP stack)', () => {
  let dataSource: DataSource;
  let demoApp: INestApplication;
  let disabledApp: INestApplication;
  let orders: OrdersService;
  let customer: User;
  let stranger: User;
  let customerToken: string;
  let strangerToken: string;
  let counter = 0;

  async function startApp(paymentProvider: string | undefined) {
    if (paymentProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = paymentProvider;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    return app;
  }

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
    // PAYMENT_PROVIDER is read when the application starts, so each app gets
    // its own value. The default (unset) is momo, where the demo endpoint is off.
    disabledApp = await startApp(undefined);
    demoApp = await startApp('demo');
    orders = demoApp.get(OrdersService);
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    customer = await createUser('demo-customer');
    stranger = await createUser('demo-stranger');
    customerToken = await tokenFor(customer);
    strangerToken = await tokenFor(stranger);
  });

  afterAll(async () => {
    delete process.env.PAYMENT_PROVIDER;
    if (demoApp) await demoApp.close();
    if (disabledApp) await disabledApp.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  describe('when PAYMENT_PROVIDER is not demo', () => {
    it('answers 404 to everyone, even without a token or with a bad body', async () => {
      const server = disabledApp.getHttpServer();
      const url = '/payments/1/demo/complete';

      await request(server).post(url).send({ outcome: 'success' }).expect(404);
      await request(server)
        .post(url)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ outcome: 'success' })
        .expect(404);
      await request(server)
        .post(url)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ nonsense: true })
        .expect(404);
      await request(server)
        .post('/payments/not-a-number/demo/complete')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(404);
    });

    it('does not complete a payment even if a demo payment row exists', async () => {
      const fixture = await checkout(customer, 'disabled-row');
      const payment = await insertPayment(fixture.order.id, 'demo');

      await request(disabledApp.getHttpServer())
        .post(`/payments/${payment.id}/demo/complete`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ outcome: 'success' })
        .expect(404);

      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.PENDING,
      );
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);
    });
  });

  describe('creating a payment attempt in demo mode', () => {
    it('stores provider demo, derives amount and currency, and keeps the response shape', async () => {
      const fixture = await checkout(customer, 'create');

      const response = await createPayment(
        customerToken,
        fixture.order.id,
        'demo-create-key-001',
      ).expect(201);

      expect(response.body).toEqual({
        id: expect.any(Number),
        provider: 'demo',
        amount: TOTAL,
        currency: 'VND',
        status: 'processing',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        succeededAt: null,
      });
      expect(response.body).not.toHaveProperty('checkoutUrl');
      const stored = await paymentOf(response.body.id as number);
      expect(stored).toMatchObject({
        provider: 'demo',
        providerPaymentId: `demo_payment_${stored.id}`,
        amount: TOTAL,
        currency: 'VND',
        status: PaymentStatus.PROCESSING,
      });
    });

    it('keeps the same-key retry and the one-active-payment rules', async () => {
      const fixture = await checkout(customer, 'rules');
      const first = await createPayment(
        customerToken,
        fixture.order.id,
        'demo-rules-key-001',
      ).expect(201);
      const repeated = await createPayment(
        customerToken,
        fixture.order.id,
        'demo-rules-key-001',
      ).expect(201);
      expect(repeated.body.id).toBe(first.body.id);

      await createPayment(
        customerToken,
        fixture.order.id,
        'demo-rules-key-002',
      ).expect(409);
      expect(await dataSource.getRepository(Payment).count()).toBe(1);
    });
  });

  describe('access control', () => {
    it('answers 401 without a token', async () => {
      await request(demoApp.getHttpServer())
        .post('/payments/1/demo/complete')
        .send({ outcome: 'success' })
        .expect(401);
    });

    it('answers the same 404 for another customer, a missing payment and a MoMo payment', async () => {
      const fixture = await checkout(customer, 'access');
      const { body: demoPayment } = await createPayment(
        customerToken,
        fixture.order.id,
        'demo-access-key-001',
      ).expect(201);
      const other = await checkout(stranger, 'access-other');
      const momoPayment = await insertPayment(other.order.id, 'momo');

      const forStranger = await complete(
        strangerToken,
        demoPayment.id as number,
        'success',
      ).expect(404);
      const missing = await complete(strangerToken, 987_654, 'success').expect(
        404,
      );
      const notDemo = await complete(
        strangerToken,
        momoPayment.id,
        'success',
      ).expect(404);

      // Same answer for every case: nothing leaks about which ids exist.
      expect(forStranger.body).toEqual(missing.body);
      expect(notDemo.body).toEqual(missing.body);
      expect(await orderOf(fixture.order.id)).toMatchObject({
        status: OrderStatus.PENDING,
      });
      expect(await orderOf(other.order.id)).toMatchObject({
        status: OrderStatus.PENDING,
      });
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);
    });

    it('validates the request body and the id', async () => {
      const fixture = await checkout(customer, 'validation');
      const { body } = await createPayment(
        customerToken,
        fixture.order.id,
        'demo-validation-key-001',
      ).expect(201);

      await complete(customerToken, body.id as number, 'refund').expect(400);
      await request(demoApp.getHttpServer())
        .post(`/payments/${body.id}/demo/complete`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(400);
      await request(demoApp.getHttpServer())
        .post('/payments/abc/demo/complete')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ outcome: 'success' })
        .expect(400);
      expect((await paymentOf(body.id as number)).status).toBe(
        PaymentStatus.PROCESSING,
      );
    });
  });

  describe('outcomes', () => {
    it('success confirms the order through the shared path and leaves stock alone', async () => {
      const fixture = await checkout(customer, 'success');
      const payment = await demoPayment(fixture, 'demo-success-key-001');
      const stockAfterCheckout = await stockOf(fixture.variantId);

      const response = await complete(
        customerToken,
        payment.id,
        'success',
      ).expect(200);

      const body = response.body as CompletionBody;
      expect(body).toMatchObject({
        outcome: 'success',
        result: 'applied',
        payment: {
          id: payment.id,
          provider: 'demo',
          amount: TOTAL,
          currency: 'VND',
          status: 'succeeded',
        },
        order: { id: fixture.order.id, status: 'confirmed' },
      });
      expect(body.payment.succeededAt).not.toBeNull();
      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.SUCCEEDED,
      );
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CONFIRMED,
      );
      expect(await stockOf(fixture.variantId)).toBe(stockAfterCheckout);
      const events = await dataSource.getRepository(PaymentEvent).find();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        paymentId: payment.id,
        provider: 'demo',
        providerEventId: `demo:${payment.id}:success`,
        providerPaymentId: `demo_payment_${payment.id}`,
        eventType: PaymentEventType.SUCCEEDED,
        processingStatus: PaymentEventProcessingStatus.PROCESSED,
      });
      // A paid order cannot be paid again.
      await createPayment(
        customerToken,
        fixture.order.id,
        'demo-again-key-1',
      ).expect(409);
    });

    it('failure leaves the order pending and a new attempt works', async () => {
      const fixture = await checkout(customer, 'failure');
      const first = await demoPayment(fixture, 'demo-failure-key-001');

      const failed = await complete(customerToken, first.id, 'failure').expect(
        200,
      );

      expect(failed.body).toMatchObject({
        outcome: 'failure',
        result: 'applied',
        payment: { status: 'failed' },
        order: { status: 'pending' },
      });
      const stored = await paymentOf(first.id);
      expect(stored).toMatchObject({
        status: PaymentStatus.FAILED,
        failureCode: 'DEMO_FAILURE',
      });
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.PENDING,
      );

      const second = await demoPayment(fixture, 'demo-failure-key-002');
      expect(second.id).not.toBe(first.id);
      const paid = await complete(customerToken, second.id, 'success').expect(
        200,
      );
      expect(paid.body).toMatchObject({
        result: 'applied',
        order: { status: 'confirmed' },
      });
      expect(await dataSource.getRepository(Payment).count()).toBe(2);
    });

    it('cancel marks the payment cancelled, keeps the order pending and allows a retry', async () => {
      const fixture = await checkout(customer, 'cancel');
      const first = await demoPayment(fixture, 'demo-cancel-key-001');

      const cancelled = await complete(
        customerToken,
        first.id,
        'cancel',
      ).expect(200);

      expect(cancelled.body).toMatchObject({
        outcome: 'cancel',
        result: 'applied',
        payment: { status: 'cancelled' },
        order: { status: 'pending' },
      });
      expect((await paymentOf(first.id)).status).toBe(PaymentStatus.CANCELLED);
      const event = await dataSource
        .getRepository(PaymentEvent)
        .findOneByOrFail({ paymentId: first.id });
      expect(event).toMatchObject({
        eventType: PaymentEventType.FAILED,
        processingStatus: PaymentEventProcessingStatus.PROCESSED,
      });
      const retry = await demoPayment(fixture, 'demo-cancel-key-002');
      expect(retry.id).not.toBe(first.id);
    });

    it('ignores any amount from the client: the body is validated and the stored amount is used', async () => {
      const fixture = await checkout(customer, 'amount');
      const payment = await demoPayment(fixture, 'demo-amount-key-001');

      // The global validation pipe refuses unknown fields outright.
      await request(demoApp.getHttpServer())
        .post(`/payments/${payment.id}/demo/complete`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ outcome: 'success', amount: 1, currency: 'USD' })
        .expect(400);
      expect(await paymentOf(payment.id)).toMatchObject({
        status: PaymentStatus.PROCESSING,
        amount: TOTAL,
        currency: 'VND',
      });

      const response = await complete(
        customerToken,
        payment.id,
        'success',
      ).expect(200);
      expect(response.body).toMatchObject({
        payment: { amount: TOTAL, currency: 'VND' },
      });
      expect(await paymentOf(payment.id)).toMatchObject({
        amount: TOTAL,
        currency: 'VND',
      });
    });
  });

  describe('idempotency and races', () => {
    it('a repeated complete returns the same result and records one event', async () => {
      const fixture = await checkout(customer, 'double');
      const payment = await demoPayment(fixture, 'demo-double-key-001');

      const first = await complete(customerToken, payment.id, 'success').expect(
        200,
      );
      const second = await complete(
        customerToken,
        payment.id,
        'success',
      ).expect(200);

      expect(first.body).toMatchObject({ result: 'applied' });
      expect(second.body).toMatchObject({ result: 'already_applied' });
      expect(second.body.payment).toEqual(first.body.payment);
      expect(second.body.order).toEqual(first.body.order);
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
    });

    it('two concurrent identical completes apply once and record one event', async () => {
      const fixture = await checkout(customer, 'double-concurrent');
      const payment = await demoPayment(fixture, 'demo-double-key-002');

      const responses = await Promise.all([
        complete(customerToken, payment.id, 'success'),
        complete(customerToken, payment.id, 'success'),
      ]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(
        responses
          .map((response) => (response.body as CompletionBody).result)
          .sort(),
      ).toEqual(['already_applied', 'applied']);
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CONFIRMED,
      );
    });

    it('two concurrent completes with different outcomes: exactly one wins', async () => {
      for (let round = 0; round < 5; round += 1) {
        const fixture = await checkout(customer, `race-${round}`);
        const payment = await demoPayment(fixture, `demo-race-key-${round}-00`);

        const [success, failure] = await Promise.all([
          complete(customerToken, payment.id, 'success'),
          complete(customerToken, payment.id, 'failure'),
        ]);

        expect([success.status, failure.status]).toEqual([200, 200]);
        const results = [
          (success.body as CompletionBody).result,
          (failure.body as CompletionBody).result,
        ];
        expect(results.filter((result) => result === 'applied')).toHaveLength(
          1,
        );
        expect(
          results.filter((result) => result === 'recorded_for_review'),
        ).toHaveLength(1);

        const finalPayment = await paymentOf(payment.id);
        const finalOrder = await orderOf(fixture.order.id);
        if (finalPayment.status === PaymentStatus.SUCCEEDED) {
          expect(finalOrder.status).toBe(OrderStatus.CONFIRMED);
          expect((success.body as CompletionBody).result).toBe('applied');
        } else {
          expect(finalPayment.status).toBe(PaymentStatus.FAILED);
          expect(finalOrder.status).toBe(OrderStatus.PENDING);
          expect((failure.body as CompletionBody).result).toBe('applied');
        }
        // The losing outcome is kept for an admin, never silently applied.
        expect(
          await dataSource.getRepository(PaymentEvent).countBy({
            paymentId: payment.id,
            processingStatus:
              PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
          }),
        ).toBe(1);
      }
    });
  });

  describe('after the order expired', () => {
    it('a demo success is recorded for reconciliation exactly like a late provider success', async () => {
      const fixture = await checkout(customer, 'expired');
      const payment = await demoPayment(fixture, 'demo-expired-key-001');
      const expiry = new OrderExpiryService(dataSource);
      await expiry.expireOverdueOrders(new Date(Date.now() + 31 * MINUTE));
      const stockAfterExpiry = await stockOf(fixture.variantId);
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CANCELLED,
      );

      const response = await complete(
        customerToken,
        payment.id,
        'success',
      ).expect(200);

      expect(response.body).toMatchObject({
        outcome: 'success',
        result: 'recorded_for_review',
        order: { id: fixture.order.id, status: 'cancelled' },
        payment: { status: 'cancelled' },
      });
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CANCELLED,
      );
      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.CANCELLED,
      );
      expect(await stockOf(fixture.variantId)).toBe(stockAfterExpiry);
      const event = await dataSource
        .getRepository(PaymentEvent)
        .findOneByOrFail({ paymentId: payment.id });
      expect(event).toMatchObject({
        provider: 'demo',
        eventType: PaymentEventType.SUCCEEDED,
        processingStatus: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
        processingMessage:
          'Provider success conflicts with terminal Payment or non-pending Order',
        resolvedAt: null,
      });
    });
  });

  // ---- helpers ----------------------------------------------------------

  function createUser(suffix: string) {
    counter += 1;
    return dataSource.getRepository(User).save({
      email: `${suffix}-${counter}@demo-payments.test`,
      password: 'hash',
      role: UserRole.USER,
    });
  }

  function tokenFor(user: User) {
    return demoApp
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

  function createPayment(token: string, orderId: number, key: string) {
    return request(demoApp.getHttpServer())
      .post(`/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key);
  }

  async function demoPayment(
    fixture: Awaited<ReturnType<typeof checkout>>,
    key: string,
  ) {
    const response = await createPayment(
      customerToken,
      fixture.order.id,
      key,
    ).expect(201);
    return paymentOf(response.body.id as number);
  }

  function complete(
    token: string,
    paymentId: number,
    outcome: 'success' | 'failure' | 'cancel' | 'refund',
  ) {
    return request(demoApp.getHttpServer())
      .post(`/payments/${paymentId}/demo/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome });
  }

  // A payment row with a given provider, without going through the API.
  async function insertPayment(orderId: number, provider: string) {
    counter += 1;
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "payments"
         ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status")
       VALUES ($1, $2, $3, $4, ${TOTAL}, 'VND', 'processing')
       RETURNING "id"`,
      [
        orderId,
        provider,
        `${provider}_row_${counter}`,
        `row-key-${counter}-xx`,
      ],
    );
    return paymentOf(rows[0].id);
  }

  function paymentOf(id: number) {
    return dataSource.getRepository(Payment).findOneByOrFail({ id });
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
