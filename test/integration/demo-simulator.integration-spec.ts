import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { OrdersService } from '../../src/orders/orders.service';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from '../../src/payments/entities/payment-event-type.enum';
import { PaymentEvent } from '../../src/payments/entities/payment-event.entity';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { DEMO_SCENARIOS } from '../../src/payments/demo/demo-scenarios';
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

const STOCK = 5;
const QUANTITY = 2;
const TOTAL = 400_000;

interface Step {
  step: number;
  sent: string;
  result: string;
  httpStatus: number;
  detail: string;
}

interface SimulationBody {
  scenario: string;
  outcome: 'completed' | 'scheduled';
  explanation: string;
  steps: Step[];
  payment: {
    id: number;
    provider: string;
    amount: number;
    currency: string;
    status: string;
  };
  order: { id: number; status: string };
}

describe('Demo payment simulator (PostgreSQL, full HTTP stack)', () => {
  let dataSource: DataSource;
  let demoApp: INestApplication;
  let momoApp: INestApplication;
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
    // PAYMENT_PROVIDER is read when the application starts, so each app gets its
    // own value. The default (unset) is momo, where the simulator is off.
    momoApp = await startApp(undefined);
    demoApp = await startApp('demo');
    orders = demoApp.get(OrdersService);
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    customer = await createUser('sim-customer');
    stranger = await createUser('sim-stranger');
    customerToken = await tokenFor(customer);
    strangerToken = await tokenFor(stranger);
  });

  afterAll(async () => {
    delete process.env.PAYMENT_PROVIDER;
    if (demoApp) await demoApp.close();
    if (momoApp) await momoApp.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  describe('when PAYMENT_PROVIDER is not demo', () => {
    it('answers 404 on every simulator route to everyone, whatever is sent', async () => {
      const fixture = await checkout(customer, 'momo-mode');
      const payment = await insertPayment(fixture.order.id, 'demo');
      const server = momoApp.getHttpServer();

      for (const scenario of DEMO_SCENARIOS) {
        const url = `/payments/${payment.id}/demo/simulate`;
        await request(server).post(url).send({ scenario }).expect(404);
        await request(server)
          .post(url)
          .set('Authorization', `Bearer ${customerToken}`)
          .send({ scenario })
          .expect(404);
      }
      await request(server)
        .post(`/payments/${payment.id}/demo/simulate`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ nonsense: true })
        .expect(404);
      await request(server)
        .post('/payments/not-a-number/demo/simulate')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({})
        .expect(404);
      await request(server)
        .post('/payments/987654/demo/simulate')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ scenario: 'success' })
        .expect(404);

      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.PENDING,
      );
      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.PROCESSING,
      );
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);
    });
  });

  describe('access control and validation', () => {
    it('answers 401 without a token', async () => {
      await request(demoApp.getHttpServer())
        .post('/payments/1/demo/simulate')
        .send({ scenario: 'success' })
        .expect(401);
    });

    it('answers the same 404 for another customer, a missing payment and a MoMo payment', async () => {
      const fixture = await checkout(customer, 'access');
      const demo = await demoPayment(fixture, 'sim-access-key-001');
      const other = await checkout(stranger, 'access-other');
      const momo = await insertPayment(other.order.id, 'momo');

      const forStranger = await simulate(
        strangerToken,
        demo.id,
        'success',
      ).expect(404);
      const missing = await simulate(strangerToken, 987_654, 'success').expect(
        404,
      );
      const notDemo = await simulate(strangerToken, momo.id, 'success').expect(
        404,
      );

      expect(forStranger.body).toEqual(missing.body);
      expect(notDemo.body).toEqual(missing.body);
      for (const scenario of DEMO_SCENARIOS) {
        await simulate(strangerToken, demo.id, scenario).expect(404);
      }
      expect(await orderOf(fixture.order.id)).toMatchObject({
        status: OrderStatus.PENDING,
      });
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);
    });

    it('validates the scenario, extra fields and the id', async () => {
      const fixture = await checkout(customer, 'validation');
      const payment = await demoPayment(fixture, 'sim-validation-key-1');
      const url = `/payments/${payment.id}/demo/simulate`;
      const authed = () =>
        request(demoApp.getHttpServer())
          .post(url)
          .set('Authorization', `Bearer ${customerToken}`);

      await authed().send({ scenario: 'refund' }).expect(400);
      await authed().send({}).expect(400);
      await authed().send({ scenario: 'success', amount: 1 }).expect(400);
      await authed()
        .send({ scenario: ['success'] })
        .expect(400);
      await request(demoApp.getHttpServer())
        .post('/payments/abc/demo/simulate')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ scenario: 'success' })
        .expect(400);
      await request(demoApp.getHttpServer())
        .post('/payments/99999999999/demo/simulate')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ scenario: 'success' })
        .expect(400);

      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.PROCESSING,
      );
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);
    });

    it('answers 409 for a payment that is already finished, for every scenario', async () => {
      const fixture = await checkout(customer, 'finished');
      const payment = await demoPayment(fixture, 'sim-finished-key-001');
      await simulate(customerToken, payment.id, 'success').expect(200);

      for (const scenario of DEMO_SCENARIOS) {
        const response = await simulate(
          customerToken,
          payment.id,
          scenario,
        ).expect(409);
        expect((response.body as { message: string }).message).toMatch(
          /already finished/,
        );
      }
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
    });
  });

  describe('success, declined and cancelled', () => {
    it('success: the answer, the payment, the order and one stored event', async () => {
      const fixture = await checkout(customer, 'success');
      const payment = await demoPayment(fixture, 'sim-success-key-001');

      const response = await simulate(
        customerToken,
        payment.id,
        'success',
      ).expect(200);

      const body = response.body as SimulationBody;
      expect(body).toEqual({
        scenario: 'success',
        outcome: 'completed',
        explanation: expect.stringContaining('signed'),
        steps: [
          {
            step: 1,
            sent: 'a signed success event',
            result: 'applied',
            httpStatus: 200,
            detail: expect.any(String),
          },
        ],
        payment: {
          id: payment.id,
          provider: 'demo',
          amount: TOTAL,
          currency: 'VND',
          status: 'succeeded',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          succeededAt: expect.any(String),
        },
        order: { id: fixture.order.id, status: 'confirmed' },
      });
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CONFIRMED,
      );
      const events = await dataSource.getRepository(PaymentEvent).find();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: 'demo',
        providerEventId: `demo:${payment.id}:success`,
        eventType: PaymentEventType.SUCCEEDED,
        processingStatus: PaymentEventProcessingStatus.PROCESSED,
      });
    });

    it('declined: the payment fails, the order stays pending and a new attempt works', async () => {
      const fixture = await checkout(customer, 'declined');
      const payment = await demoPayment(fixture, 'sim-declined-key-001');

      const response = await simulate(
        customerToken,
        payment.id,
        'declined',
      ).expect(200);

      expect(response.body).toMatchObject({
        scenario: 'declined',
        outcome: 'completed',
        steps: [{ step: 1, result: 'applied' }],
        payment: { status: 'failed' },
        order: { status: 'pending' },
      });
      expect(await paymentOf(payment.id)).toMatchObject({
        status: PaymentStatus.FAILED,
        failureCode: 'DEMO_FAILURE',
      });
      const retry = await demoPayment(fixture, 'sim-declined-key-002');
      expect(retry.id).not.toBe(payment.id);
    });

    it('cancelled: the payment is cancelled and the order stays pending', async () => {
      const fixture = await checkout(customer, 'cancelled');
      const payment = await demoPayment(fixture, 'sim-cancelled-key-001');

      const response = await simulate(
        customerToken,
        payment.id,
        'cancelled',
      ).expect(200);

      expect(response.body).toMatchObject({
        scenario: 'cancelled',
        steps: [{ step: 1, result: 'applied' }],
        payment: { status: 'cancelled' },
        order: { status: 'pending' },
      });
      expect((await paymentOf(payment.id)).failureCode).toBe('DEMO_CANCELLED');
    });
  });

  describe('success_twice', () => {
    it('applies once: the second delivery is a duplicate and only one event is stored', async () => {
      const fixture = await checkout(customer, 'twice');
      const payment = await demoPayment(fixture, 'sim-twice-key-001');

      const response = await simulate(
        customerToken,
        payment.id,
        'success_twice',
      ).expect(200);

      const body = response.body as SimulationBody;
      expect(body.steps.map((step) => step.result)).toEqual([
        'applied',
        'duplicate',
      ]);
      expect(body.steps.map((step) => step.step)).toEqual([1, 2]);
      expect(body.payment.status).toBe('succeeded');
      expect(body.order.status).toBe('confirmed');
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
    });

    it('two simulations at the same moment still apply once', async () => {
      const fixture = await checkout(customer, 'twice-concurrent');
      const payment = await demoPayment(fixture, 'sim-twice-key-002');

      const responses = await Promise.all([
        simulate(customerToken, payment.id, 'success'),
        simulate(customerToken, payment.id, 'success'),
      ]);

      // One of them may arrive after the payment is finished (409).
      for (const response of responses)
        expect([200, 409]).toContain(response.status);
      expect(responses.some((response) => response.status === 200)).toBe(true);
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CONFIRMED,
      );
    });
  });

  describe('success_after_expiry', () => {
    it('forces the expiry of this order only, restores stock and queues one event for review', async () => {
      const fixture = await checkout(customer, 'expiry');
      const bystander = await checkout(stranger, 'expiry-bystander');
      const payment = await demoPayment(fixture, 'sim-expiry-key-001');
      expect(await stockOf(fixture.variantId)).toBe(STOCK - QUANTITY);

      const response = await simulate(
        customerToken,
        payment.id,
        'success_after_expiry',
      ).expect(200);

      const body = response.body as SimulationBody;
      expect(body.steps.map((step) => step.result)).toEqual([
        'expiry_forced',
        'recorded_for_review',
      ]);
      expect(body.steps[0].sent).toMatch(/forced, not waited for/);
      expect(body.explanation).toMatch(/forced, not waited for/);
      expect(body.payment.status).toBe('cancelled');
      expect(body.order).toEqual({
        id: fixture.order.id,
        status: 'cancelled',
      });
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CANCELLED,
      );
      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.CANCELLED,
      );
      expect(await stockOf(fixture.variantId)).toBe(STOCK);
      const events = await dataSource.getRepository(PaymentEvent).find();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: 'demo',
        eventType: PaymentEventType.SUCCEEDED,
        processingStatus: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
        resolvedAt: null,
      });
      // Another customer's pending order is not touched.
      expect((await orderOf(bystander.order.id)).status).toBe(
        OrderStatus.PENDING,
      );
      expect(await stockOf(bystander.variantId)).toBe(STOCK - QUANTITY);
    });

    it('is refused for a payment older than 15 minutes, before anything changes', async () => {
      const fixture = await checkout(customer, 'expiry-old');
      const payment = await demoPayment(fixture, 'sim-expiry-key-002');
      await dataSource.query(
        `UPDATE "payments" SET "createdAt" = now() - interval '16 minutes' WHERE "id" = $1`,
        [payment.id],
      );

      const response = await simulate(
        customerToken,
        payment.id,
        'success_after_expiry',
      ).expect(409);

      expect((response.body as { message: string }).message).toMatch(
        /last 15 minutes/,
      );
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.PENDING,
      );
      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.PROCESSING,
      );
      expect(await stockOf(fixture.variantId)).toBe(STOCK - QUANTITY);
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);
    });

    it('still works at 14 minutes', async () => {
      const fixture = await checkout(customer, 'expiry-14');
      const payment = await demoPayment(fixture, 'sim-expiry-key-003');
      await dataSource.query(
        `UPDATE "payments" SET "createdAt" = now() - interval '14 minutes' WHERE "id" = $1`,
        [payment.id],
      );

      await simulate(customerToken, payment.id, 'success_after_expiry').expect(
        200,
      );
    });

    it('is refused when 12 or more events are unresolved, and allowed with 11', async () => {
      const holder = await checkout(stranger, 'cap-holder');
      const held = await insertPayment(holder.order.id, 'demo');
      await insertUnresolvedEvents(held.id, 11);
      // Resolved events do not count.
      await insertResolvedEvents(held.id, 4);

      const allowedFixture = await checkout(customer, 'cap-allowed');
      const allowedPayment = await demoPayment(
        allowedFixture,
        'sim-cap-key-001',
      );
      await simulate(
        customerToken,
        allowedPayment.id,
        'success_after_expiry',
      ).expect(200);
      expect(await unresolvedCount()).toBe(12);

      const refusedFixture = await checkout(customer, 'cap-refused');
      const refusedPayment = await demoPayment(
        refusedFixture,
        'sim-cap-key-002',
      );
      const stockBefore = await stockOf(refusedFixture.variantId);
      const response = await simulate(
        customerToken,
        refusedPayment.id,
        'success_after_expiry',
      ).expect(409);

      expect((response.body as { message: string }).message).toMatch(
        /reconciliation queue already holds 12 unresolved events/,
      );
      // Refused before the order was touched.
      expect((await orderOf(refusedFixture.order.id)).status).toBe(
        OrderStatus.PENDING,
      );
      expect(await stockOf(refusedFixture.variantId)).toBe(stockBefore);
      expect(await unresolvedCount()).toBe(12);
      // The other scenarios are not paused.
      await simulate(customerToken, refusedPayment.id, 'declined').expect(200);
    });
  });

  describe('delayed_success', () => {
    it('answers at once as scheduled, keeps the payment processing, then delivers the event', async () => {
      const fixture = await checkout(customer, 'delayed');
      const payment = await demoPayment(fixture, 'sim-delayed-key-001');

      const response = await simulate(
        customerToken,
        payment.id,
        'delayed_success',
      ).expect(200);

      const body = response.body as SimulationBody;
      expect(body.outcome).toBe('scheduled');
      expect(body.steps).toEqual([
        expect.objectContaining({ step: 1, result: 'scheduled' }),
      ]);
      expect(body.payment.status).toBe('processing');
      expect(body.order.status).toBe('pending');
      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.PROCESSING,
      );
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);

      // The event is delivered about 10 seconds later.
      const deadline = Date.now() + 15_000;
      while (
        (await paymentOf(payment.id)).status === PaymentStatus.PROCESSING &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 250));

      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.SUCCEEDED,
      );
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CONFIRMED,
      );
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
    }, 30_000);
  });

  describe('invalid_signature', () => {
    it('is rejected with 401 inside the answer, and nothing is written', async () => {
      const fixture = await checkout(customer, 'invalid');
      const payment = await demoPayment(fixture, 'sim-invalid-key-001');

      const response = await simulate(
        customerToken,
        payment.id,
        'invalid_signature',
      ).expect(200);

      const body = response.body as SimulationBody;
      expect(body.steps).toEqual([
        {
          step: 1,
          sent: 'a success event that was changed after it was signed',
          result: 'rejected_invalid_signature',
          httpStatus: 401,
          detail: expect.any(String),
        },
      ]);
      expect(body.payment.status).toBe('processing');
      expect(body.order.status).toBe('pending');
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);
      expect((await paymentOf(payment.id)).status).toBe(
        PaymentStatus.PROCESSING,
      );
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.PENDING,
      );
    });
  });

  describe('the existing complete route', () => {
    it('still works, now through the signed pipeline', async () => {
      const fixture = await checkout(customer, 'complete');
      const payment = await demoPayment(fixture, 'sim-complete-key-001');

      const first = await request(demoApp.getHttpServer())
        .post(`/payments/${payment.id}/demo/complete`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ outcome: 'success' })
        .expect(200);
      const second = await request(demoApp.getHttpServer())
        .post(`/payments/${payment.id}/demo/complete`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ outcome: 'success' })
        .expect(200);

      expect(first.body).toMatchObject({
        outcome: 'success',
        result: 'applied',
        order: { status: 'confirmed' },
      });
      expect(second.body).toMatchObject({ result: 'already_applied' });
      expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
    });
  });

  describe('rate limit', () => {
    it('allows 20 simulations a minute per user, then answers 429', async () => {
      const fixture = await checkout(customer, 'throttle');
      const payment = await demoPayment(fixture, 'sim-throttle-key-001');

      for (let index = 0; index < 20; index += 1) {
        await simulate(customerToken, payment.id, 'invalid_signature').expect(
          200,
        );
      }
      await simulate(customerToken, payment.id, 'invalid_signature').expect(
        429,
      );
      // Another user has a bucket of their own.
      const other = await checkout(stranger, 'throttle-other');
      const otherPayment = await insertPaymentFor(
        other,
        'sim-throttle-key-002',
        strangerToken,
      );
      await simulate(
        strangerToken,
        otherPayment.id,
        'invalid_signature',
      ).expect(200);
    });
  });

  // ---- helpers ----------------------------------------------------------

  function createUser(suffix: string) {
    counter += 1;
    return dataSource.getRepository(User).save({
      email: `${suffix}-${counter}@demo-simulator.test`,
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

  async function insertPaymentFor(
    fixture: Awaited<ReturnType<typeof checkout>>,
    key: string,
    token: string,
  ) {
    const response = await createPayment(token, fixture.order.id, key).expect(
      201,
    );
    return paymentOf(response.body.id as number);
  }

  function simulate(token: string, paymentId: number, scenario: string) {
    return request(demoApp.getHttpServer())
      .post(`/payments/${paymentId}/demo/simulate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ scenario });
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

  async function insertUnresolvedEvents(paymentId: number, count: number) {
    for (let index = 0; index < count; index += 1) {
      counter += 1;
      await dataSource.query(
        `INSERT INTO "payment_events"
           ("paymentId", "provider", "providerEventId", "providerPaymentId", "eventType", "processingStatus")
         VALUES ($1, 'demo', $2, 'demo_row', 'succeeded', 'requires_reconciliation')`,
        [paymentId, `seeded:${counter}`],
      );
    }
  }

  async function insertResolvedEvents(paymentId: number, count: number) {
    for (let index = 0; index < count; index += 1) {
      counter += 1;
      await dataSource.query(
        `INSERT INTO "payment_events"
           ("paymentId", "provider", "providerEventId", "providerPaymentId", "eventType", "processingStatus", "resolvedAt")
         VALUES ($1, 'demo', $2, 'demo_row', 'succeeded', 'requires_reconciliation', now())`,
        [paymentId, `seeded-resolved:${counter}`],
      );
    }
  }

  function unresolvedCount() {
    return dataSource
      .getRepository(PaymentEvent)
      .createQueryBuilder('event')
      .where('event.processingStatus = :status', {
        status: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
      })
      .andWhere('event.resolvedAt IS NULL')
      .getCount();
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
