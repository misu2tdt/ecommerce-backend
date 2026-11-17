import { OrderStatus } from '../../../orders/entities/order-status.enum';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from '../../../payments/entities/payment-event-type.enum';
import { PaymentStatus } from '../../../payments/entities/payment-status.enum';
import { CouponType } from '../../../promotions/entities/coupon-type.enum';
import { Coupon } from '../../../promotions/entities/coupon.entity';
import { calculateOrderPricing } from '../../../promotions/promotions-calculator';
import {
  HISTORY_CUSTOMER_COUNT,
  HISTORY_DAYS,
  HISTORY_ORDER_COUNT,
  HISTORY_PENDING_COUNT,
  HISTORY_PENDING_MAX_AGE_MINUTES,
} from './history-config';
import { HISTORY_EMAIL_DOMAIN } from './history-people';
import {
  allocate,
  buildHistoryPlan,
  LATE_FAILURE_MESSAGE,
  LATE_SUCCESS_MESSAGE,
  type HistoryProduct,
} from './history-plan';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date('2026-11-17T09:30:00.000Z');

function catalog(productCount = 60, stock = 8): HistoryProduct[] {
  return Array.from({ length: productCount }, (_, p) => ({
    id: p + 1,
    variants: Array.from({ length: 6 }, (_, v) => ({
      id: p * 6 + v + 1,
      productId: p + 1,
      price: 150_000 + ((p * 37 + v * 11) % 20) * 25_000,
      stock,
    })),
  }));
}

function coupon(
  code: string,
  type: CouponType,
  value: number,
  minSubtotal: number | null,
  maxDiscount: number | null,
): Coupon {
  return Object.assign(new Coupon(), {
    code,
    name: code,
    type,
    value,
    minSubtotal,
    maxDiscount,
    isActive: true,
    startsAt: null,
    endsAt: null,
  });
}

const COUPONS = [
  coupon('WELCOME10', CouponType.PERCENTAGE, 10, 300_000, 100_000),
  coupon('STYLE50', CouponType.FIXED, 50_000, 500_000, null),
];

