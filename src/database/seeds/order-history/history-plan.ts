import { OrderStatus } from '../../../orders/entities/order-status.enum';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from '../../../payments/entities/payment-event-type.enum';
import { PaymentStatus } from '../../../payments/entities/payment-status.enum';
import type { Coupon } from '../../../promotions/entities/coupon.entity';
import { calculateOrderPricing } from '../../../promotions/promotions-calculator';
import {
  HISTORY_CANCELLED_SHARE,
  HISTORY_CUSTOMER_COUNT,
  HISTORY_DAYS,
  HISTORY_LOCAL_OFFSET_MINUTES,
  HISTORY_ORDER_COUNT,
  HISTORY_PENDING_COUNT,
  HISTORY_PENDING_MAX_AGE_MINUTES,
  HISTORY_REVIEW_TARGET,
  HISTORY_SEED,
  HISTORY_UNRESOLVED_EVENTS,
} from './history-config';
import { buildCustomers, type PlannedCustomer } from './history-people';
import { SeededRandom } from './history-random';
import { buildReviewText } from './review-text';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OFFSET_MS = HISTORY_LOCAL_OFFSET_MINUTES * MINUTE;

// The catalog as the plan sees it: active products with their active variants.
export interface HistoryVariant {
  id: number;
  productId: number;
  price: number;
  stock: number;
}

export interface HistoryProduct {
  id: number;
  variants: readonly HistoryVariant[];
}

export interface HistoryPlanInput {
  now: Date;
  products: readonly HistoryProduct[];
  // Only coupons that can be applied today (active, in their dates).
  coupons: readonly Coupon[];
  seed?: number;
}

export interface PlannedItem {
  variantId: number;
  productId: number;
  quantity: number;
  price: number;
}

export type PlannedEventKind = 'success' | 'failure';

export interface PlannedEvent {
  kind: PlannedEventKind;
  eventType: PaymentEventType;
  processingStatus: PaymentEventProcessingStatus;
  processingMessage: string | null;
  createdAt: Date;
  processedAt: Date;
  // Set for an event an admin has handled; the seed adds who.
  resolution: { resolvedAt: Date; note: string } | null;
}

export interface PlannedPayment {
  attempt: number;
  status: PaymentStatus;
  amount: number;
  createdAt: Date;
  updatedAt: Date;
  succeededAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  events: PlannedEvent[];
}

export type CancellationKind = 'expired' | 'customer' | 'declined';

export interface PlannedOrder {
  // 1..N in time order; also the order's number in payment keys.
  key: number;
  customerIndex: number;
  createdAt: Date;
  updatedAt: Date;
  status: OrderStatus;
  items: PlannedItem[];
  subtotalPrice: number;
  discountPrice: number;
  totalPrice: number;
  couponCode: string | null;
  couponType: string | null;
  couponValue: number | null;
  payments: PlannedPayment[];
  cancellation: CancellationKind | null;
}

export interface PlannedReview {
  customerIndex: number;
  productId: number;
  rating: number;
  title: string;
  body: string | null;
  createdAt: Date;
}

export interface PlannedCustomerWithDate extends PlannedCustomer {
  createdAt: Date;
}

export interface HistoryPlan {
  customers: PlannedCustomerWithDate[];
  orders: PlannedOrder[];
  reviews: PlannedReview[];
}

export const LATE_SUCCESS_MESSAGE =
  'Provider success conflicts with terminal Payment or non-pending Order';
export const LATE_FAILURE_MESSAGE = 'Provider failure arrived after success';
export const DECLINED_FAILURE_CODE = 'DEMO_FAILURE';
export const DECLINED_FAILURE_MESSAGE = 'Demo payment was declined';

const RESOLVED_NOTES: Record<PaymentEventKind, readonly string[]> = {
  success: [
    'Confirmed the charge with the provider and refunded it manually. The customer was told by email.',
    'Provider confirmed the money was taken after the order expired. Refunded in the provider portal.',
  ],
  failure: [
    'Checked with the provider: the original payment did succeed, so the late failure notice was ignored.',
    'Order was already paid and shipped. The late failure came from a duplicate callback; no action needed.',
  ],
};

