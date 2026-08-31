import {
  ConflictException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource, QueryFailedError } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { CartItem } from '../../src/carts/entities/cart-item.entity';
import { CartsService } from '../../src/carts/carts.service';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { Order } from '../../src/orders/entities/order.entity';
import { OrdersService } from '../../src/orders/orders.service';
import { PaymentsService } from '../../src/payments/payments.service';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { CouponType } from '../../src/promotions/entities/coupon-type.enum';
import { Coupon } from '../../src/promotions/entities/coupon.entity';
import { PromotionsService } from '../../src/promotions/promotions.service';
import { TelegramService } from '../../src/telegram/telegram.service';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import {
  createAddress,
  createCategory,
  createVariant,
} from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Promotions & Merchandising PostgreSQL Integration', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let dataSource: DataSource;
  let promotions: PromotionsService;
  let orders: OrdersService;
  let carts: CartsService;
  let payments: PaymentsService;
  let mockProvider: {
    provider: string;
    getProviderPaymentId: jest.Mock;
    createPayment: jest.Mock;
  };

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();

    const moduleRef: TestingModule = await Test.createTestingModule({
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
    jwtService = app.get(JwtService);
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    promotions = new PromotionsService(dataSource);
    orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramService,
      promotions,
    );
    carts = new CartsService(dataSource, orders, promotions);

    mockProvider = {
      provider: 'momo',
      getProviderPaymentId: jest
        .fn()
        .mockImplementation((id: number) => `momo-pay-${id}`),
      createPayment: jest.fn().mockImplementation(async (input) => ({
        providerPaymentId: `momo-pay-${input.paymentId}`,
        initialStatus: 'processing',
        checkoutUrl: 'https://pay.test',
      })),
    };
    payments = new PaymentsService(dataSource, mockProvider as never, 'VND');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  async function createUser(
    emailPrefix: string,
    role: UserRole = UserRole.USER,
  ): Promise<User> {
    return dataSource.getRepository(User).save({
      email: `${emailPrefix}@example.test`,
      password: 'hash',
      role,
    });
  }

  async function createToken(user: User): Promise<string> {
    return jwtService.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
  }

  async function setupVariant(
    suffix: string,
    stock: number,
    price: number,
  ): Promise<ProductVariant> {
    const category = await createCategory(dataSource, suffix);
    const product = await dataSource.getRepository(Product).save({
      name: `Product ${suffix}`,
      slug: `product-${suffix}`,
      description: null,
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
      brandId: null,
    });
    return createVariant(dataSource, product, suffix, { stock, price });
  }

  async function createTestCoupon(overrides: Partial<Coupon>): Promise<Coupon> {
    return dataSource.getRepository(Coupon).save({
      code: overrides.code ?? 'PROMO10',
      name: overrides.name ?? 'Promo 10%',
      type: overrides.type ?? CouponType.PERCENTAGE,
      value: overrides.value ?? 10,
      minSubtotal: overrides.minSubtotal ?? null,
      maxDiscount: overrides.maxDiscount ?? null,
      startsAt: overrides.startsAt ?? null,
      endsAt: overrides.endsAt ?? null,
      isActive: overrides.isActive ?? true,
    });
  }

  describe('1. Cart Quotation Engine (Authority & Validation)', () => {
    it('quotes undiscounted cart when no coupon is provided', async () => {
      const user = await createUser('quote-none');
      const variant = await setupVariant('q1', 10, 200000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 2 });

      const quote = await carts.getQuote(user.id);
      expect(quote.subtotal).toBe(400000);
      expect(quote.discount).toBe(0);
      expect(quote.total).toBe(400000);
      expect(quote.coupon).toBeNull();
    });

    it('quotes percentage coupon with max discount cap', async () => {
      const user = await createUser('quote-pct');
      const variant = await setupVariant('q2', 10, 500000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 2 }); // subtotal 1,000,000

      await createTestCoupon({
        code: 'SAVE20',
        type: CouponType.PERCENTAGE,
        value: 20,
        maxDiscount: 100000,
      });

      const quote = await carts.getQuote(user.id, '  save20  ');
      expect(quote.subtotal).toBe(1000000);
      expect(quote.discount).toBe(100000); // 20% of 1M is 200k, capped at 100k
      expect(quote.total).toBe(900000);
      expect(quote.coupon?.code).toBe('SAVE20');
    });

    it('quotes fixed discount coupon', async () => {
      const user = await createUser('quote-fixed');
      const variant = await setupVariant('q3', 10, 300000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 1 });

      await createTestCoupon({
        code: 'FLAT50',
        type: CouponType.FIXED,
        value: 50000,
      });

      const quote = await carts.getQuote(user.id, 'FLAT50');
      expect(quote.subtotal).toBe(300000);
      expect(quote.discount).toBe(50000);
      expect(quote.total).toBe(250000);
    });

    it('throws NotFoundException on unknown coupon code', async () => {
      const user = await createUser('quote-unknown');
      const variant = await setupVariant('q4', 10, 300000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 1 });

      await expect(carts.getQuote(user.id, 'NONEXISTENT')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException on inactive or expired coupon', async () => {
      const user = await createUser('quote-inactive');
      const variant = await setupVariant('q5', 10, 300000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 1 });

      await createTestCoupon({
        code: 'INACTIVE',
        isActive: false,
      });

      await expect(carts.getQuote(user.id, 'INACTIVE')).rejects.toThrow(
        'This coupon is not active',
      );
    });

    it('throws BadRequestException when subtotal is below minSubtotal', async () => {
      const user = await createUser('quote-min');
      const variant = await setupVariant('q6', 10, 200000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 1 });

      await createTestCoupon({
        code: 'MIN500',
        minSubtotal: 500000,
      });

      await expect(carts.getQuote(user.id, 'MIN500')).rejects.toThrow(
        'This coupon requires a minimum subtotal of',
      );
    });

    it('rejects coupon that reduces payable total below 1,000 VND', async () => {
      const user = await createUser('quote-sub1000');
      const variant = await setupVariant('q7', 10, 1000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 1 });

      await createTestCoupon({
        code: 'FIXED500',
        type: CouponType.FIXED,
        value: 500,
      });

      await expect(carts.getQuote(user.id, 'FIXED500')).rejects.toThrow(
        'This promotion would reduce the payable total below the supported minimum.',
      );
    });
  });

  describe('2. Real HTTP Checkout Integration Test (Nest App & ValidationPipe)', () => {
    it('processes HTTP checkout with couponCode "  save10  ", normalizing code and applying discount', async () => {
      const user = await createUser('http-checkout');
      const token = await createToken(user);
      const address = await createAddress(dataSource, user, 'http-addr');
      const variant = await setupVariant('http-v1', 10, 399000);

      // Cart subtotal: 2 * 399,000 = 798,000 VND
      await carts.addItem(user.id, { variantId: variant.id, quantity: 2 });

      await createTestCoupon({
        code: 'SAVE10',
        name: 'Save 10 Percent',
        type: CouponType.PERCENTAGE,
        value: 10,
        isActive: true,
      });

      const response = await request(app.getHttpServer())
        .post('/cart/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({
          addressId: address.id,
          couponCode: '  save10  ',
        })
        .expect(201);

      expect(response.body.id).toBeDefined();

      // Verify persisted Order in real PostgreSQL
      const dbOrder = await dataSource.getRepository(Order).findOneOrFail({
        where: { id: response.body.id },
        relations: { items: true },
      });

      expect(dbOrder.couponCode).toBe('SAVE10'); // Normalized & not stripped
      expect(dbOrder.subtotalPrice).toBe(798000);
      expect(dbOrder.discountPrice).toBe(79800);
      expect(dbOrder.totalPrice).toBe(718200);
      expect(dbOrder.couponType).toBe(CouponType.PERCENTAGE);
      expect(dbOrder.couponValue).toBe(10);

      // Order items snapshot pre-discount variant price
      expect(dbOrder.items).toHaveLength(1);
      expect(dbOrder.items[0].price).toBe(399000);
      expect(dbOrder.items[0].quantity).toBe(2);

      // Stock decremented
      const updatedVariant = await dataSource
        .getRepository(ProductVariant)
        .findOneByOrFail({ id: variant.id });
      expect(updatedVariant.stock).toBe(8);

      // Cart cleared
      const cartRows = await dataSource.getRepository(CartItem).count();
      expect(cartRows).toBe(0);
    });
  });

  describe('3. Stale Quote Recalculation Coverage', () => {
    it('recalculates discount from current cart state upon HTTP checkout ignoring stale quotes', async () => {
      const user = await createUser('stale-quote-user');
      const token = await createToken(user);
      const address = await createAddress(dataSource, user, 'stale-addr');
      const variant = await setupVariant('stale-v1', 10, 399000);

      // 1. Initial cart: quantity = 2, subtotal = 798,000
      await carts.addItem(user.id, { variantId: variant.id, quantity: 2 });

      await createTestCoupon({
        code: 'SAVE10',
        type: CouponType.PERCENTAGE,
        value: 10,
      });

      // Initial quote: subtotal 798,000 -> discount 79,800 -> total 718,200
      const quoteRes = await request(app.getHttpServer())
        .post('/cart/quote')
        .set('Authorization', `Bearer ${token}`)
        .send({ couponCode: 'SAVE10' })
        .expect(201);
      expect(quoteRes.body.total).toBe(718200);

      // 2. Authoritative cart state mutated: quantity reduced to 1
      const cartItem = await dataSource
        .getRepository(CartItem)
        .findOneByOrFail({
          variantId: variant.id,
        });
      await carts.updateItem(user.id, cartItem.id, { quantity: 1 });

      // 3. HTTP checkout with SAVE10
      const checkoutRes = await request(app.getHttpServer())
        .post('/cart/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({
          addressId: address.id,
          couponCode: 'SAVE10',
        })
        .expect(201);

      // 4. Persisted Order must reflect the new recalculated amounts (399,000 subtotal, 39,900 discount, 359,100 total)
      const dbOrder = await dataSource.getRepository(Order).findOneOrFail({
        where: { id: checkoutRes.body.id },
      });
      expect(dbOrder.subtotalPrice).toBe(399000);
      expect(dbOrder.discountPrice).toBe(39900);
      expect(dbOrder.totalPrice).toBe(359100);
    });
  });

  describe('4. Expired Coupon & Atomic Failure Rollback Coverage', () => {
    it('rejects checkout when coupon has expired and leaves stock, cart, and orders untouched', async () => {
      const user = await createUser('expired-user');
      const token = await createToken(user);
      const address = await createAddress(dataSource, user, 'exp-addr');
      const variant = await setupVariant('exp-v1', 10, 500000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 1 });

      // Expired coupon
      await createTestCoupon({
        code: 'EXPIRED10',
        type: CouponType.PERCENTAGE,
        value: 10,
        endsAt: new Date(Date.now() - 60000), // 1 minute in the past
      });

      // Snapshot initial state
      const initialStock = (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock;
      const initialCartRows = await dataSource.getRepository(CartItem).count();
      const initialOrderCount = await dataSource.getRepository(Order).count();
      const initialOrderItemCount = await dataSource
        .getRepository(OrderItem)
        .count();

      expect(initialStock).toBe(10);
      expect(initialCartRows).toBe(1);
      expect(initialOrderCount).toBe(0);
      expect(initialOrderItemCount).toBe(0);

      // Attempt HTTP checkout with expired coupon
      const response = await request(app.getHttpServer())
        .post('/cart/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({
          addressId: address.id,
          couponCode: 'EXPIRED10',
        })
        .expect(400);

      expect(response.body.message).toContain('This coupon has expired');

      // Assert complete atomic rollback
      const finalStock = (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock;
      const finalCartRows = await dataSource.getRepository(CartItem).count();
      const finalOrderCount = await dataSource.getRepository(Order).count();
      const finalOrderItemCount = await dataSource
        .getRepository(OrderItem)
        .count();

      expect(finalStock).toBe(initialStock);
      expect(finalCartRows).toBe(initialCartRows);
      expect(finalOrderCount).toBe(initialOrderCount);
      expect(finalOrderItemCount).toBe(initialOrderItemCount);
    });

    it('rejects checkout with coupon below minSubtotal and asserts zero side-effects', async () => {
      const user = await createUser('min-sub-user');
      const token = await createToken(user);
      const address = await createAddress(dataSource, user, 'minsub-addr');
      const variant = await setupVariant('minsub-v1', 10, 400000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 1 });

      await createTestCoupon({
        code: 'MIN1M',
        minSubtotal: 1000000, // Requires 1M, cart only has 400k
      });

      const initialStock = (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock;
      const initialCartRows = await dataSource.getRepository(CartItem).count();
      const initialOrderCount = await dataSource.getRepository(Order).count();
      const initialOrderItemCount = await dataSource
        .getRepository(OrderItem)
        .count();

      await request(app.getHttpServer())
        .post('/cart/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({
          addressId: address.id,
          couponCode: 'MIN1M',
        })
        .expect(400);

      const finalStock = (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock;
      const finalCartRows = await dataSource.getRepository(CartItem).count();
      const finalOrderCount = await dataSource.getRepository(Order).count();
      const finalOrderItemCount = await dataSource
        .getRepository(OrderItem)
        .count();

      expect(finalStock).toBe(initialStock);
      expect(finalCartRows).toBe(initialCartRows);
      expect(finalOrderCount).toBe(initialOrderCount);
      expect(finalOrderItemCount).toBe(initialOrderItemCount);
    });
  });

  describe('5. Payment Derivation & Minimum Total Guard', () => {
    it('creates Payment using order.totalPrice (discounted payable total)', async () => {
      const user = await createUser('pay-disc');
      const address = await createAddress(dataSource, user, 'p-disc');
      const variant = await setupVariant('p1', 5, 798000);
      await carts.addItem(user.id, { variantId: variant.id, quantity: 1 });

      await createTestCoupon({
        code: 'PAY10',
        type: CouponType.PERCENTAGE,
        value: 10,
      });

      const order = await carts.checkout(user.id, address.id, 'PAY10');
      // Subtotal: 798,000; Discount: 79,800; Total: 718,200
      expect(order.subtotalPrice).toBe(798000);
      expect(order.discountPrice).toBe(79800);
      expect(order.totalPrice).toBe(718200);

      const payment = await payments.createForOrder(
        user.id,
        order.id,
        'idem-pay-123',
      );
      expect(payment.amount).toBe(718200);

      expect(mockProvider.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 718200,
          orderId: order.id,
        }),
      );
    });

    it('defense-in-depth: PaymentsService rejects order with totalPrice < 1,000 VND without calling provider', async () => {
      const user = await createUser('pay-min-guard');
      const address = await createAddress(dataSource, user, 'p-min');

      // Create an order in DB with totalPrice = 999 (e.g. legacy/corrupted record)
      const order = await dataSource.getRepository(Order).save({
        userId: user.id,
        subtotalPrice: 999,
        discountPrice: 0,
        totalPrice: 999,
        shippingAddress: address as never,
      });

      await expect(
        payments.createForOrder(user.id, order.id, 'idem-under-min'),
      ).rejects.toThrow('Order total must be at least 1,000 VND');

      expect(mockProvider.createPayment).not.toHaveBeenCalled();
    });
  });

  describe('6. Admin HTTP RBAC, Edit, and Toggle Integration', () => {
    it('enforces RBAC: Customer denied (403), Admin allowed (201, 200) for promotion endpoints', async () => {
      const customer = await createUser('admin-cust-rbac', UserRole.USER);
      const customerToken = await createToken(customer);

      const admin = await createUser('admin-user-rbac', UserRole.ADMIN);
      const adminToken = await createToken(admin);

      const couponPayload = {
        code: 'SUMMER25',
        name: 'Summer 25% Off',
        type: CouponType.PERCENTAGE,
        value: 25,
        maxDiscount: 100000,
      };

      // 1. Customer POST /admin/promotions => 403 Forbidden
      await request(app.getHttpServer())
        .post('/admin/promotions')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(couponPayload)
        .expect(403);

      // 2. Admin POST /admin/promotions => 201 Created
      const createRes = await request(app.getHttpServer())
        .post('/admin/promotions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(couponPayload)
        .expect(201);

      const couponId = createRes.body.id;
      expect(couponId).toBeDefined();
      expect(createRes.body.code).toBe('SUMMER25');
      expect(createRes.body.isActive).toBe(true);

      // 3. Admin PATCH /admin/promotions/:id => 200 OK (Update)
      const updateRes = await request(app.getHttpServer())
        .patch(`/admin/promotions/${couponId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Updated Summer 25% Off Promo',
          value: 30,
        })
        .expect(200);

      expect(updateRes.body.name).toBe('Updated Summer 25% Off Promo');
      expect(updateRes.body.value).toBe(30);

      // 4. Admin PATCH /admin/promotions/:id/toggle => 200 OK (Toggle off)
      const toggleOffRes = await request(app.getHttpServer())
        .patch(`/admin/promotions/${couponId}/toggle`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(toggleOffRes.body.isActive).toBe(false);

      // 5. Admin PATCH /admin/promotions/:id/toggle => 200 OK (Toggle on)
      const toggleOnRes = await request(app.getHttpServer())
        .patch(`/admin/promotions/${couponId}/toggle`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(toggleOnRes.body.isActive).toBe(true);
    });
  });

  describe('7. Database Unique Constraint as Final Authority & Race Conflict (409)', () => {
    it('proves PostgreSQL UQ_coupons_code unique constraint rejects duplicates and maps to 409 Conflict', async () => {
      // 1. Create first coupon
      await promotions.create({
        code: 'UNIQUE10',
        name: 'Unique Test',
        type: CouponType.PERCENTAGE,
        value: 10,
      });

      // 2. Direct database unique constraint check: attempting raw duplicate insert throws PostgreSQL unique violation
      await expect(
        dataSource.query(`
          INSERT INTO "coupons" ("code", "name", "type", "value", "isActive")
          VALUES ('UNIQUE10', 'Duplicate Raw', 'PERCENTAGE', 10, true);
        `),
      ).rejects.toThrow(QueryFailedError);

      // 3. Concurrent/duplicate service creation with case variations maps to ConflictException (409)
      await expect(
        promotions.create({
          code: '  unique10  ',
          name: 'Duplicate Normalized',
          type: CouponType.PERCENTAGE,
          value: 15,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