describe('order history plan', () => {
  const products = catalog();
  const plan = buildHistoryPlan({ now: NOW, products, coupons: COUPONS });
  const count = (status: OrderStatus) =>
    plan.orders.filter((order) => order.status === status).length;
  const localDay = (date: Date) =>
    new Date(date.getTime() + 7 * 60 * MINUTE).getUTCDay();
  const price = new Map(
    products.flatMap((product) =>
      product.variants.map((variant) => [variant.id, variant.price] as const),
    ),
  );

  it('is deterministic: the same input gives the same plan, a different seed another', () => {
    const again = buildHistoryPlan({ now: NOW, products, coupons: COUPONS });
    const other = buildHistoryPlan({
      now: NOW,
      products,
      coupons: COUPONS,
      seed: 1,
    });

    expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(plan));
  });

  it('has 40 customers and 400 orders, numbered in time order', () => {
    expect(plan.customers).toHaveLength(HISTORY_CUSTOMER_COUNT);
    expect(plan.orders).toHaveLength(HISTORY_ORDER_COUNT);
    expect(plan.orders.map((order) => order.key)).toEqual(
      Array.from({ length: HISTORY_ORDER_COUNT }, (_, index) => index + 1),
    );
    const times = plan.orders.map((order) => order.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('keeps every order inside the last 90 days and never in the future', () => {
    const oldest = NOW.getTime() - (HISTORY_DAYS + 1) * DAY;
    for (const order of plan.orders) {
      expect(order.createdAt.getTime()).toBeGreaterThan(oldest);
      expect(order.createdAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(order.updatedAt.getTime()).toBeGreaterThanOrEqual(
        order.createdAt.getTime(),
      );
      expect(order.updatedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
  });

  it('is mostly delivered, with some shipped or confirmed and about 8% cancelled', () => {
    expect(count(OrderStatus.CANCELLED)).toBe(32);
    expect(count(OrderStatus.DELIVERED)).toBeGreaterThan(
      HISTORY_ORDER_COUNT * 0.75,
    );
    expect(count(OrderStatus.SHIPPED)).toBeGreaterThan(0);
    expect(
      count(OrderStatus.CONFIRMED) + count(OrderStatus.PROCESSING),
    ).toBeGreaterThan(0);
    expect(count(OrderStatus.PENDING)).toBe(HISTORY_PENDING_COUNT);
  });

  it('leaves pending only the orders of the last 28 minutes, never an old one', () => {
    for (const order of plan.orders) {
      const ageMinutes = (NOW.getTime() - order.createdAt.getTime()) / MINUTE;
      if (order.status === OrderStatus.PENDING) {
        expect(ageMinutes).toBeLessThanOrEqual(
          HISTORY_PENDING_MAX_AGE_MINUTES + 1,
        );
      } else {
        expect(ageMinutes).toBeGreaterThan(60);
      }
    }
  });

  it('has more orders on weekends and a gentle upward trend', () => {
    const weekend = plan.orders.filter((order) =>
      [0, 6].includes(localDay(order.createdAt)),
    ).length;
    const cut = NOW.getTime() - 45 * DAY;
    const early = plan.orders.filter(
      (order) => order.createdAt.getTime() < cut,
    ).length;
    const late = plan.orders.length - early;

    // Two weekend days of seven would be 28.6% on a flat week.
    expect(weekend / plan.orders.length).toBeGreaterThan(0.33);
    expect(late / early).toBeGreaterThan(1.15);
    expect(late / early).toBeLessThan(2);
  });

  it('builds baskets of one to four distinct products from the catalog, at its prices', () => {
    for (const order of plan.orders) {
      expect(order.items.length).toBeGreaterThanOrEqual(1);
      expect(order.items.length).toBeLessThanOrEqual(4);
      expect(new Set(order.items.map((item) => item.productId)).size).toBe(
        order.items.length,
      );
      for (const item of order.items) {
        expect(item.quantity).toBeGreaterThanOrEqual(1);
        expect(item.quantity).toBeLessThanOrEqual(3);
        expect(item.price).toBe(price.get(item.variantId));
      }
    }
  });

  it('prices every order the way checkout does: subtotal, discount from the calculator, no shipping', () => {
    for (const order of plan.orders) {
      const subtotal = order.items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0,
      );
      expect(order.subtotalPrice).toBe(subtotal);
      expect(order.totalPrice).toBe(order.subtotalPrice - order.discountPrice);
      expect(order.discountPrice).toBeGreaterThanOrEqual(0);
      expect(order.discountPrice).toBeLessThanOrEqual(order.subtotalPrice);

      if (order.couponCode === null) {
        expect(order.discountPrice).toBe(0);
        expect(order.couponType).toBeNull();
        expect(order.couponValue).toBeNull();
      } else {
        const used = COUPONS.find((entry) => entry.code === order.couponCode)!;
        const expected = calculateOrderPricing(subtotal, used, order.createdAt);
        expect(order.discountPrice).toBe(expected.discount);
        expect(order.couponType).toBe(used.type);
        expect(order.couponValue).toBe(used.value);
      }
    }
    expect(new Set(plan.orders.map((order) => order.couponCode))).toEqual(
      new Set([null, 'WELCOME10', 'STYLE50']),
    );
  });

  it('gives every order payments that fit its status', () => {
    for (const order of plan.orders) {
      const succeeded = order.payments.filter(
        (payment) => payment.status === PaymentStatus.SUCCEEDED,
      );
      const active = order.payments.filter((payment) =>
        [
          PaymentStatus.PENDING,
          PaymentStatus.PROCESSING,
          PaymentStatus.SUCCEEDED,
        ].includes(payment.status),
      );
      // The same rule as the database's one-active-payment index.
      expect(active.length).toBeLessThanOrEqual(1);

      switch (order.status) {
        case OrderStatus.CONFIRMED:
        case OrderStatus.PROCESSING:
        case OrderStatus.SHIPPED:
        case OrderStatus.DELIVERED:
          expect(succeeded).toHaveLength(1);
          expect(succeeded[0].amount).toBe(order.totalPrice);
          expect(succeeded[0].succeededAt).not.toBeNull();
          expect(succeeded[0].succeededAt!.getTime()).toBeGreaterThan(
            order.createdAt.getTime(),
          );
          break;
        case OrderStatus.CANCELLED:
          expect(succeeded).toHaveLength(0);
          expect(active).toHaveLength(0);
          break;
        case OrderStatus.PENDING:
          expect(succeeded).toHaveLength(0);
          for (const payment of order.payments) {
            expect(payment.status).toBe(PaymentStatus.PROCESSING);
          }
          break;
      }
      for (const payment of order.payments) {
        expect(payment.amount).toBe(order.totalPrice);
        expect(payment.succeededAt !== null).toBe(
          payment.status === PaymentStatus.SUCCEEDED,
        );
        expect(payment.failureCode !== null).toBe(
          payment.status === PaymentStatus.FAILED,
        );
        expect(payment.createdAt.getTime()).toBeGreaterThanOrEqual(
          order.createdAt.getTime(),
        );
        expect(payment.updatedAt.getTime()).toBeGreaterThanOrEqual(
          payment.createdAt.getTime(),
        );
      }
    }
  });

  it('has some failed first attempts that were followed by a successful retry', () => {
    const retried = plan.orders.filter(
      (order) =>
        order.status !== OrderStatus.CANCELLED &&
        order.payments.length === 2 &&
        order.payments[0].status === PaymentStatus.FAILED &&
        order.payments[1].status === PaymentStatus.SUCCEEDED,
    );

    expect(retried.length).toBeGreaterThan(5);
  });

  it('writes the late events a payment callback would have parked for a human', () => {
    const events = plan.orders.flatMap((order) =>
      order.payments.flatMap((payment) =>
        payment.events.map((event) => ({ order, payment, event })),
      ),
    );
    const parked = events.filter(
      ({ event }) =>
        event.processingStatus ===
        PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
    );
    const unresolved = parked.filter(({ event }) => event.resolution === null);
    const resolved = parked.filter(({ event }) => event.resolution !== null);

    expect(unresolved).toHaveLength(4);
    expect(resolved).toHaveLength(2);

    for (const { order, payment, event } of parked) {
      if (event.eventType === PaymentEventType.SUCCEEDED) {
        // A success after the order expired: the order and payment stay cancelled.
        expect(event.processingMessage).toBe(LATE_SUCCESS_MESSAGE);
        expect(order.status).toBe(OrderStatus.CANCELLED);
        expect(payment.status).toBe(PaymentStatus.CANCELLED);
        expect(event.createdAt.getTime()).toBeGreaterThan(
          order.updatedAt.getTime(),
        );
      } else {
        // A failure after success: the payment stays succeeded.
        expect(event.processingMessage).toBe(LATE_FAILURE_MESSAGE);
        expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
        expect(event.createdAt.getTime()).toBeGreaterThan(
          payment.succeededAt!.getTime(),
        );
      }
      expect(event.createdAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
    for (const { event } of resolved) {
      expect(event.resolution!.note.length).toBeGreaterThanOrEqual(3);
      expect(event.resolution!.note.length).toBeLessThanOrEqual(500);
      expect(event.resolution!.resolvedAt.getTime()).toBeGreaterThan(
        event.createdAt.getTime(),
      );
      expect(event.resolution!.resolvedAt.getTime()).toBeLessThanOrEqual(
        NOW.getTime(),
      );
    }
    // One handled and two open of each kind.
    const kinds = (list: typeof parked) =>
      list.map(({ event }) => event.kind).sort();
    expect(kinds(unresolved)).toEqual([
      'failure',
      'failure',
      'success',
      'success',
    ]);
    expect(kinds(resolved)).toEqual(['failure', 'success']);
  });

  it('has an event for every callback it models, with one event id per kind per payment', () => {
    for (const order of plan.orders) {
      for (const payment of order.payments) {
        const kinds = payment.events.map((event) => event.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
        if (payment.status === PaymentStatus.SUCCEEDED) {
          expect(kinds).toContain('success');
        }
      }
    }
  });

  it('reviews only products a customer received, once each, after the delivery', () => {
    expect(plan.reviews.length).toBeGreaterThanOrEqual(60);
    expect(plan.reviews.length).toBeLessThanOrEqual(100);

    const seen = new Set<string>();
    for (const review of plan.reviews) {
      const key = `${review.customerIndex}:${review.productId}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);

      const deliveries = plan.orders.filter(
        (order) =>
          order.customerIndex === review.customerIndex &&
          order.status === OrderStatus.DELIVERED &&
          order.items.some((item) => item.productId === review.productId),
      );
      expect(deliveries.length).toBeGreaterThan(0);
      const first = Math.min(
        ...deliveries.map((order) => order.updatedAt.getTime()),
      );
      expect(review.createdAt.getTime()).toBeGreaterThan(first);
      expect(review.createdAt.getTime()).toBeLessThan(NOW.getTime());
      expect(review.rating).toBeGreaterThanOrEqual(1);
      expect(review.rating).toBeLessThanOrEqual(5);
      expect(review.title.length).toBeLessThanOrEqual(150);
    }
  });

  it('skews ratings upward but still has some low ones', () => {
    const high = plan.reviews.filter((review) => review.rating >= 4).length;
    const low = plan.reviews.filter((review) => review.rating <= 2).length;

    expect(high / plan.reviews.length).toBeGreaterThan(0.6);
    expect(low).toBeGreaterThan(0);
  });

  it('creates each customer before their first order', () => {
    plan.customers.forEach((customer, index) => {
      expect(customer.email.endsWith(`@${HISTORY_EMAIL_DOMAIN}`)).toBe(true);
      const first = plan.orders.find((order) => order.customerIndex === index);
      if (first) {
        expect(customer.createdAt.getTime()).toBeLessThan(
          first.createdAt.getTime(),
        );
      }
      expect(customer.createdAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    });
  });

  it('never reserves more stock for pending orders than a variant has', () => {
    const reserved = new Map<number, number>();
    for (const order of plan.orders) {
      if (order.status !== OrderStatus.PENDING) continue;
      for (const item of order.items) {
        reserved.set(
          item.variantId,
          (reserved.get(item.variantId) ?? 0) + item.quantity,
        );
      }
    }

    expect(reserved.size).toBeGreaterThan(0);
    for (const [variantId, quantity] of reserved) {
      const variant = products
        .flatMap((product) => product.variants)
        .find((entry) => entry.id === variantId)!;
      expect(quantity).toBeLessThanOrEqual(variant.stock);
    }
  });

  it('works with little stock (pending orders pick what is left) and still has no negative reservation', () => {
    const small = buildHistoryPlan({
      now: NOW,
      products: catalog(60, 1),
      coupons: COUPONS,
    });
    const reserved = new Map<number, number>();
    for (const order of small.orders) {
      if (order.status !== OrderStatus.PENDING) continue;
      for (const item of order.items) {
        reserved.set(
          item.variantId,
          (reserved.get(item.variantId) ?? 0) + item.quantity,
        );
      }
    }

    for (const quantity of reserved.values()) expect(quantity).toBe(1);
  });

  it('works with no coupons and with a small catalog', () => {
    const small = buildHistoryPlan({
      now: NOW,
      products: catalog(8),
      coupons: [],
    });

    expect(small.orders).toHaveLength(HISTORY_ORDER_COUNT);
    expect(small.orders.every((order) => order.couponCode === null)).toBe(true);
  });

  it('works just after local midnight, when today has almost no usable hours', () => {
    // 17:30 UTC is 00:30 the next day in Vietnam.
    const justAfterMidnight = buildHistoryPlan({
      now: new Date('2026-11-17T17:30:00.000Z'),
      products,
      coupons: COUPONS,
    });

    expect(justAfterMidnight.orders).toHaveLength(HISTORY_ORDER_COUNT);
  });

  it('refuses an empty catalog', () => {
    expect(() =>
      buildHistoryPlan({ now: NOW, products: [], coupons: [] }),
    ).toThrow('at least one active product');
  });
});

describe('allocate', () => {
  it('splits a total in proportion to the weights and sums exactly', () => {
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocate(7, [1, 0, 1])).toEqual([4, 0, 3]);
    for (const total of [0, 1, 99, 394]) {
      const parts = allocate(total, [1.3, 0.2, 5, 2.7, 0.9]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((part) => Number.isInteger(part) && part >= 0)).toBe(
        true,
      );
    }
  });

  it('rejects weights that are all zero', () => {
    expect(() => allocate(5, [0, 0])).toThrow(RangeError);
  });
});