type PaymentEventKind = PlannedEventKind;

// Hours of the day (local time) and how busy each is: quiet at night, a small
// lunchtime bump and a clear evening peak.
const HOUR_WEIGHTS = [
  0.2, 0.1, 0.05, 0.05, 0.05, 0.1, 0.3, 0.7, 0.9, 1, 1, 1.2, 1.2, 1, 0.9, 0.9,
  1, 1.1, 1.5, 1.8, 1.9, 1.7, 1.1, 0.6,
];

const BASKET_SIZES = [1, 2, 3, 4];
const BASKET_WEIGHTS = [45, 30, 17, 8];
const QUANTITIES = [1, 2, 3];
const QUANTITY_WEIGHTS = [85, 12, 3];
const RATINGS = [5, 4, 3, 2, 1];
const RATING_WEIGHTS = [45, 30, 13, 7, 5];

const COUPON_CHANCE = 0.28;
const FAILED_FIRST_ATTEMPT_CHANCE = 0.06;

export function buildHistoryPlan(input: HistoryPlanInput): HistoryPlan {
  const random = new SeededRandom(input.seed ?? HISTORY_SEED);
  const now = input.now.getTime();
  const products = input.products.filter(
    (product) => product.variants.length > 0,
  );
  if (products.length === 0) {
    throw new Error(
      'The history needs at least one active product with a variant',
    );
  }

  const customers = buildCustomers(random, HISTORY_CUSTOMER_COUNT);
  const popularity = products.map(() => 0.2 + Math.pow(random.next(), 2.2) * 5);
  const customerWeights = random
    .shuffle(customers.map((_, index) => index))
    .map((customerIndex, rank) => ({
      customerIndex,
      weight: 1 / Math.pow(rank + 1, 0.4),
    }))
    .sort((a, b) => a.customerIndex - b.customerIndex)
    .map((entry) => entry.weight);

  const historical = HISTORY_ORDER_COUNT - HISTORY_PENDING_COUNT;
  const times = [
    ...historicalTimes(random, now, historical),
    ...pendingTimes(random, now, HISTORY_PENDING_COUNT),
  ].sort((a, b) => a - b);

  // Pending orders reserve stock like a real checkout, so the plan never reserves
  // more of a variant than it has.
  const reservable = new Map<number, number>();
  for (const product of products) {
    for (const variant of product.variants) {
      reservable.set(variant.id, variant.stock);
    }
  }

  const pendingFrom = times.length - HISTORY_PENDING_COUNT;
  const cancelledCount = Math.round(
    HISTORY_ORDER_COUNT * HISTORY_CANCELLED_SHARE,
  );
  const cancelledKeys = new Set(
    random
      .shuffle(Array.from({ length: pendingFrom }, (_, index) => index + 1))
      .slice(0, cancelledCount),
  );

  const orders: PlannedOrder[] = times.map((time, index) => {
    const key = index + 1;
    const isPending = index >= pendingFrom;
    const createdAt = new Date(time);
    const basket = buildBasket(random, products, popularity, {
      reservable: isPending ? reservable : null,
    });
    const pricing = priceBasket(random, basket, input.coupons, createdAt);
    const customerIndex = random.weightedIndex(customerWeights);
    const base = {
      key,
      customerIndex,
      createdAt,
      items: basket,
      ...pricing,
    };
    if (isPending) return pendingOrder(random, base);
    if (cancelledKeys.has(key)) return cancelledOrder(random, base, now);
    return paidOrder(random, base, now);
  });

  attachReconciliationEvents(random, orders, now);

  const customerRows = customers.map((customer, customerIndex) => {
    const firstOrder = orders.find(
      (order) => order.customerIndex === customerIndex,
    );
    const createdAt = firstOrder
      ? new Date(firstOrder.createdAt.getTime() - random.int(10, 4320) * MINUTE)
      : new Date(now - random.int(1, HISTORY_DAYS) * DAY);
    return { ...customer, createdAt };
  });

  return {
    customers: customerRows,
    orders,
    reviews: planReviews(random, orders, now),
  };
}

