import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { OrdersService } from '../../src/orders/orders.service';
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

const SECRET_PROVIDER_ID = 'SECRET-PROVIDER-PAYMENT-ID';
const SECRET_KEY = 'SECRET-IDEMPOTENCY-KEY';

const PAYMENT_KEYS = [
  'amount',
  'createdAt',
  'currency',
  'id',
  'provider',
  'status',
  'succeededAt',
  'updatedAt',
];

interface PaymentView {
  id: number;
  provider: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  succeededAt: string | null;
}

interface OrderBody {
  id: number;
  userId: number;
  status: string;
  totalPrice: number;
  items: unknown[];
  shippingAddress: Record<string, unknown>;
  payments?: PaymentView[];
}

describe('Admin order detail with payments (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let orders: OrdersService;
  let admin: User;
  let owner: User;
  let stranger: User;
  let adminToken: string;
  let ownerToken: string;
  let strangerToken: string;

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
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    admin = await createUser('order-payments-admin', UserRole.ADMIN);
    owner = await createUser('order-payments-owner', UserRole.USER);
    stranger = await createUser('order-payments-stranger', UserRole.USER);
    adminToken = await tokenFor(admin);
    ownerToken = await tokenFor(owner);
    strangerToken = await tokenFor(stranger);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  describe('access control', () => {
    it('answers 401 without a token', async () => {
      const { order } = await checkout(owner, 'access-401');

      await request(app.getHttpServer())
        .get(`/admin/orders/${order.id}`)
        .expect(401);
    });

    it('still refuses a non-admin, including the owner of the order', async () => {
      const { order } = await checkout(owner, 'access-403');

      for (const token of [ownerToken, strangerToken]) {
        await request(app.getHttpServer())
          .get(`/admin/orders/${order.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
      }
    });
  });

  describe('the payments array', () => {
    it("shows the payments of a customer's order to an admin who does not own it, newest first", async () => {
      const { order } = await checkout(owner, 'payments-list');
      const oldest = await insertPayment(order.id, 'oldest', {
        status: 'failed',
        createdAt: '2026-03-01T08:00:00Z',
      });
      const middle = await insertPayment(order.id, 'middle', {
        status: 'cancelled',
        createdAt: '2026-03-01T09:00:00Z',
      });
      const newest = await insertPayment(order.id, 'newest', {
        status: 'succeeded',
        createdAt: '2026-03-01T10:00:00Z',
        succeededAt: '2026-03-01T10:05:00Z',
      });
      await dataSource.query(
        `UPDATE "orders" SET "status" = 'confirmed' WHERE "id" = $1`,
        [order.id],
      );

      const body = await getOrder(order.id);

      expect(admin.id).not.toBe(body.userId);
      expect(body.payments!.map((payment) => payment.id)).toEqual([
        newest,
        middle,
        oldest,
      ]);
      expect(body.payments![0]).toMatchObject({
        id: newest,
        provider: 'fake',
        amount: 400_000,
        currency: 'VND',
        status: 'succeeded',
      });
      // Timestamps are stored without a zone, so only the gap is compared (the
      // absolute time depends on the zone of the test process).
      const newestView = body.payments![0];
      expect(
        Date.parse(newestView.succeededAt!) - Date.parse(newestView.createdAt),
      ).toBe(5 * 60_000);
      expect(Date.parse(newestView.createdAt)).toBeGreaterThan(
        Date.parse(body.payments![1].createdAt),
      );
      expect(body.payments![1]).toMatchObject({
        status: 'cancelled',
        succeededAt: null,
      });
      expect(body.payments![2]).toMatchObject({
        status: 'failed',
        succeededAt: null,
      });
      expect(typeof body.payments![0].updatedAt).toBe('string');
    });

    it('breaks a tie in creation time by id, newest first', async () => {
      const { order } = await checkout(owner, 'payments-tie');
      const same = '2026-03-02T08:00:00Z';
      const first = await insertPayment(order.id, 'tie-1', {
        status: 'failed',
        createdAt: same,
      });
      const second = await insertPayment(order.id, 'tie-2', {
        status: 'cancelled',
        createdAt: same,
      });

      const body = await getOrder(order.id);

      expect(body.payments!.map((payment) => payment.id)).toEqual([
        second,
        first,
      ]);
    });

    it('has exactly the customer-safe fields and never a secret', async () => {
      const { order } = await checkout(owner, 'payments-safe');
      await insertPayment(order.id, 'safe', {
        status: 'failed',
        providerPaymentId: SECRET_PROVIDER_ID,
        idempotencyKey: SECRET_KEY,
        failureCode: 'PROVIDER_SAID_NO',
        failureMessage: 'raw provider text',
      });

      const response = await request(app.getHttpServer())
        .get(`/admin/orders/${order.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const body = response.body as OrderBody;

      expect(Object.keys(body.payments![0]).sort()).toEqual(PAYMENT_KEYS);
      const text = JSON.stringify(response.body);
      for (const hidden of [
        SECRET_PROVIDER_ID,
        SECRET_KEY,
        'idempotencyKey',
        'providerPaymentId',
        'failureCode',
        'failureMessage',
        'PROVIDER_SAID_NO',
        'raw provider text',
        'checkoutUrl',
        'clientData',
      ]) {
        expect(text).not.toContain(hidden);
      }
    });

    it("is the same view the customer gets from the order's payment list", async () => {
      const { order } = await checkout(owner, 'payments-same-view');
      await insertPayment(order.id, 'same-1', { status: 'failed' });
      await insertPayment(order.id, 'same-2', { status: 'pending' });

      const adminView = (await getOrder(order.id)).payments;
      const customerView = (
        await request(app.getHttpServer())
          .get(`/orders/${order.id}/payments`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body as PaymentView[];

      expect(adminView).toEqual(customerView);
    });

    it('is an empty array for an order without payments', async () => {
      const { order } = await checkout(owner, 'payments-none');

      const response = await request(app.getHttpServer())
        .get(`/admin/orders/${order.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((response.body as OrderBody).payments).toEqual([]);
    });

    it("only holds the order's own payments", async () => {
      const mine = await checkout(owner, 'payments-mine');
      const theirs = await checkout(stranger, 'payments-theirs');
      const own = await insertPayment(mine.order.id, 'mine', {
        status: 'failed',
      });
      await insertPayment(theirs.order.id, 'theirs', { status: 'failed' });

      const body = await getOrder(mine.order.id);

      expect(body.payments!.map((payment) => payment.id)).toEqual([own]);
    });

    it('answers 404 for an unknown order and 400 for an id that is not a number', async () => {
      await request(app.getHttpServer())
        .get('/admin/orders/987654')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .get('/admin/orders/abc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });

  describe('what did not change', () => {
    it('keeps every existing field of the order detail', async () => {
      const { order } = await checkout(owner, 'unchanged-detail');
      await insertPayment(order.id, 'unchanged', { status: 'failed' });

      const fromAdmin = await getOrder(order.id);
      const fromOwner = (
        await request(app.getHttpServer())
          .get(`/orders/${order.id}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200)
      ).body as OrderBody;

      const { payments, ...adminFields } = fromAdmin;
      expect(payments).toHaveLength(1);
      expect(adminFields).toEqual(fromOwner);
      expect(adminFields).toMatchObject({
        id: order.id,
        userId: owner.id,
        status: 'pending',
      });
      expect(adminFields.items).toHaveLength(1);
      expect(adminFields.shippingAddress).toBeDefined();
    });

    it('does not add payments to the customer order, the order lists or the status change', async () => {
      const { order } = await checkout(owner, 'unchanged-others');
      await insertPayment(order.id, 'others', { status: 'failed' });

      const customerDetail = await request(app.getHttpServer())
        .get(`/orders/${order.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const customerList = await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const adminList = await request(app.getHttpServer())
        .get('/admin/orders')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const adminPage = await request(app.getHttpServer())
        .get('/admin/orders?page=1&limit=5')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const statusChange = await request(app.getHttpServer())
        .patch(`/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'cancelled' })
        .expect(200);

      expect(customerDetail.body).not.toHaveProperty('payments');
      for (const list of [customerList, adminList, adminPage]) {
        for (const entry of list.body as object[]) {
          expect(entry).not.toHaveProperty('payments');
        }
      }
      expect(statusChange.body).not.toHaveProperty('payments');
    });
  });

  // ---- helpers -----------------------------------------------------------

  async function getOrder(id: number): Promise<OrderBody> {
    const response = await request(app.getHttpServer())
      .get(`/admin/orders/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return response.body as OrderBody;
  }

  function createUser(suffix: string, role: UserRole) {
    return dataSource.getRepository(User).save({
      email: `${suffix}@order-payments.test`,
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
      stock: 5,
    });
    const order = await orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 2 }],
    });
    return { order };
  }

  async function insertPayment(
    orderId: number,
    suffix: string,
    options: {
      status: string;
      createdAt?: string;
      succeededAt?: string;
      providerPaymentId?: string;
      idempotencyKey?: string;
      failureCode?: string;
      failureMessage?: string;
    },
  ): Promise<number> {
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "payments"
         ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency",
          "status", "failureCode", "failureMessage", "createdAt", "succeededAt")
       VALUES ($1, 'fake', $2, $3, 400000, 'VND', $4, $5, $6,
               COALESCE($7::timestamp, now()), $8::timestamp)
       RETURNING "id"`,
      [
        orderId,
        options.providerPaymentId ?? `fake_payment_${orderId}_${suffix}`,
        options.idempotencyKey ?? `order-payments-${orderId}-${suffix}`,
        options.status,
        options.failureCode ?? null,
        options.failureMessage ?? null,
        options.createdAt ?? null,
        options.succeededAt ?? null,
      ],
    );
    return rows[0].id;
  }
});
