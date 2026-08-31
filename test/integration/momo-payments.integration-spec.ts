import {
  BadGatewayException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentEvent } from '../../src/payments/entities/payment-event.entity';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import type { MomoIpnDto } from '../../src/payments/momo/dto/momo-ipn.dto';
import type { MomoConfig } from '../../src/payments/momo/momo.config';
import { MomoHttpClient } from '../../src/payments/momo/momo-http.client';
import { MomoIpnService } from '../../src/payments/momo/momo-ipn.service';
import {
  buildMomoOrderId,
  buildMomoRequestId,
} from '../../src/payments/momo/momo-identifiers';
import { MomoPaymentProvider } from '../../src/payments/momo/momo-payment.provider';
import {
  buildMomoIpnCanonical,
  signMomo,
} from '../../src/payments/momo/momo.signature';
import { PaymentProviderAmbiguousError } from '../../src/payments/provider-errors';
import { PaymentsService } from '../../src/payments/payments.service';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { OrdersService } from '../../src/orders/orders.service';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
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

describe('MoMo payment PostgreSQL integration with mocked HTTP', () => {
  const config: MomoConfig = {
    partnerCode: 'test-partner',
    accessKey: 'test-access',
    secretKey: 'test-secret',
    identitySecret: 'test-identity-secret',
    endpoint: 'https://test-payment.momo.vn',
    redirectUrl: 'https://merchant.test/payment-return',
    ipnUrl: 'https://merchant.test/payments/webhooks/momo',
    timeoutMs: 30_000,
  };
  let dataSource: DataSource;
  let http: {
    postJson: jest.Mock<
      Promise<unknown>,
      [string, Record<string, unknown>, number]
    >;
  };
  let payments: PaymentsService;
  let ipn: MomoIpnService;
  let orders: OrdersService;
  let createBodies: Record<string, unknown>[];

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    createBodies = [];
    http = {
      postJson: jest.fn<
        Promise<unknown>,
        [string, Record<string, unknown>, number]
      >((url: string, body: Record<string, unknown>) => {
        createBodies.push(body);
        return Promise.resolve(successfulCreate(url, body));
      }),
    };
    const provider = new MomoPaymentProvider(
      config,
      http as unknown as MomoHttpClient,
    );
    payments = new PaymentsService(dataSource, provider, 'VND');
    ipn = new MomoIpnService(dataSource, payments, config);
    const promotions = new PromotionsService(dataSource);
    orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramService,
      promotions,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('persists momo identity before one idempotent create and returns payUrl without succeeding', async () => {
    const fixture = await checkout('momo-create');
    const first = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'momo-create-key',
    );
    const repeated = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'momo-create-key',
    );
    const stored = await paymentOf(first.id);
    const orderId = buildMomoOrderId(first.id, config.identitySecret);
    const requestId = buildMomoRequestId(first.id, config.identitySecret);

    expect(first).toEqual(
      expect.objectContaining({
        provider: 'momo',
        amount: 400_000,
        currency: 'VND',
        status: PaymentStatus.PROCESSING,
        checkoutUrl: `https://test-payment.momo.vn/pay/${orderId}`,
      }),
    );
    expect(repeated.id).toBe(first.id);
    expect(repeated.status).toBe(PaymentStatus.PROCESSING);
    expect(repeated).not.toHaveProperty('checkoutUrl');
    expect(stored.providerPaymentId).toBe(orderId);
    await expect(
      payments.findMomoReturnOrder(fixture.user.id, orderId),
    ).resolves.toEqual({ orderId: fixture.order.id });
    const other = await dataSource.getRepository(User).save({
      email: 'momo-return-other@momo.test',
      password: 'hash',
      role: UserRole.USER,
    });
    await expect(
      payments.findMomoReturnOrder(other.id, orderId),
    ).rejects.toThrow('Payment return not found');
    expect(http.postJson).toHaveBeenCalledTimes(1);
    expect(createBodies[0]).toEqual(
      expect.objectContaining({
        orderId,
        requestId,
        amount: 400_000,
      }),
    );
  });

  it('verifies success, deduplicates retry, confirms Order and leaves stock unchanged', async () => {
    const fixture = await checkout('momo-success');
    const payment = await createPayment(fixture, 'momo-success-key');
    const stock = await stockOf(fixture.variant.id);
    const notification = signedIpn(payment, 0);

    await ipn.process(notification);
    await ipn.process(notification);

    expect((await paymentOf(payment.id)).status).toBe(PaymentStatus.SUCCEEDED);
    expect((await orderOf(fixture.order.id)).status).toBe(
      OrderStatus.CONFIRMED,
    );
    expect(await stockOf(fixture.variant.id)).toBe(stock);
    expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
  });

  it('fails closed for invalid signature and signed amount mismatch', async () => {
    const fixture = await checkout('momo-invalid');
    const payment = await createPayment(fixture, 'momo-invalid-key');
    const valid = signedIpn(payment, 0);

    await expect(
      ipn.process({ ...valid, signature: '0'.repeat(64) }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      ipn.process(signedIpn(payment, 0, { amount: payment.amount + 1 })),
    ).rejects.toThrow('MoMo amount mismatch');
    expect((await paymentOf(payment.id)).status).toBe(PaymentStatus.PROCESSING);
    expect((await orderOf(fixture.order.id)).status).toBe(OrderStatus.PENDING);
    expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);
  });

  it('keeps 9000 non-final and maps a known final failure without confirming Order', async () => {
    const processingFixture = await checkout('momo-processing');
    const processing = await createPayment(
      processingFixture,
      'momo-processing-key',
    );
    await ipn.process(signedIpn(processing, 9000));
    expect((await paymentOf(processing.id)).status).toBe(
      PaymentStatus.PROCESSING,
    );
    expect(await dataSource.getRepository(PaymentEvent).count()).toBe(0);

    const failedFixture = await checkout('momo-failure');
    const failed = await createPayment(failedFixture, 'momo-failure-key');
    await ipn.process(signedIpn(failed, 1006));
    expect((await paymentOf(failed.id)).status).toBe(PaymentStatus.FAILED);
    expect((await orderOf(failedFixture.order.id)).status).toBe(
      OrderStatus.PENDING,
    );
  });

  it('keeps ambiguous timeout mapped and reconcilable instead of falsely failing', async () => {
    const fixture = await checkout('momo-timeout');
    http.postJson.mockRejectedValueOnce(
      new PaymentProviderAmbiguousError('timeout'),
    );
    await expect(
      payments.createForOrder(
        fixture.user.id,
        fixture.order.id,
        'momo-timeout-key',
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    const stored = await dataSource
      .getRepository(Payment)
      .findOneByOrFail({ idempotencyKey: 'momo-timeout-key' });
    expect(stored.status).toBe(PaymentStatus.PROCESSING);
    expect(stored.providerPaymentId).toBe(
      buildMomoOrderId(stored.id, config.identitySecret),
    );
    expect(stored.failureCode).toBe('PROVIDER_OUTCOME_UNKNOWN');
  });

  it('blocks paid cancellation and preserves cancellation-success race invariant', async () => {
    const paidFixture = await checkout('momo-paid-cancel');
    const paid = await createPayment(paidFixture, 'momo-paid-cancel-key');
    await ipn.process(signedIpn(paid, 0));
    await expect(
      orders.cancelForUser(paidFixture.user.id, paidFixture.order.id),
    ).rejects.toBeInstanceOf(ConflictException);

    const raceFixture = await checkout('momo-race');
    const raced = await createPayment(raceFixture, 'momo-race-key');
    await Promise.allSettled([
      orders.cancelForUser(raceFixture.user.id, raceFixture.order.id),
      ipn.process(signedIpn(raced, 0)),
    ]);
    const finalPayment = await paymentOf(raced.id);
    const finalOrder = await orderOf(raceFixture.order.id);
    expect(
      finalOrder.status === OrderStatus.CANCELLED &&
        finalPayment.status === PaymentStatus.SUCCEEDED,
    ).toBe(false);
  });

  async function checkout(suffix: string) {
    const user = await dataSource.getRepository(User).save({
      email: `${suffix}@momo.test`,
      password: 'hash',
      role: UserRole.USER,
    });
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
    return { user, variant, order };
  }

  async function createPayment(
    fixture: Awaited<ReturnType<typeof checkout>>,
    key: string,
  ) {
    const view = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      key,
    );
    return paymentOf(view.id);
  }

  function signedIpn(
    payment: Payment,
    resultCode: number,
    overrides: Partial<MomoIpnDto> = {},
  ): MomoIpnDto {
    const input = {
      partnerCode: config.partnerCode,
      orderId: buildMomoOrderId(payment.id, config.identitySecret),
      requestId: buildMomoRequestId(payment.id, config.identitySecret),
      amount: payment.amount,
      orderInfo: `Payment ${payment.id}`,
      orderType: 'momo_wallet',
      transId: 900_000 + payment.id,
      resultCode,
      message: resultCode === 0 ? 'Successful.' : 'Provider result',
      payType: 'qr',
      responseTime: 1_700_000_000_000 + payment.id,
      extraData: '',
      ...overrides,
    };
    const canonical = buildMomoIpnCanonical({
      accessKey: config.accessKey,
      ...input,
    });
    return {
      ...input,
      signature: signMomo(canonical, config.secretKey),
    };
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

  function successfulCreate(_url: string, body: Record<string, unknown>) {
    return {
      partnerCode: body.partnerCode,
      orderId: body.orderId,
      requestId: body.requestId,
      amount: body.amount,
      resultCode: 0,
      payUrl: `https://test-payment.momo.vn/pay/${body.orderId as string}`,
    };
  }
});