// --- when orders happen -----------------------------------------------------

function localDayStart(instant: number): number {
  return Math.floor((instant + OFFSET_MS) / DAY) * DAY - OFFSET_MS;
}

function historicalTimes(
  random: SeededRandom,
  now: number,
  count: number,
): number[] {
  const today = localDayStart(now);
  const latest = now - HOUR;
  const days = Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const start = today - (HISTORY_DAYS - 1 - index) * DAY;
    const weekday = new Date(start + OFFSET_MS).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // A gentle upward trend (+60% from the oldest day to today), weekends
    // half as busy again, and a little noise so no two days look alike.
    const trend = 1 + (0.6 * index) / (HISTORY_DAYS - 1);
    const noise = 0.9 + random.next() * 0.2;
    // The last hour belongs to the pending orders, so today only counts for
    // the part of the day that has passed before it.
    const open = Math.max(0, Math.min(DAY, latest - start)) / DAY;
    return { start, weight: trend * (weekend ? 1.5 : 1) * noise * open };
  });

  // Each day gets its share of the orders exactly (largest remainder), instead
  // of drawing days one by one: the weekend and trend shape is then a property
  // of the weights, not of luck.
  const perDay = allocate(
    count,
    days.map((day) => day.weight),
  );
  const times: number[] = [];
  days.forEach((day, index) => {
    for (let n = 0; n < perDay[index]; n += 1) {
      const hour = random.weightedIndex(HOUR_WEIGHTS);
      const time =
        day.start +
        hour * HOUR +
        random.int(0, 59) * MINUTE +
        random.int(0, 59) * SECOND;
      // Only today can be too late for its hour; then anywhere before the cut.
      times.push(
        time <= latest
          ? time
          : day.start + random.int(0, Math.max(0, latest - day.start)),
      );
    }
  });
  return times;
}

// Splits a total into whole numbers in proportion to the weights, summing to
// exactly the total (largest remainder, ties to the earlier day).
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new RangeError('At least one weight must be positive');
  const exact = weights.map((weight) => (weight / sum) * total);
  const counts = exact.map((value) => Math.floor(value));
  const missing = total - counts.reduce((a, b) => a + b, 0);
  exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    .slice(0, missing)
    .forEach(({ index }) => {
      counts[index] += 1;
    });
  return counts;
}

function pendingTimes(random: SeededRandom, now: number, count: number) {
  return Array.from(
    { length: count },
    () =>
      now -
      random.int(1, HISTORY_PENDING_MAX_AGE_MINUTES) * MINUTE -
      random.int(0, 59) * SECOND,
  );
}

// --- what is in an order ----------------------------------------------------

function buildBasket(
  random: SeededRandom,
  products: readonly HistoryProduct[],
  popularity: readonly number[],
  options: { reservable: Map<number, number> | null },
): PlannedItem[] {
  const size = random.weighted(BASKET_SIZES, BASKET_WEIGHTS);
  const chosen = new Set<number>();
  const items: PlannedItem[] = [];
  for (
    let attempt = 0;
    attempt < size * 20 && items.length < size;
    attempt += 1
  ) {
    const productIndex = random.weightedIndex(popularity);
    if (chosen.has(productIndex)) continue;
    const product = products[productIndex];
    const variant = random.pick(product.variants);
    const quantity = random.weighted(QUANTITIES, QUANTITY_WEIGHTS);
    if (options.reservable) {
      const left = options.reservable.get(variant.id) ?? 0;
      if (left < quantity) continue;
      options.reservable.set(variant.id, left - quantity);
    }
    chosen.add(productIndex);
    items.push({
      variantId: variant.id,
      productId: product.id,
      quantity,
      price: variant.price,
    });
  }
  if (items.length === 0) {
    throw new Error(
      'Could not build a basket: the active variants have no stock left to reserve for a pending order',
    );
  }
  return items.sort((a, b) => a.variantId - b.variantId);
}

