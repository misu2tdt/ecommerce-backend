import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request, { Test as SuperTest } from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { Product } from '../../src/products/entities/product.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import {
  INT_MAX,
  MAX_LINES,
  MAX_POSITION,
  MAX_PRICE_VND,
  MAX_QUANTITY_PER_LINE,
  MAX_STOCK,
} from '../../src/validation/limits';
import {
  createAddress,
  createCategory,
  createVariant,
} from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const HUGE = 99_999_999_999; // does not fit a PostgreSQL integer
const BEYOND = INT_MAX + 1;

describe('Limits on numbers sent by clients (PostgreSQL, full HTTP stack)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let customerToken: string;
  let adminToken: string;
  let customer: User;
  let variantId: number;
  let productId: number;
  let addressId: number;

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
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    const users = dataSource.getRepository(User);
    customer = await users.save({
      email: 'customer@input-limits.test',
      password: 'hash',
      role: UserRole.USER,
    });
    const admin = await users.save({
      email: 'admin@input-limits.test',
      password: 'hash',
      role: UserRole.ADMIN,
    });
    const jwt = app.get(JwtService);
    customerToken = await jwt.signAsync({
      sub: customer.id,
      email: customer.email,
      role: customer.role,
    });
    adminToken = await jwt.signAsync({
      sub: admin.id,
      email: admin.email,
      role: admin.role,
    });
    const category = await createCategory(dataSource, 'limits');
    const product = await dataSource.getRepository(Product).save({
      name: 'Limits product',
      slug: 'limits-product',
      description: null,
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
      brandId: null,
    });
    productId = product.id;
    variantId = (
      await createVariant(dataSource, product, 'limits', { stock: 500 })
    ).id;
    addressId = (await createAddress(dataSource, customer, 'limits')).id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  const http = () => request(app.getHttpServer());
  const asCustomer = (test: SuperTest) =>
    test.set('Authorization', `Bearer ${customerToken}`);
  const asAdmin = (test: SuperTest) =>
    test.set('Authorization', `Bearer ${adminToken}`);

  // The answer must be a 400 that is about the number, never a 500.
  async function refused(test: SuperTest) {
    const response = await test;
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ statusCode: 400 });
  }

  describe('ids in the path do not fit an integer', () => {
    // [description, how to send it]
    const customerRoutes: Array<[string, () => SuperTest]> = [
      [
        'PATCH /cart/items/:itemId',
        () => http().patch(`/cart/items/${HUGE}`).send({ quantity: 1 }),
      ],
      [
        'DELETE /cart/items/:itemId',
        () => http().delete(`/cart/items/${HUGE}`),
      ],
      ['GET /orders/:id', () => http().get(`/orders/${HUGE}`)],
      ['POST /orders/:id/cancel', () => http().post(`/orders/${HUGE}/cancel`)],
      [
        'GET /orders/:orderId/payments',
        () => http().get(`/orders/${HUGE}/payments`),
      ],
      [
        'POST /orders/:orderId/payments',
        () =>
          http()
            .post(`/orders/${HUGE}/payments`)
            .set('Idempotency-Key', 'limits-key-0001'),
      ],
      [
        'PATCH /addresses/:id',
        () => http().patch(`/addresses/${HUGE}`).send({}),
      ],
      ['DELETE /addresses/:id', () => http().delete(`/addresses/${HUGE}`)],
      [
        'DELETE /wishlist/items/:productId',
        () => http().delete(`/wishlist/items/${HUGE}`),
      ],
      [
        'POST /products/:productId/reviews',
        () => http().post(`/products/${HUGE}/reviews`).send({ rating: 5 }),
      ],
      [
        'GET /products/:productId/reviews/mine',
        () => http().get(`/products/${HUGE}/reviews/mine`),
      ],
      [
        'PATCH /products/:productId/reviews/mine',
        () =>
          http().patch(`/products/${HUGE}/reviews/mine`).send({ rating: 4 }),
      ],
      [
        'DELETE /products/:productId/reviews/mine',
        () => http().delete(`/products/${HUGE}/reviews/mine`),
      ],
    ];
    const adminRoutes: Array<[string, () => SuperTest]> = [
      ['GET /admin/orders/:id', () => http().get(`/admin/orders/${HUGE}`)],
      [
        'PATCH /admin/orders/:id/status',
        () =>
          http()
            .patch(`/admin/orders/${HUGE}/status`)
            .send({ status: 'cancelled' }),
      ],
      [
        'POST /admin/payments/reconciliation/:eventId/resolve',
        () =>
          http()
            .post(`/admin/payments/reconciliation/${HUGE}/resolve`)
            .send({ note: 'done' }),
      ],
      ['GET /products/admin/:id', () => http().get(`/products/admin/${HUGE}`)],
      ['PATCH /products/:id', () => http().patch(`/products/${HUGE}`).send({})],
      ['DELETE /products/:id', () => http().delete(`/products/${HUGE}`)],
      [
        'PATCH /products/:productId/variants/:variantId (product)',
        () => http().patch(`/products/${HUGE}/variants/1`).send({}),
      ],
      [
        'PATCH /products/:productId/variants/:variantId (variant)',
        () => http().patch(`/products/1/variants/${HUGE}`).send({}),
      ],
      [
        'DELETE /products/:productId/variants/:variantId',
        () => http().delete(`/products/1/variants/${HUGE}`),
      ],
      [
        'PATCH /products/:productId/images/:imageId',
        () => http().patch(`/products/1/images/${HUGE}`).send({}),
      ],
      [
        'DELETE /products/:productId/images/:imageId',
        () => http().delete(`/products/1/images/${HUGE}`),
      ],
      [
        'PATCH /categories/:id',
        () => http().patch(`/categories/${HUGE}`).send({}),
      ],
      ['DELETE /categories/:id', () => http().delete(`/categories/${HUGE}`)],
      ['PATCH /brands/:id', () => http().patch(`/brands/${HUGE}`).send({})],
      ['DELETE /brands/:id', () => http().delete(`/brands/${HUGE}`)],
      [
        'GET /admin/promotions/:id',
        () => http().get(`/admin/promotions/${HUGE}`),
      ],
      [
        'PATCH /admin/promotions/:id',
        () => http().patch(`/admin/promotions/${HUGE}`).send({}),
      ],
      [
        'PATCH /admin/promotions/:id/toggle',
        () => http().patch(`/admin/promotions/${HUGE}/toggle`),
      ],
      [
        'GET /admin/collections/:id',
        () => http().get(`/admin/collections/${HUGE}`),
      ],
      [
        'PATCH /admin/collections/:id',
        () => http().patch(`/admin/collections/${HUGE}`).send({}),
      ],
      [
        'PATCH /admin/collections/:id/toggle',
        () => http().patch(`/admin/collections/${HUGE}/toggle`),
      ],
      [
        'PUT /admin/collections/:id/products',
        () =>
          http()
            .put(`/admin/collections/${HUGE}/products`)
            .send({ productIds: [] }),
      ],
      [
        'PATCH /admin/reviews/:reviewId/visibility',
        () =>
          http()
            .patch(`/admin/reviews/${HUGE}/visibility`)
            .send({ isVisible: false }),
      ],
    ];

    it.each(customerRoutes)('%s', async (_label, send) => {
      await refused(asCustomer(send()));
    });
    it.each(adminRoutes)('%s', async (_label, send) => {
      await refused(asAdmin(send()));
    });

    it('also for the public routes', async () => {
      await refused(http().get(`/products/${HUGE}/reviews`));
    });

    it('the largest integer id still passes the pipe (and is a plain 404)', async () => {
      await asCustomer(http().get(`/orders/${INT_MAX}`)).expect(404);
    });
  });

  describe('numbers in a body', () => {
    const body = (extra: object = {}) => ({
      addressId: 0,
      items: [{ variantId: 0, quantity: 1 }],
      ...extra,
    });

    it.each([
      [
        'a cart item with a variant id that does not fit',
        { variantId: HUGE, quantity: 1 },
      ],
      [
        'a cart item with the first id past the limit',
        { variantId: BEYOND, quantity: 1 },
      ],
      [
        'a cart item quantity of 100',
        { variantId: 1, quantity: MAX_QUANTITY_PER_LINE + 1 },
      ],
      [
        'a cart item quantity of 2147483647',
        { variantId: 1, quantity: INT_MAX },
      ],
      [
        'a cart item quantity in exponent form',
        { variantId: 1, quantity: 1e30 },
      ],
    ])('POST /cart/items: %s', async (_label, payload) => {
      await refused(asCustomer(http().post('/cart/items').send(payload)));
    });

    it('PATCH /cart/items/:id: a quantity over the limit', async () => {
      await refused(
        asCustomer(
          http()
            .patch('/cart/items/1')
            .send({ quantity: MAX_QUANTITY_PER_LINE + 1 }),
        ),
      );
      await refused(
        asCustomer(http().patch('/cart/items/1').send({ quantity: INT_MAX })),
      );
    });

    it('POST /cart/checkout: an address id that does not fit', async () => {
      await refused(
        asCustomer(http().post('/cart/checkout').send({ addressId: HUGE })),
      );
    });

    it.each([
      [
        'an address id that does not fit',
        () => body({ addressId: HUGE, items: [{ variantId: 1, quantity: 1 }] }),
      ],
      [
        'a variant id that does not fit',
        () => body({ addressId: 1, items: [{ variantId: HUGE, quantity: 1 }] }),
      ],
      [
        'a quantity of 100 on a line',
        () =>
          body({
            addressId: 1,
            items: [{ variantId: 1, quantity: MAX_QUANTITY_PER_LINE + 1 }],
          }),
      ],
      [
        'a quantity of 2147483647',
        () =>
          body({ addressId: 1, items: [{ variantId: 1, quantity: INT_MAX }] }),
      ],
      [
        'more lines than the limit',
        () =>
          body({
            addressId: 1,
            items: Array.from({ length: MAX_LINES + 1 }, (_, i) => ({
              variantId: i + 1,
              quantity: 1,
            })),
          }),
      ],
      [
        'repeated lines that add up to more than the limit',
        () =>
          // Real ids: this one is checked by the service, after the address.
          body({
            addressId,
            items: [
              { variantId, quantity: MAX_QUANTITY_PER_LINE },
              { variantId, quantity: 1 },
            ],
          }),
      ],
    ])('POST /orders/checkout: %s', async (_label, payload) => {
      await refused(
        asCustomer(http().post('/orders/checkout').send(payload())),
      );
    });

    it('POST /wishlist/items: a product id that does not fit', async () => {
      await refused(
        asCustomer(http().post('/wishlist/items').send({ productId: HUGE })),
      );
    });

    it.each([
      ['a category id', { name: 'P', categoryId: HUGE }],
      ['a brand id', { name: 'P', categoryId: 1, brandId: HUGE }],
    ])('POST /products: %s that does not fit', async (_label, payload) => {
      await refused(asAdmin(http().post('/products').send(payload)));
    });

    it('PATCH /products/:id: ids that do not fit', async () => {
      await refused(
        asAdmin(
          http().patch(`/products/${productId}`).send({ categoryId: HUGE }),
        ),
      );
      await refused(
        asAdmin(http().patch(`/products/${productId}`).send({ brandId: HUGE })),
      );
    });

    const variant = { sku: 'LIMIT-1', name: 'Limit', price: 100_000, stock: 5 };
    it.each([
      ['a price over the limit', { price: MAX_PRICE_VND + 1 }],
      [
        'a price of the largest safe integer',
        { price: Number.MAX_SAFE_INTEGER },
      ],
      [
        'a compare-at price over the limit',
        { compareAtPrice: MAX_PRICE_VND + 1 },
      ],
      ['stock over the limit', { stock: MAX_STOCK + 1 }],
      ['stock that does not fit an integer', { stock: HUGE }],
      ['a position over the limit', { position: MAX_POSITION + 1 }],
    ])('POST /products/:id/variants: %s', async (_label, extra) => {
      await refused(
        asAdmin(
          http()
            .post(`/products/${productId}/variants`)
            .send({ ...variant, ...extra }),
        ),
      );
    });

    it('PATCH /products/:id/variants/:variantId: stock and price over the limit', async () => {
      const path = `/products/${productId}/variants/${variantId}`;
      await refused(asAdmin(http().patch(path).send({ stock: HUGE })));
      await refused(
        asAdmin(
          http()
            .patch(path)
            .send({ price: MAX_PRICE_VND + 1 }),
        ),
      );
    });

    it('PATCH /products/:id/images/:imageId: a position over the limit', async () => {
      await refused(
        asAdmin(
          http()
            .patch(`/products/${productId}/images/1`)
            .send({ position: MAX_POSITION + 1 }),
        ),
      );
    });

    it.each([
      ['a value', { value: MAX_PRICE_VND + 1 }],
      ['a minimum subtotal', { minSubtotal: MAX_PRICE_VND + 1 }],
      [
        'a maximum discount',
        { type: 'PERCENTAGE', value: 10, maxDiscount: MAX_PRICE_VND + 1 },
      ],
    ])('POST /admin/promotions: %s over the limit', async (_label, extra) => {
      const coupon = {
        code: 'LIMIT10',
        name: 'Limit coupon',
        type: 'FIXED',
        value: 5000,
      };
      await refused(
        asAdmin(
          http()
            .post('/admin/promotions')
            .send({ ...coupon, ...extra }),
        ),
      );
    });

    it('PUT /admin/collections/:id/products: a product id that does not fit', async () => {
      await refused(
        asAdmin(
          http()
            .put('/admin/collections/1/products')
            .send({ productIds: [1, BEYOND] }),
        ),
      );
    });
  });

  describe('numbers in the query', () => {
    it.each([
      ['minPrice over the limit', `minPrice=${MAX_PRICE_VND + 1}`],
      ['maxPrice over the limit', `maxPrice=${MAX_PRICE_VND + 1}`],
      ['maxPrice in exponent form', 'maxPrice=1e30'],
      ['a price of 20 digits', 'minPrice=99999999999999999999'],
      ['page over the limit', 'page=100001'],
      ['limit over the limit', 'limit=49'],
    ])('GET /products: %s', async (_label, query) => {
      await refused(http().get(`/products?${query}`));
    });

    it.each([
      ['page over the limit', 'page=100001'],
      ['an order id that does not fit', `orderId=${BEYOND}`],
      ['an order id of 20 digits', 'orderId=99999999999999999999'],
    ])('GET /admin/payments/reconciliation: %s', async (_label, query) => {
      await refused(
        asAdmin(http().get(`/admin/payments/reconciliation?${query}`)),
      );
    });

    it.each(['/orders', '/admin/orders'])(
      'GET %s: page over the limit',
      async (path) => {
        const test = http().get(`${path}?page=100001`);
        await refused(
          path.startsWith('/admin') ? asAdmin(test) : asCustomer(test),
        );
      },
    );
  });

  describe('what is still accepted', () => {
    it('takes a quantity of exactly the limit, then refuses one more unit on that line', async () => {
      await asCustomer(
        http()
          .post('/cart/items')
          .send({ variantId, quantity: MAX_QUANTITY_PER_LINE }),
      ).expect(201);

      const response = await asCustomer(
        http().post('/cart/items').send({ variantId, quantity: 1 }),
      );

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain(
        String(MAX_QUANTITY_PER_LINE),
      );
    });

    it('lets that full line be checked out as an order', async () => {
      await asCustomer(
        http()
          .post('/orders/checkout')
          .send({
            addressId,
            items: [{ variantId, quantity: MAX_QUANTITY_PER_LINE }],
          }),
      ).expect(201);
    });

    it('refuses a new cart line once the cart has the most lines, but not a line already in it', async () => {
      await asCustomer(http().get('/cart')).expect(200);
      const [{ id: cartId }] = await dataSource.query<Array<{ id: number }>>(
        `SELECT "id" FROM "carts" WHERE "userId" = $1`,
        [customer.id],
      );
      const product = await dataSource
        .getRepository(Product)
        .findOneByOrFail({ id: productId });
      const ids: number[] = [];
      for (let index = 0; index < MAX_LINES; index += 1) {
        ids.push(
          (await createVariant(dataSource, product, `bulk-${index}`)).id,
        );
      }
      for (const id of ids) {
        await dataSource.query(
          `INSERT INTO "cart_items" ("cartId", "variantId", "quantity") VALUES ($1, $2, 1)`,
          [cartId, id],
        );
      }

      await refused(
        asCustomer(http().post('/cart/items').send({ variantId, quantity: 1 })),
      );
      await asCustomer(
        http().post('/cart/items').send({ variantId: ids[0], quantity: 1 }),
      ).expect(201);
    });

    it('accepts stock and a price at their limits', async () => {
      const response = await asAdmin(
        http().post(`/products/${productId}/variants`).send({
          sku: 'AT-LIMIT',
          name: 'At the limit',
          price: MAX_PRICE_VND,
          stock: MAX_STOCK,
          position: MAX_POSITION,
        }),
      );
      expect(response.status).toBe(201);
    });
  });
});
