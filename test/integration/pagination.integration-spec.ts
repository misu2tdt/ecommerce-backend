import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureHttpSecurity } from '../../src/config/http-security';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { ProductSort } from '../../src/products/dto/product-query.dto';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { CouponType } from '../../src/promotions/entities/coupon-type.enum';
import { Coupon } from '../../src/promotions/entities/coupon.entity';
import { ProductReview } from '../../src/reviews/entities/product-review.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import { createBrand, createCategory } from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const FRONTEND_ORIGIN = 'https://shop.example.test';

interface ProductRow {
  id: number;
  name: string;
  createdAt: Date;
  minPrice: number | null;
}

// Pages are checked against an order worked out here, from the stored rows,
// not against what the service returns. The data is built with many ties (same
// name, same price, same creation time) so only a unique tie-breaker keeps
// pages from overlapping or skipping rows.
describe('Pagination on list endpoints', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwt: JwtService;
  let adminToken: string;
  let shopperToken: string;
  let otherShopperToken: string;
  let shopper: User;
  let otherShopper: User;
  let productRows: ProductRow[];

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
    await cleanTestDatabase(dataSource);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp =
      moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpSecurity(expressApp, {
      nodeEnvironment: 'production',
      frontendOrigin: FRONTEND_ORIGIN,
    });
    expressApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await expressApp.init();
    app = expressApp;
    jwt = app.get(JwtService);

    const users = dataSource.getRepository(User);
    shopper = await users.save({
      email: 'shopper@example.test',
      password: 'not-used',
      role: UserRole.USER,
    });
    otherShopper = await users.save({
      email: 'other@example.test',
      password: 'not-used',
      role: UserRole.USER,
    });
    const admin = await users.save({
      email: 'admin@example.test',
      password: 'not-used',
      role: UserRole.ADMIN,
    });
    const sign = (user: User) =>
      jwt.sign({ sub: user.id, email: user.email, role: user.role });
    shopperToken = sign(shopper);
    otherShopperToken = sign(otherShopper);
    adminToken = sign(admin);

    await seedCatalog();
    await seedOrders();
    await seedReviewsAndCoupons();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  // 30 active products with ties on purpose, 2 without any variant (no price),
  // and 1 inactive product that the public list never shows.
  async function seedCatalog() {
    const categoryA = await createCategory(dataSource, 'a');
    const categoryB = await createCategory(dataSource, 'b');
    const brand = await createBrand(dataSource, 'x');
    const products = dataSource.getRepository(Product);
    const variants = dataSource.getRepository(ProductVariant);

    // One INSERT per group: every product of a group has the same createdAt.
    async function insertGroup(
      rows: Array<{
        name: string;
        slug: string;
        categoryId: number;
        status?: ProductStatus;
        price?: number;
        stock?: number;
        size?: string;
      }>,
    ) {
      const result = await products.insert(
        rows.map((row) => ({
          name: row.name,
          slug: row.slug,
          description: null,
          status: row.status ?? ProductStatus.ACTIVE,
          categoryId: row.categoryId,
          brandId: brand.id,
        })),
      );
      const ids = result.identifiers.map(
        (identifier) => (identifier as { id: number }).id,
      );
      const withVariants = rows
        .map((row, index) => ({ row, id: ids[index] }))
        .filter(({ row }) => row.price !== undefined);
      if (withVariants.length > 0) {
        await variants.insert(
          withVariants.map(({ row, id }) => ({
            productId: id,
            sku: `SKU-${row.slug}`.toUpperCase(),
            name: 'Default',
            price: row.price,
            stock: row.stock ?? 5,
            attributes: { size: row.size ?? 'M' },
            isActive: true,
            position: 0,
          })),
        );
      }
    }

    await insertGroup(
      Array.from({ length: 12 }, (_, index) => ({
        name: 'Same Name Tee',
        slug: `same-name-tee-${index + 1}`,
        categoryId: categoryA.id,
        price: 100_000,
        size: 'M',
      })),
    );
    await insertGroup(
      Array.from({ length: 8 }, (_, index) => ({
        name: 'Another Tee',
        slug: `another-tee-${index + 1}`,
        categoryId: categoryA.id,
        price: 150_000,
        stock: index % 2 === 0 ? 0 : 3,
        size: 'L',
      })),
    );
    const mixedPrices = [
      90_000, 100_000, 100_000, 150_000, 150_000, 200_000, 200_000, 250_000,
    ];
    await insertGroup(
      mixedPrices.map((price, index) => ({
        name: `Product ${String(index + 1).padStart(2, '0')}`,
        slug: `product-${index + 1}`,
        categoryId: categoryB.id,
        price,
        size: 'XL',
      })),
    );
    await insertGroup([
      { name: 'No Variant 1', slug: 'no-variant-1', categoryId: categoryB.id },
      { name: 'No Variant 2', slug: 'no-variant-2', categoryId: categoryB.id },
    ]);
    await insertGroup([
      {
        name: 'Hidden Tee',
        slug: 'hidden-tee',
        categoryId: categoryB.id,
        status: ProductStatus.INACTIVE,
        price: 1_000,
      },
    ]);

    productRows = (
      await dataSource.query<
        Array<{
          id: number;
          name: string;
          createdAt: Date;
          minPrice: string | null;
        }>
      >(`
        SELECT p.id, p.name, p."createdAt",
          (SELECT MIN(v.price) FROM product_variants v
            WHERE v."productId" = p.id AND v."isActive" = true) AS "minPrice"
        FROM products p WHERE p.status = 'active'`)
    ).map((row) => ({
      ...row,
      minPrice: row.minPrice === null ? null : Number(row.minPrice),
    }));
    expect(productRows).toHaveLength(30);
  }

  // The order each sort must produce, worked out independently of the service.
  function expectedIds(sort: ProductSort | undefined): number[] {
    const byName = (a: ProductRow, b: ProductRow) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    const byId = (a: ProductRow, b: ProductRow) => a.id - b.id;
    const byPrice = (direction: 1 | -1) => (a: ProductRow, b: ProductRow) => {
      if (a.minPrice === b.minPrice) return 0;
      if (a.minPrice === null) return 1;
      if (b.minPrice === null) return -1;
      return (a.minPrice - b.minPrice) * direction;
    };
    const comparators: Record<
      ProductSort,
      Array<(a: ProductRow, b: ProductRow) => number>
    > = {
      [ProductSort.FEATURED]: [byName, byId],
      [ProductSort.NAME_ASC]: [byName, byId],
      [ProductSort.NAME_DESC]: [(a, b) => -byName(a, b), byId],
      [ProductSort.PRICE_ASC]: [byPrice(1), byName, byId],
      [ProductSort.PRICE_DESC]: [byPrice(-1), byName, byId],
      [ProductSort.NEWEST]: [
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        (a, b) => b.id - a.id,
      ],
    };
    const chain = comparators[sort ?? ProductSort.FEATURED];
    return [...productRows]
      .sort((a, b) => {
        for (const compare of chain) {
          const result = compare(a, b);
          if (result !== 0) return result;
        }
        return 0;
      })
      .map((row) => row.id);
  }

  // Customer and admin orders: 25 for the shopper (3 share one creation time),
  // 5 for somebody else.
  const shopperOrderIds: number[] = [];
  const allOrderIds: number[] = [];
  async function seedOrders() {
    const variant = await dataSource
      .getRepository(ProductVariant)
      .findOneByOrFail({ sku: 'SKU-SAME-NAME-TEE-1' });
    const orders = dataSource.getRepository(Order);
    const items = dataSource.getRepository(OrderItem);
    const shippingAddress = {
      recipientName: 'Test Shopper',
      phone: '+84900000000',
      addressLine1: '1 Test Street',
      addressLine2: null,
      ward: null,
      district: null,
      city: 'Ho Chi Minh City',
      stateProvince: null,
      postalCode: null,
      countryCode: 'VN',
    };
    const base = {
      subtotalPrice: variant.price,
      discountPrice: 0,
      totalPrice: variant.price,
      couponCode: null,
      couponType: null,
      couponValue: null,
      status: OrderStatus.PENDING,
      shippingAddress,
    };
    const place = async (userId: number, count: number) => {
      // One INSERT for the batch: the orders share one createdAt.
      const result = await orders.insert(
        Array.from({ length: count }, () => ({ ...base, userId })),
      );
      const ids = result.identifiers.map(
        (identifier) => (identifier as { id: number }).id,
      );
      await items.insert(
        ids.map((orderId) => ({
          orderId,
          variantId: variant.id,
          quantity: 1,
          price: variant.price,
        })),
      );
      return ids;
    };
    for (let index = 0; index < 22; index += 1) {
      shopperOrderIds.push(...(await place(shopper.id, 1)));
    }
    shopperOrderIds.push(...(await place(shopper.id, 3)));
    for (let index = 0; index < 5; index += 1) {
      allOrderIds.push(...(await place(otherShopper.id, 1)));
    }
    allOrderIds.push(...shopperOrderIds);
  }

  async function seedReviewsAndCoupons() {
    const productIds = (
      await dataSource
        .getRepository(Product)
        .find({ order: { id: 'ASC' }, take: 4 })
    ).map((product) => product.id);
    const reviewers = [shopper, otherShopper];
    for (let index = 0; index < 6; index += 1) {
      reviewers.push(
        await dataSource.getRepository(User).save({
          email: `reviewer${index}@example.test`,
          password: 'not-used',
          role: UserRole.USER,
        }),
      );
    }
    for (const reviewer of reviewers) {
      for (const productId of productIds) {
        await dataSource.getRepository(ProductReview).save({
          userId: reviewer.id,
          productId,
          rating: 4,
          title: 'Fine',
          body: 'Fine.',
          isVisible: true,
        });
      }
    }
    for (let index = 0; index < 25; index += 1) {
      await dataSource.getRepository(Coupon).save({
        code: `COUPON${String(index).padStart(2, '0')}`,
        name: `Coupon ${index}`,
        type: CouponType.FIXED,
        value: 10_000,
        minSubtotal: 0,
        maxDiscount: null,
        isActive: true,
        startsAt: null,
        endsAt: null,
      });
    }
  }

  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).get(path);
    if (token) call.set('Authorization', `Bearer ${token}`);
    return call;
  };
  const ids = (body: unknown) =>
    (body as Array<{ id: number }>).map((x) => x.id);
  const header = (res: request.Response, name: string) => res.headers[name];

  describe('GET /products', () => {
    it('without paging parameters still returns every active product as one array', async () => {
      const res = await get('/products').expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(ids(res.body)).toEqual(expectedIds(ProductSort.FEATURED));
      expect(header(res, 'x-total-count')).toBeUndefined();
    });

    it('returns one page with the totals in headers', async () => {
      const all = expectedIds(ProductSort.FEATURED);

      const res = await get('/products?page=2&limit=12').expect(200);

      expect(ids(res.body)).toEqual(all.slice(12, 24));
      expect(header(res, 'x-total-count')).toBe('30');
      expect(header(res, 'x-total-pages')).toBe('3');
      expect(header(res, 'x-page')).toBe('2');
      expect(header(res, 'x-limit')).toBe('12');
    });

    it('uses a limit of 12 when only the page is given, and page 1 when only the limit is', async () => {
      const all = expectedIds(ProductSort.FEATURED);

      const onlyPage = await get('/products?page=3').expect(200);
      expect(ids(onlyPage.body)).toEqual(all.slice(24, 30));
      expect(header(onlyPage, 'x-limit')).toBe('12');
      expect(header(onlyPage, 'x-page')).toBe('3');

      const onlyLimit = await get('/products?limit=5').expect(200);
      expect(ids(onlyLimit.body)).toEqual(all.slice(0, 5));
      expect(header(onlyLimit, 'x-page')).toBe('1');
      expect(header(onlyLimit, 'x-total-pages')).toBe('6');
    });

    it('returns the last partial page and, beyond the end, an empty list with correct headers', async () => {
      const last = await get('/products?page=5&limit=7').expect(200);
      expect(last.body).toHaveLength(2);
      expect(header(last, 'x-total-pages')).toBe('5');

      const beyond = await get('/products?page=6&limit=7').expect(200);
      expect(beyond.body).toEqual([]);
      expect(header(beyond, 'x-total-count')).toBe('30');
      expect(header(beyond, 'x-total-pages')).toBe('5');
      expect(header(beyond, 'x-page')).toBe('6');
    });

    it('accepts the largest allowed page size', async () => {
      const res = await get('/products?limit=48').expect(200);
      expect(res.body).toHaveLength(30);
      expect(header(res, 'x-total-pages')).toBe('1');
    });

    it.each(Object.values(ProductSort))(
      'pages through every product exactly once, in the %s order',
      async (sort) => {
        const expected = expectedIds(sort);
        const unpaged = await get(`/products?sort=${sort}`).expect(200);
        expect(ids(unpaged.body)).toEqual(expected);

        const collected: number[] = [];
        for (let page = 1; page <= 5; page += 1) {
          const res = await get(
            `/products?sort=${sort}&page=${page}&limit=7`,
          ).expect(200);
          collected.push(...ids(res.body));
        }

        expect(collected).toEqual(expected);
        expect(new Set(collected).size).toBe(30);
      },
    );

    it('keeps the filters working together with paging', async () => {
      const inCategoryA = productRows
        .filter(
          (row) => row.name === 'Same Name Tee' || row.name === 'Another Tee',
        )
        .map((row) => row.id)
        .sort((a, b) => a - b);

      const first = await get(
        '/products?category=category-a&sort=newest&page=1&limit=8',
      ).expect(200);
      const second = await get(
        '/products?category=category-a&sort=newest&page=2&limit=8',
      ).expect(200);
      const third = await get(
        '/products?category=category-a&sort=newest&page=3&limit=8',
      ).expect(200);

      expect(header(first, 'x-total-count')).toBe('20');
      expect(header(first, 'x-total-pages')).toBe('3');
      expect(
        [...ids(first.body), ...ids(second.body), ...ids(third.body)].sort(
          (a, b) => a - b,
        ),
      ).toEqual(inCategoryA);
      expect(third.body).toHaveLength(4);

      const search = await get('/products?q=another&page=1&limit=5').expect(
        200,
      );
      expect(header(search, 'x-total-count')).toBe('8');
      expect(search.body).toHaveLength(5);

      const stocked = await get(
        '/products?inStock=true&size=L&page=1&limit=48',
      ).expect(200);
      expect(header(stocked, 'x-total-count')).toBe('4');

      const priced = await get(
        '/products?minPrice=150000&maxPrice=200000&sort=price_desc&page=1&limit=4',
      ).expect(200);
      expect(header(priced, 'x-total-count')).toBe(String(8 + 4));
      expect(priced.body).toHaveLength(4);

      const none = await get('/products?q=nothing-matches&page=1').expect(200);
      expect(none.body).toEqual([]);
      expect(header(none, 'x-total-count')).toBe('0');
      expect(header(none, 'x-total-pages')).toBe('0');
    });

    it('keeps the product shape of a page the same as the full list', async () => {
      const full = await get('/products').expect(200);
      const page = await get('/products?page=1&limit=3').expect(200);

      expect(page.body).toEqual((full.body as unknown[]).slice(0, 3));
    });

    it.each([
      ['page=0', 'page'],
      ['page=-1', 'page'],
      ['page=abc', 'page'],
      ['page=1.5', 'page'],
      ['page=1e1', 'page'],
      ['page=', 'page'],
      ['page=1&page=2', 'page'],
      ['page=100001', 'page'],
      ['limit=0', 'limit'],
      ['limit=49', 'limit'],
      ['limit=abc', 'limit'],
      ['limit=-5', 'limit'],
      ['limit=', 'limit'],
    ])('rejects ?%s with a clear 400', async (queryString, field) => {
      const res = await get(`/products?${queryString}`).expect(400);

      const messages = (res.body as { message: string[] }).message;
      // The reason is about the value, not that the parameter is unknown.
      expect(messages.join(' ')).toMatch(new RegExp(`^${field} must`));
    });

    it('lets a browser read the paging headers from another origin', async () => {
      const res = await request(app.getHttpServer())
        .get('/products?page=1&limit=2')
        .set('Origin', FRONTEND_ORIGIN)
        .expect(200);

      const exposed = String(
        res.headers['access-control-expose-headers'],
      ).toLowerCase();
      for (const name of [
        'x-total-count',
        'x-total-pages',
        'x-page',
        'x-limit',
      ]) {
        expect(exposed).toContain(name);
      }
    });
  });

  describe('GET /orders (the shopper’s own orders)', () => {
    // Newest first; orders created together tie on time, so the id decides.
    const expectedShopperIds = () => [...shopperOrderIds].sort((a, b) => b - a);

    it('still returns every order of the shopper as one array', async () => {
      const res = await get('/orders', shopperToken).expect(200);

      expect(ids(res.body)).toEqual(expectedShopperIds());
      expect(header(res, 'x-total-count')).toBeUndefined();
    });

    it('returns pages of only the shopper’s orders, with items, and totals', async () => {
      const expected = expectedShopperIds();

      const second = await get('/orders?page=2&limit=10', shopperToken).expect(
        200,
      );
      const third = await get('/orders?page=3&limit=10', shopperToken).expect(
        200,
      );
      const beyond = await get('/orders?page=4&limit=10', shopperToken).expect(
        200,
      );

      expect(ids(second.body)).toEqual(expected.slice(10, 20));
      expect(ids(third.body)).toEqual(expected.slice(20, 25));
      expect(header(second, 'x-total-count')).toBe('25');
      expect(header(second, 'x-total-pages')).toBe('3');
      expect(beyond.body).toEqual([]);
      expect(header(beyond, 'x-total-count')).toBe('25');
      for (const order of second.body as Array<{ items: unknown[] }>) {
        expect(order.items).toHaveLength(1);
      }
      const other = await get('/orders?limit=100', otherShopperToken).expect(
        200,
      );
      expect(header(other, 'x-total-count')).toBe('5');
    });

    it('rejects a limit above 100 and needs a signed-in shopper', async () => {
      await get('/orders?limit=101', shopperToken).expect(400);
      await get('/orders?page=0', shopperToken).expect(400);
      await get('/orders?page=1').expect(401);
    });
  });

  describe('admin lists', () => {
    it('GET /admin/orders pages through all orders', async () => {
      const expected = [...allOrderIds].sort((a, b) => b - a);
      const unpaged = await get('/admin/orders', adminToken).expect(200);
      expect(ids(unpaged.body)).toEqual(expected);

      const collected: number[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const res = await get(
          `/admin/orders?page=${page}&limit=12`,
          adminToken,
        ).expect(200);
        collected.push(...ids(res.body));
        expect(header(res, 'x-total-count')).toBe('30');
        expect(header(res, 'x-total-pages')).toBe('3');
      }
      expect(collected).toEqual(expected);
      await get('/admin/orders?page=1', shopperToken).expect(403);
    });

    it('GET /products/admin pages through all products, inactive ones included', async () => {
      const unpaged = await get('/products/admin', adminToken).expect(200);
      expect(unpaged.body).toHaveLength(31);

      const collected: number[] = [];
      for (let page = 1; page <= 4; page += 1) {
        const res = await get(
          `/products/admin?page=${page}&limit=10`,
          adminToken,
        ).expect(200);
        collected.push(...ids(res.body));
        expect(header(res, 'x-total-count')).toBe('31');
        expect(header(res, 'x-total-pages')).toBe('4');
      }
      expect(collected).toEqual(ids(unpaged.body));
      await get('/products/admin?page=1', shopperToken).expect(403);
    });

    it('GET /admin/reviews pages through all reviews', async () => {
      const unpaged = await get('/admin/reviews', adminToken).expect(200);
      expect(unpaged.body).toHaveLength(32);

      const collected: number[] = [];
      for (let page = 1; page <= 4; page += 1) {
        const res = await get(
          `/admin/reviews?page=${page}&limit=10`,
          adminToken,
        ).expect(200);
        collected.push(...ids(res.body));
        expect(header(res, 'x-total-count')).toBe('32');
      }
      expect(collected).toEqual(ids(unpaged.body));
    });

    it('GET /admin/promotions pages through all coupons', async () => {
      const unpaged = await get('/admin/promotions', adminToken).expect(200);
      expect(unpaged.body).toHaveLength(25);

      const second = await get(
        '/admin/promotions?page=2&limit=20',
        adminToken,
      ).expect(200);
      expect(ids(second.body)).toEqual(ids(unpaged.body).slice(20, 25));
      expect(header(second, 'x-total-count')).toBe('25');
      expect(header(second, 'x-total-pages')).toBe('2');
    });

    it('rejects invalid paging on every admin list', async () => {
      for (const path of [
        '/admin/orders',
        '/products/admin',
        '/admin/reviews',
        '/admin/promotions',
      ]) {
        await get(`${path}?page=0`, adminToken).expect(400);
        await get(`${path}?limit=101`, adminToken).expect(400);
      }
    });
  });
});