// Totals the way checkout computes them: subtotal is the sum of price times
// quantity, the discount comes from the same calculator checkout uses, and there
// is no shipping fee in this model.
function priceBasket(
  random: SeededRandom,
  items: readonly PlannedItem[],
  coupons: readonly Coupon[],
  at: Date,
) {
  const subtotalPrice = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const none = {
    subtotalPrice,
    discountPrice: 0,
    totalPrice: subtotalPrice,
    couponCode: null as string | null,
    couponType: null as string | null,
    couponValue: null as number | null,
  };
  if (coupons.length === 0 || !random.chance(COUPON_CHANCE)) return none;

  const coupon = random.pick(coupons);
  try {
    const result = calculateOrderPricing(subtotalPrice, coupon, at);
    return {
      subtotalPrice,
      discountPrice: result.discount,
      totalPrice: result.total,
      couponCode: coupon.code,
      couponType: coupon.type,
      couponValue: coupon.value,
    };
  } catch {
    // Not eligible for this basket (for example below its minimum subtotal).
    return none;
  }
}

type OrderBase = Pick<
  PlannedOrder,
  | 'key'
  | 'customerIndex'
  | 'createdAt'
  | 'items'
  | 'subtotalPrice'
  | 'discountPrice'
  | 'totalPrice'
  | 'couponCode'
  | 'couponType'
  | 'couponValue'
>;

// --- the three kinds of order -----------------------------------------------

function at(order: OrderBase, offsetMs: number): Date {
  return new Date(order.createdAt.getTime() + offsetMs);
}

function pendingOrder(random: SeededRandom, order: OrderBase): PlannedOrder {
  // About half have already opened the payment page.
  const payments: PlannedPayment[] = [];
  if (random.chance(0.5)) {
    const created = at(order, random.int(20, 90) * SECOND);
    payments.push({
      attempt: 1,
      status: PaymentStatus.PROCESSING,
      amount: order.totalPrice,
      createdAt: created,
      updatedAt: created,
      succeededAt: null,
      failureCode: null,
      failureMessage: null,
      events: [],
    });
  }
  return {
    ...order,
    status: OrderStatus.PENDING,
    updatedAt: payments[0]?.updatedAt ?? order.createdAt,
    payments,
    cancellation: null,
  };
}

function failedAttempt(
  random: SeededRandom,
  order: OrderBase,
  attempt: number,
  startOffsetMs: number,
): PlannedPayment {
  const created = at(order, startOffsetMs);
  const failedAt = new Date(created.getTime() + random.int(5, 40) * SECOND);
  return {
    attempt,
    status: PaymentStatus.FAILED,
    amount: order.totalPrice,
    createdAt: created,
    updatedAt: failedAt,
    succeededAt: null,
    failureCode: DECLINED_FAILURE_CODE,
    failureMessage: DECLINED_FAILURE_MESSAGE,
    events: [
      {
        kind: 'failure',
        eventType: PaymentEventType.FAILED,
        processingStatus: PaymentEventProcessingStatus.PROCESSED,
        processingMessage: null,
        createdAt: failedAt,
        processedAt: failedAt,
        resolution: null,
      },
    ],
  };
}

