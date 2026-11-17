import { DataSource } from 'typeorm';
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
import {
  CreateProviderPaymentInput,
  CreateProviderPaymentResult,
  PaymentProvider,
} from '../../src/payments/payment-provider';
import { PaymentsService } from '../../src/payments/payments.service';
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

const STOCK = 5;
const QUANTITY = 2;
const LINK = 'https://pay.test/checkout/abc';

// A provider whose create call runs a hook in the middle, to play what happens
// while the real provider is being asked: the order is cancelled or expires.
class InFlightProvider extends PaymentProvider {
  readonly provider = 'fake';
  duringCreate: (() => Promise<void>) | null = null;

  getProviderPaymentId(paymentId: number): string {
    return `fake_payment_${paymentId}`;
  }

  async createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<CreateProviderPaymentResult> {
    await this.duringCreate?.();
    return {
      providerPaymentId: this.getProviderPaymentId(input.paymentId),
      initialStatus: PaymentStatus.PROCESSING,
      checkoutUrl: LINK,
      clientData: { token: 'abc' },
    };
  }
}

describe('a payment whose order ends while the provider is being asked (PostgreSQL)', () => {
  let dataSource: DataSource;
  let provider: InFlightProvider;
  let payments: PaymentsService;
  let orders: OrdersService;
  let counter = 0;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    provider = new InFlightProvider();
    payments = new PaymentsService(dataSource, provider, 'VND');
    orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramService,
      new PromotionsService(dataSource),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('control: with nothing in the way, the link is returned and the payment is processing', async () => {
    const fixture = await checkout();

    const view = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'in-flight-control-1',
    );

    expect(view.status).toBe(PaymentStatus.PROCESSING);
    expect(view).toMatchObject({
      checkoutUrl: LINK,
      clientData: { token: 'abc' },
    });
  });

  it('returns no link and ends cancelled when the customer cancels during the call', async () => {
    const fixture = await checkout();
    provider.duringCreate = async () => {
      await orders.cancelForUser(fixture.user.id, fixture.order.id);
    };

    const view = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'in-flight-cancel-1',
    );

    expect(view.status).toBe(PaymentStatus.CANCELLED);
    expect(view).not.toHaveProperty('checkoutUrl');
    expect(view).not.toHaveProperty('clientData');
    expect((await paymentOf(view.id)).status).toBe(PaymentStatus.CANCELLED);
    expect((await orderOf(fixture.order.id)).status).toBe(
      OrderStatus.CANCELLED,
    );
    expect(await stockOf(fixture.variantId)).toBe(STOCK);
  });

  it('returns no link and ends cancelled when the order expires during the call', async () => {
    const fixture = await checkout();
    provider.duringCreate = async () => {
      const result = await new OrderExpiryService(
        dataSource,
      ).expireOverdueOrders(new Date(Date.now() + 31 * 60_000));
      expect(result.expired).toBe(1);
    };

    const view = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'in-flight-expiry-1',
    );

    expect(view.status).toBe(PaymentStatus.CANCELLED);
    expect(view).not.toHaveProperty('checkoutUrl');
    expect((await orderOf(fixture.order.id)).status).toBe(
      OrderStatus.CANCELLED,
    );
    expect(await stockOf(fixture.variantId)).toBe(STOCK);
  });

  it('still sends a success that arrives later to reconciliation, changing nothing', async () => {
    const fixture = await checkout();
    provider.duringCreate = async () => {
      await orders.cancelForUser(fixture.user.id, fixture.order.id);
    };
    const view = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'in-flight-late-1',
    );
    expect(view).not.toHaveProperty('checkoutUrl');

    const late = await payments.processEvent({
      provider: 'fake',
      providerEventId: 'late-success-1',
      providerPaymentId: provider.getProviderPaymentId(view.id),
      eventType: PaymentEventType.SUCCEEDED,
    });

    expect(late.duplicate).toBe(false);
    expect((await paymentOf(view.id)).status).toBe(PaymentStatus.CANCELLED);
    expect((await orderOf(fixture.order.id)).status).toBe(
      OrderStatus.CANCELLED,
    );
    expect(await stockOf(fixture.variantId)).toBe(STOCK);
    const event = await dataSource
      .getRepository(PaymentEvent)
      .findOneByOrFail({ paymentId: view.id });
    expect(event).toMatchObject({
      eventType: PaymentEventType.SUCCEEDED,
      processingStatus: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
      resolvedAt: null,
    });
    expect(event.processedAt).not.toBeNull();
  });

  // ---- helpers ----------------------------------------------------------

  async function checkout() {
    counter += 1;
    const suffix = `in-flight-${counter}`;
    const user = await dataSource.getRepository(User).save({
      email: `${suffix}@in-flight.test`,
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
      stock: STOCK,
    });
    const order = await orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: QUANTITY }],
    });
    return { user, order, variantId: variant.id };
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
