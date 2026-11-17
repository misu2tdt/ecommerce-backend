// Run by time-convention.integration-spec.ts, once per process time zone, as a
// separate Jest process started with TZ=<zone>. It is not picked up by the
// normal integration run (its name does not match the test pattern).
//
// It drives the REAL code: the HTTP API, the order and payment services and the
// order expiry job, against the test database, and checks that every time the
// API reports is the real time whatever zone the Node.js process is in.
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
import { PaymentEvent } from '../../src/payments/entities/payment-event.entity';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { Product } from '../../src/products/entities/product.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import {
  createAddress,
  createCategory,
  createVariant,
} from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WINDOW_MINUTES = 30;
const EXPECTED_ZONE = process.env.EXPECTED_TZ;

interface OrderBody {
  id: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  paymentExpiresAt: string | null;
}
interface PaymentBody {
  id: number;
  status: string;
  createdAt: string;
  succeededAt: string | null;
}

describe(`times under a Node.js process in ${EXPECTED_ZONE ?? '(no zone given)'}`, () => {
  let dataSource: DataSource;
  let app: INestApplication;
  let orders: OrdersService;
  let user: User;
  let token: string;

  beforeAll(async () => {
    process.env.PAYMENT_PROVIDER = 'demo';
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
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    user = await dataSource.getRepository(User).save({
      email: 'zone-check@time-convention.test',
      password: 'hash',
      role: UserRole.USER,
    });
    token = await app
      .get(JwtService)
      .signAsync({ sub: user.id, email: user.email, role: user.role });
  });

  afterAll(async () => {
    delete process.env.PAYMENT_PROVIDER;
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('really runs in the requested zone', () => {
    expect(EXPECTED_ZONE).toBeDefined();
    const offsets: Record<string, number> = {
      UTC: 0,
      'Asia/Ho_Chi_Minh': -420,
    };
    expect(offsets[EXPECTED_ZONE!]).toBeDefined();
    // Not vacuous: the process zone is the one under test.
    expect(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()).toBe(
      offsets[EXPECTED_ZONE!],
    );
  });

  it('shows the real time for a new order and a paid payment', async () => {
    const before = Date.now();
    const order = await newOrder('paid');
    const payment = await startPayment(order.id, 'zone-paid-key-001');
    await completeDemoPayment(payment.id).expect(200);
    const after = Date.now();

    const detail = await getOrder(order.id);
    expect(detail.status).toBe('confirmed');
    // createdAt is the moment of the checkout, not seven hours away from it.
    expect(Date.parse(detail.createdAt)).toBeGreaterThanOrEqual(
      before - SECOND,
    );
    expect(Date.parse(detail.createdAt)).toBeLessThanOrEqual(after + SECOND);

    const [stored] = await listPayments(order.id);
    expect(stored.status).toBe('succeeded');
    const toSuccess =
      Date.parse(stored.succeededAt!) - Date.parse(stored.createdAt);
    // A small positive duration (a few moments), never about seven hours.
    expect(toSuccess).toBeGreaterThan(0);
    expect(toSuccess).toBeLessThan(MINUTE);
    expect(Date.parse(stored.succeededAt!)).toBeGreaterThanOrEqual(
      before - SECOND,
    );
    expect(Date.parse(stored.succeededAt!)).toBeLessThanOrEqual(after + SECOND);

    const event = await dataSource
      .getRepository(PaymentEvent)
      .findOneByOrFail({ paymentId: payment.id });
    const toProcessed =
      event.processedAt!.getTime() - event.createdAt.getTime();
    expect(toProcessed).toBeGreaterThanOrEqual(0);
    expect(toProcessed).toBeLessThan(MINUTE);
    expect(event.processedAt!.getTime()).toBeLessThanOrEqual(after + SECOND);
  });

  it('gives a new unpaid order a payment deadline in the future, one window ahead', async () => {
    const order = await newOrder('unpaid');

    const now = Date.now();
    const detail = await getOrder(order.id);
    expect(detail.paymentExpiresAt).not.toBeNull();
    const deadline = Date.parse(detail.paymentExpiresAt!);
    expect(deadline).toBeGreaterThan(now);
    expect(deadline).toBeGreaterThan(now + (WINDOW_MINUTES - 1) * MINUTE);
    expect(deadline).toBeLessThanOrEqual(
      now + WINDOW_MINUTES * MINUTE + SECOND,
    );
  });

  it('expires an order only after its window, by the same clock', async () => {
    const order = await newOrder('expiry');
    const expiry = new OrderExpiryService(dataSource);

    const early = await expiry.expireOverdueOrders();
    expect(early).toMatchObject({ scanned: 0, expired: 0 });
    expect((await orderOf(order.id)).status).toBe(OrderStatus.PENDING);

    const late = await expiry.expireOverdueOrders(
      new Date(Date.now() + (WINDOW_MINUTES + 1) * MINUTE),
    );
    expect(late).toMatchObject({ scanned: 1, expired: 1 });
    expect((await orderOf(order.id)).status).toBe(OrderStatus.CANCELLED);
  });

  // ---- helpers ----------------------------------------------------------

  async function newOrder(suffix: string) {
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
      stock: 5,
    });
    return orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 2 }],
    });
  }

  async function startPayment(orderId: number, key: string) {
    const response = await request(app.getHttpServer())
      .post(`/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .expect(201);
    return response.body as PaymentBody;
  }

  function completeDemoPayment(paymentId: number) {
    return request(app.getHttpServer())
      .post(`/payments/${paymentId}/demo/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'success' });
  }

  async function getOrder(id: number) {
    const response = await request(app.getHttpServer())
      .get(`/orders/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as OrderBody;
  }

  async function listPayments(orderId: number) {
    const response = await request(app.getHttpServer())
      .get(`/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as PaymentBody[];
  }

  function orderOf(id: number) {
    return dataSource.getRepository(Order).findOneByOrFail({ id });
  }
});