function paidOrder(
  random: SeededRandom,
  order: OrderBase,
  now: number,
): PlannedOrder {
  const payments: PlannedPayment[] = [];
  let startOffset = random.int(20, 180) * SECOND;
  if (random.chance(FAILED_FIRST_ATTEMPT_CHANCE)) {
    const failed = failedAttempt(random, order, 1, startOffset);
    payments.push(failed);
    startOffset =
      failed.updatedAt.getTime() -
      order.createdAt.getTime() +
      random.int(1, 15) * MINUTE;
  }

  const paymentCreated = at(order, startOffset);
  const succeededAt = new Date(
    paymentCreated.getTime() + random.int(8, 90) * SECOND,
  );
  payments.push({
    attempt: payments.length + 1,
    status: PaymentStatus.SUCCEEDED,
    amount: order.totalPrice,
    createdAt: paymentCreated,
    updatedAt: succeededAt,
    succeededAt,
    failureCode: null,
    failureMessage: null,
    events: [
      {
        kind: 'success',
        eventType: PaymentEventType.SUCCEEDED,
        processingStatus: PaymentEventProcessingStatus.PROCESSED,
        processingMessage: null,
        createdAt: succeededAt,
        processedAt: succeededAt,
        resolution: null,
      },
    ],
  });

  // Confirmed the moment the payment lands, then the shop works through the
  // order. The status is the latest step already reached.
  const processingAt = succeededAt.getTime() + random.int(2, 20) * HOUR;
  const shippedAt = processingAt + random.int(8, 30) * HOUR;
  const deliveredAt =
    shippedAt + random.int(1, 4) * DAY + random.int(0, 600) * MINUTE;
  const steps: Array<[OrderStatus, number]> = [
    [OrderStatus.CONFIRMED, succeededAt.getTime()],
    [OrderStatus.PROCESSING, processingAt],
    [OrderStatus.SHIPPED, shippedAt],
    [OrderStatus.DELIVERED, deliveredAt],
  ];
  let status = OrderStatus.CONFIRMED;
  let changedAt = succeededAt.getTime();
  for (const [step, stepAt] of steps) {
    if (stepAt <= now) {
      status = step;
      changedAt = stepAt;
    }
  }
  return {
    ...order,
    status,
    updatedAt: new Date(changedAt),
    payments,
    cancellation: null,
  };
}

function cancelledOrder(
  random: SeededRandom,
  order: OrderBase,
  now: number,
): PlannedOrder {
  const kind = random.weighted<CancellationKind>(
    ['expired', 'customer', 'declined'],
    [55, 28, 17],
  );
  const latest = now - MINUTE;
  const clamp = (offsetMs: number) =>
    new Date(Math.min(order.createdAt.getTime() + offsetMs, latest));

  const payments: PlannedPayment[] = [];
  let cancelledAt: Date;
  if (kind === 'declined') {
    payments.push(
      failedAttempt(random, order, 1, random.int(20, 120) * SECOND),
    );
    // Nothing left to pay, so the expiry job cancels it after the window.
    cancelledAt = clamp(30 * MINUTE + random.int(0, 9) * MINUTE);
  } else {
    cancelledAt =
      kind === 'expired'
        ? clamp(
            30 * MINUTE +
              random.int(0, 9) * MINUTE +
              random.int(0, 59) * SECOND,
          )
        : clamp(random.int(2, 180) * MINUTE);
    // An expired order usually got as far as the payment page.
    const opened =
      kind === 'expired' ? random.chance(0.75) : random.chance(0.5);
    if (opened) {
      const created = at(order, random.int(30, 150) * SECOND);
      payments.push({
        attempt: 1,
        status: PaymentStatus.CANCELLED,
        amount: order.totalPrice,
        createdAt: created,
        updatedAt: cancelledAt,
        succeededAt: null,
        failureCode: null,
        failureMessage: null,
        events: [],
      });
    }
  }
  return {
    ...order,
    status: OrderStatus.CANCELLED,
    updatedAt: cancelledAt,
    payments,
    cancellation: kind,
  };
}

// --- reconciliation ---------------------------------------------------------

// Late provider callbacks that the payment code would have parked for a human:
//  - a success that arrives after the order expired (the payment is cancelled);
//  - a failure that arrives after the payment had already succeeded.
// 4 stay unresolved; 2 have been handled with a note.
function attachReconciliationEvents(
  random: SeededRandom,
  orders: readonly PlannedOrder[],
  now: number,
): void {
  const ageDays = (instant: Date) => (now - instant.getTime()) / DAY;

  const lateSuccess = orders.filter(
    (order) =>
      order.cancellation === 'expired' &&
      order.payments.length === 1 &&
      order.payments[0].status === PaymentStatus.CANCELLED &&
      ageDays(order.updatedAt) > 3,
  );
  const lateFailure = orders.filter(
    (order) =>
      (order.status === OrderStatus.SHIPPED ||
        order.status === OrderStatus.DELIVERED) &&
      order.payments.length === 1 &&
      ageDays(order.updatedAt) > 3,
  );

  // Per kind: the oldest event is the one an admin has already handled, the
  // newest ones are still open. Half of each total, so 1 handled and 2 open.
  const unresolvedPerKind = HISTORY_UNRESOLVED_EVENTS / 2;
  for (const [kind, candidates] of [
    ['success', lateSuccess],
    ['failure', lateFailure],
  ] as const) {
    const withEvent = candidates
      .map((order) => ({ order, event: lateEvent(random, kind, order) }))
      .sort(
        (a, b) => a.event.createdAt.getTime() - b.event.createdAt.getTime(),
      );
    const resolvedEntry = withEvent[0];
    if (
      withEvent.length < 1 + unresolvedPerKind ||
      ageDays(resolvedEntry.event.createdAt) <= 10
    ) {
      throw new Error(
        `Not enough suitable orders for the ${kind} reconciliation events`,
      );
    }

    resolvedEntry.event.resolution = {
      resolvedAt: new Date(
        Math.min(
          resolvedEntry.event.createdAt.getTime() + random.int(6, 72) * HOUR,
          now - HOUR,
        ),
      ),
      note: random.pick(RESOLVED_NOTES[kind]),
    };
    for (const { order, event } of [
      resolvedEntry,
      ...withEvent.slice(-unresolvedPerKind),
    ]) {
      order.payments[0].events.push(event);
    }
  }
}

function lateEvent(
  random: SeededRandom,
  kind: PlannedEventKind,
  order: PlannedOrder,
): PlannedEvent {
  const payment = order.payments[0];
  const createdAt =
    kind === 'success'
      ? new Date(order.updatedAt.getTime() + random.int(5, 90) * MINUTE)
      : new Date(
          (payment.succeededAt as Date).getTime() + random.int(1, 6) * HOUR,
        );
  return {
    kind,
    eventType:
      kind === 'success' ? PaymentEventType.SUCCEEDED : PaymentEventType.FAILED,
    processingStatus: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
    processingMessage:
      kind === 'success' ? LATE_SUCCESS_MESSAGE : LATE_FAILURE_MESSAGE,
    createdAt,
    processedAt: createdAt,
    resolution: null,
  };
}

// --- reviews ----------------------------------------------------------------

// Only a customer with a delivered order that held the product may review it,
// once per product (the unique key of the table). A review follows the delivery
// by one to fourteen days.
function planReviews(
  random: SeededRandom,
  orders: readonly PlannedOrder[],
  now: number,
): PlannedReview[] {
  const deliveredAt = new Map<
    string,
    { customerIndex: number; productId: number; at: number }
  >();
  for (const order of orders) {
    if (order.status !== OrderStatus.DELIVERED) continue;
    for (const item of order.items) {
      const id = `${order.customerIndex}:${item.productId}`;
      const known = deliveredAt.get(id);
      if (!known || order.updatedAt.getTime() < known.at) {
        deliveredAt.set(id, {
          customerIndex: order.customerIndex,
          productId: item.productId,
          at: order.updatedAt.getTime(),
        });
      }
    }
  }

  const eligible = random.shuffle(
    [...deliveredAt.values()].filter((entry) => entry.at <= now - 2 * DAY),
  );
  return eligible
    .slice(0, HISTORY_REVIEW_TARGET)
    .map((entry) => {
      const rating = random.weighted(RATINGS, RATING_WEIGHTS);
      const text = buildReviewText(random, rating);
      const createdAt = Math.min(
        entry.at + random.int(1, 14) * DAY + random.int(0, 20) * HOUR,
        now - HOUR,
      );
      return {
        customerIndex: entry.customerIndex,
        productId: entry.productId,
        rating,
        title: text.title,
        body: text.body,
        createdAt: new Date(createdAt),
      };
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
