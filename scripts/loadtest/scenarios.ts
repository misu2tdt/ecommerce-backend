// The five scenarios. Each one builds its own fixtures (customers, variants,
// orders), fires a burst of requests released together, then checks the result
// in the database as well as in the responses.

import type { DataSource } from 'typeorm';
import type { LoadTestOptions } from './args';
import {
  rows,
  startStockSampler,
  orderedForVariant,
  variantStock,
  type Customer,
  type Fixtures,
} from './database';
import {
  Api,
  fieldOf,
  mapLimit,
  messageOf,
  runBurst,
  shuffle,
  sleep,
  warmUpConnections,
  type ApiResponse,
  type Classifier,
  type PlannedRequest,
} from './http';
import { tally, type Burst, type Check } from './report';

export interface ScenarioContext {
  ds: DataSource;
  api: Api;
  options: LoadTestOptions;
  fixtures: Fixtures;
  runId: string;
  sign: (user: { id: number; email: string }) => Promise<string>;
}

export interface ScenarioOutcome {
  bursts: Burst[];
  checks: Check[];
  notes: string[];
}

export interface ScenarioDefinition {
  id: 1 | 2 | 3 | 4 | 5;
  title: string;
  proves: string;
  run(context: ScenarioContext): Promise<ScenarioOutcome>;
}

const SETUP_CONCURRENCY = 25;
const PLENTY_OF_STOCK = 1000;
const CANCEL_HEAD_START_MS = 15;

// Setup helpers

function isOk(response: ApiResponse): boolean {
  return response.status === 200 || response.status === 201;
}

function requireOk(response: ApiResponse, what: string): ApiResponse {
  if (!isOk(response)) {
    throw new Error(
      `Setup failed: ${what} answered ${response.status || 'no response'} ${messageOf(response)}`.trim(),
    );
  }
  return response;
}

function customers(
  context: ScenarioContext,
  tag: string,
  count: number,
): Promise<Customer[]> {
  return context.fixtures.createCustomers(tag, count, context.sign);
}

function placeOrder(
  context: ScenarioContext,
  user: Customer,
  variantIds: number[],
): Promise<number> {
  return context.api
    .request('POST', '/orders/checkout', {
      token: user.token,
      body: {
        addressId: user.addressId,
        items: variantIds.map((variantId) => ({ variantId, quantity: 1 })),
      },
    })
    .then((response) => {
      requireOk(response, 'order checkout');
      return fieldOf(response, 'id') as number;
    });
}

function openPayment(
  context: ScenarioContext,
  user: Customer,
  orderId: number,
  key: string,
): Promise<number> {
  return context.api
    .request('POST', `/orders/${orderId}/payments`, {
      token: user.token,
      headers: { 'Idempotency-Key': key },
    })
    .then((response) => {
      requireOk(response, 'create payment');
      return fieldOf(response, 'id') as number;
    });
}

interface OrderWithPayment {
  user: Customer;
  orderId: number;
  paymentId: number;
}

/** One customer, one unpaid order and one open payment for each. */
async function ordersWithPayments(
  context: ScenarioContext,
  tag: string,
  count: number,
  variantId: number,
): Promise<OrderWithPayment[]> {
  const users = await customers(context, tag, count);
  return mapLimit(users, SETUP_CONCURRENCY, async (user, index) => {
    const orderId = await placeOrder(context, user, [variantId]);
    const paymentId = await openPayment(
      context,
      user,
      orderId,
      `lt-${context.runId}-${tag}-open-${index}`,
    );
    return { user, orderId, paymentId };
  });
}

// Classifiers

// Same key: every answer must be the one payment. Anything else is unexpected.
const acceptedPayment: Classifier = (response) =>
  isOk(response) && typeof fieldOf(response, 'id') === 'number'
    ? { kind: 'success' }
    : { kind: 'unexpected' };

const checkout: Classifier = (response) => {
  if (isOk(response)) return { kind: 'success' };
  if (
    response.status === 400 &&
    /insufficient stock/i.test(messageOf(response))
  ) {
    return { kind: 'expected_refusal', tag: 'insufficient stock' };
  }
  return { kind: 'unexpected' };
};

const samePaymentOrActiveConflict: Classifier = (response) => {
  if (isOk(response) && typeof fieldOf(response, 'id') === 'number') {
    return { kind: 'success' };
  }
  if (response.status === 409 && /active payment/i.test(messageOf(response))) {
    return { kind: 'expected_refusal', tag: 'active payment conflict' };
  }
  return { kind: 'unexpected' };
};

function completion(allowed: readonly string[]): Classifier {
  return (response) => {
    const result = fieldOf(response, 'result');
    if (response.status === 200 && typeof result === 'string') {
      return allowed.includes(result)
        ? { kind: 'success', tag: result }
        : {
            kind: 'unexpected',
            tag: result,
            note: `completion answered "${result}", which is not allowed here`,
          };
    }
    return { kind: 'unexpected' };
  };
}

const cancellation: Classifier = (response) => {
  if (isOk(response)) return { kind: 'success', tag: 'cancelled' };
  if (
    response.status === 409 &&
    /paid order cannot be cancelled/i.test(messageOf(response))
  ) {
    return { kind: 'expected_refusal', tag: 'cancel refused: paid' };
  }
  return { kind: 'unexpected' };
};

function completeRequest(
  context: ScenarioContext,
  item: OrderWithPayment,
  classify: Classifier,
): PlannedRequest {
  return {
    send: () =>
      context.api.request('POST', `/payments/${item.paymentId}/demo/complete`, {
        token: item.user.token,
        body: { outcome: 'success' },
      }),
    classify,
  };
}

// Result helpers

function check(label: string, passed: boolean, detail: string): Check {
  return { label, passed, detail };
}

function countOf(burst: Burst, kind: string): number {
  return burst.records.filter((record) => record.kind === kind).length;
}

function ratio(good: number, total: number): string {
  return `${good} of ${total}`;
}

interface PaymentRow {
  id: number;
  orderId: number;
  status: string;
}

function paymentRows(
  ds: DataSource,
  orderIds: number[],
): Promise<PaymentRow[]> {
  return rows<PaymentRow>(
    ds,
    `SELECT "id", "orderId", "status" FROM "payments" WHERE "orderId" = ANY($1::int[]) ORDER BY "id"`,
    [orderIds],
  );
}

function orderStatuses(
  ds: DataSource,
  orderIds: number[],
): Promise<Map<number, string>> {
  return rows<{ id: number; status: string }>(
    ds,
    `SELECT "id", "status" FROM "orders" WHERE "id" = ANY($1::int[])`,
    [orderIds],
  ).then((found) => new Map(found.map((row) => [row.id, row.status])));
}

interface EventRow {
  paymentId: number;
  total: number;
  processed: number;
  reconciliation: number;
}

function eventRows(ds: DataSource, paymentIds: number[]): Promise<EventRow[]> {
  return rows<EventRow>(
    ds,
    `SELECT "paymentId",
            count(*)::int AS "total",
            count(*) FILTER (WHERE "processingStatus" = 'processed')::int AS "processed",
            count(*) FILTER (WHERE "processingStatus" = 'requires_reconciliation')::int AS "reconciliation"
     FROM "payment_events" WHERE "paymentId" = ANY($1::int[]) GROUP BY "paymentId"`,
    [paymentIds],
  );
}

function describeTally(burst: Burst): string {
  return (
    [...tally(burst.records)]
      .map(([tag, count]) => `${tag} ${count}`)
      .join(', ') || 'none'
  );
}

// 1. Oversell

const oversell: ScenarioDefinition = {
  id: 1,
  title: 'Oversell',
  proves:
    'Many customers check out the same scarce variant at the same moment through their carts. Exactly as many orders succeed as there are units; everyone else is refused with the insufficient-stock error; stock ends at 0 and is never negative.',
  async run(context) {
    const { customers: customerCount, stock } = context.options;
    const variantId = await context.fixtures.createVariant('oversell', stock);
    const users = await customers(context, 'oversell', customerCount);
    await mapLimit(users, SETUP_CONCURRENCY, async (user) =>
      requireOk(
        await context.api.request('POST', '/cart/items', {
          token: user.token,
          body: { variantId, quantity: 1 },
        }),
        'add to cart',
      ),
    );

    await warmUpConnections(context.api, customerCount);
    const sampler = startStockSampler(context.ds, [variantId]);
    const { burst } = await runBurst(
      `${customerCount} carts check out together`,
      users.map((user) => ({
        send: () =>
          context.api.request('POST', '/cart/checkout', {
            token: user.token,
            body: { addressId: user.addressId },
          }),
        classify: checkout,
      })),
    );
    const samples = await sampler.stop();

    const finalStock = await variantStock(context.ds, variantId);
    const ordered = await orderedForVariant(context.ds, variantId);
    const lowest = samples.minimum.get(variantId);
    const successes = countOf(burst, 'success');
    const refusals = countOf(burst, 'expected_refusal');

    return {
      bursts: [burst],
      checks: [
        check(
          `Exactly ${stock} orders succeeded`,
          successes === stock,
          `${successes} succeeded`,
        ),
        check(
          `The other ${customerCount - stock} were refused with insufficient stock`,
          refusals === customerCount - stock,
          `${refusals} refused`,
        ),
        check('Final stock is 0', finalStock === 0, `stock ${finalStock}`),
        check(
          'Stock was never negative at any sample',
          samples.samples > 0 && lowest !== undefined && lowest >= 0,
          `${samples.samples} samples, lowest seen ${lowest ?? 'none'}`,
        ),
        check(
          `Ordered quantities add up to ${stock}`,
          ordered.quantity === stock && ordered.orders === stock,
          `${ordered.orders} orders, ${ordered.quantity} units`,
        ),
      ],
      notes: [
        `All ${customerCount} requests were sent in the same instant after ${customerCount} keep-alive connections were opened.`,
      ],
    };
  },
};

// 2. Deadlock safety

const deadlockSafety: ScenarioDefinition = {
  id: 2,
  title: 'Deadlock safety',
  proves:
    'Customers order the same two variants in opposite orders (A,B and B,A). The service locks variants in ascending id order, so no deadlock can form. Successes never exceed the stock and both stock counts match the orders exactly.',
  async run(context) {
    const { customers: customerCount, stock } = context.options;
    const variantA = await context.fixtures.createVariant('pair-a', stock);
    const variantB = await context.fixtures.createVariant('pair-b', stock);
    const users = await customers(context, 'pair', customerCount);

    await warmUpConnections(context.api, customerCount);
    const sampler = startStockSampler(context.ds, [variantA, variantB]);
    const { burst, responses } = await runBurst(
      `${customerCount} orders of both variants, half A,B and half B,A`,
      users.map((user, index) => {
        const items =
          index % 2 === 0 ? [variantA, variantB] : [variantB, variantA];
        return {
          send: () =>
            context.api.request('POST', '/orders/checkout', {
              token: user.token,
              body: {
                addressId: user.addressId,
                items: items.map((variantId) => ({ variantId, quantity: 1 })),
              },
            }),
          classify: checkout,
        };
      }),
    );
    const samples = await sampler.stop();

    const stockA = await variantStock(context.ds, variantA);
    const stockB = await variantStock(context.ds, variantB);
    const orderedA = await orderedForVariant(context.ds, variantA);
    const orderedB = await orderedForVariant(context.ds, variantB);
    const successes = countOf(burst, 'success');
    const lowest = Math.min(
      samples.minimum.get(variantA) ?? Number.NEGATIVE_INFINITY,
      samples.minimum.get(variantB) ?? Number.NEGATIVE_INFINITY,
    );
    const wonInOrder = (parity: number) =>
      responses.filter(
        (response, index) => index % 2 === parity && isOk(response),
      ).length;

    return {
      bursts: [burst],
      checks: [
        check(
          `Successes never exceed the stock (${stock})`,
          successes <= stock,
          `${successes} succeeded`,
        ),
        check(
          'No sale was lost (all units were sold)',
          successes === stock,
          `${successes} of ${stock} units sold`,
        ),
        check(
          'Stock of A matches the orders',
          stockA === stock - orderedA.quantity,
          `stock ${stockA}, ordered ${orderedA.quantity}`,
        ),
        check(
          'Stock of B matches the orders',
          stockB === stock - orderedB.quantity,
          `stock ${stockB}, ordered ${orderedB.quantity}`,
        ),
        check(
          'Both variants sold the same number of units',
          orderedA.quantity === orderedB.quantity &&
            orderedA.orders === successes &&
            orderedB.orders === successes,
          `A ${orderedA.quantity}, B ${orderedB.quantity}, orders ${successes}`,
        ),
        check(
          'Stock was never negative at any sample',
          samples.samples > 0 && lowest >= 0,
          `${samples.samples} samples, lowest seen ${lowest}`,
        ),
      ],
      notes: [
        `Orders that succeeded: ${wonInOrder(0)} sent as A,B and ${wonInOrder(1)} sent as B,A.`,
      ],
    };
  },
};

// 3. Payment idempotency

const paymentIdempotency: ScenarioDefinition = {
  id: 3,
  title: 'Payment idempotency',
  proves:
    'Parallel create-payment requests with the same Idempotency-Key produce one payment and answer with that same payment. Parallel requests with different keys for one order produce exactly one active payment; the others are refused with the documented conflict.',
  async run(context) {
    const { orders: orderCount, parallel } = context.options;
    const variantId = await context.fixtures.createVariant(
      'payments',
      PLENTY_OF_STOCK,
    );

    const sameUsers = await customers(context, 'same-key', orderCount);
    const sameOrders = await mapLimit(sameUsers, SETUP_CONCURRENCY, (user) =>
      placeOrder(context, user, [variantId]),
    );
    const differentUsers = await customers(context, 'diff-keys', orderCount);
    const differentOrders = await mapLimit(
      differentUsers,
      SETUP_CONCURRENCY,
      (user) => placeOrder(context, user, [variantId]),
    );

    const createRequest = (
      user: Customer,
      orderId: number,
      key: string,
      classify: Classifier,
    ): PlannedRequest => ({
      send: () =>
        context.api.request('POST', `/orders/${orderId}/payments`, {
          token: user.token,
          headers: { 'Idempotency-Key': key },
        }),
      classify,
    });

    // 3a: the same key, many times, for each order.
    await warmUpConnections(context.api, orderCount * parallel);
    const same = await runBurst(
      `${orderCount} orders x ${parallel} requests, same key`,
      sameOrders.flatMap((orderId, orderIndex) =>
        Array.from({ length: parallel }, () =>
          createRequest(
            sameUsers[orderIndex],
            orderId,
            `lt-${context.runId}-same-${orderIndex}`,
            acceptedPayment,
          ),
        ),
      ),
    );

    // 3b: a different key every time, for each order.
    await warmUpConnections(context.api, orderCount * parallel);
    const different = await runBurst(
      `${orderCount} orders x ${parallel} requests, different keys`,
      differentOrders.flatMap((orderId, orderIndex) =>
        Array.from({ length: parallel }, (_, attempt) =>
          createRequest(
            differentUsers[orderIndex],
            orderId,
            `lt-${context.runId}-diff-${orderIndex}-${attempt}`,
            samePaymentOrActiveConflict,
          ),
        ),
      ),
    );

    const sameRows = await paymentRows(context.ds, sameOrders);
    const differentRows = await paymentRows(context.ds, differentOrders);
    const rowsOf = (all: PaymentRow[], orderId: number) =>
      all.filter((row) => row.orderId === orderId);

    // Per order: do all answers name the one stored payment?
    let sameConsistent = 0;
    let singleSame = 0;
    sameOrders.forEach((orderId, orderIndex) => {
      const stored = rowsOf(sameRows, orderId);
      if (stored.length === 1) singleSame += 1;
      const answers = same.responses.slice(
        orderIndex * parallel,
        (orderIndex + 1) * parallel,
      );
      if (
        stored.length === 1 &&
        answers.every((answer) => fieldOf(answer, 'id') === stored[0].id)
      ) {
        sameConsistent += 1;
      }
    });

    let singleActive = 0;
    let oneAcceptedRestRefused = 0;
    differentOrders.forEach((orderId, orderIndex) => {
      const stored = rowsOf(differentRows, orderId);
      const active = stored.filter((row) =>
        ['pending', 'processing'].includes(row.status),
      );
      if (stored.length === 1 && active.length === 1) singleActive += 1;
      const answers = different.responses.slice(
        orderIndex * parallel,
        (orderIndex + 1) * parallel,
      );
      const accepted = answers.filter(isOk);
      const refused = answers.filter(
        (answer) =>
          answer.status === 409 && /active payment/i.test(messageOf(answer)),
      );
      if (
        accepted.length === 1 &&
        refused.length === parallel - 1 &&
        stored.length === 1 &&
        fieldOf(accepted[0], 'id') === stored[0].id
      ) {
        oneAcceptedRestRefused += 1;
      }
    });

    return {
      bursts: [same.burst, different.burst],
      checks: [
        check(
          'Same key: one payment row per order',
          singleSame === orderCount,
          `${ratio(singleSame, orderCount)} orders`,
        ),
        check(
          'Same key: every answer names that one payment',
          sameConsistent === orderCount,
          `${ratio(sameConsistent, orderCount)} orders, ${same.burst.records.length} answers`,
        ),
        check(
          'Different keys: exactly one payment row per order, and it is active',
          singleActive === orderCount,
          `${ratio(singleActive, orderCount)} orders`,
        ),
        check(
          `Different keys: one accepted and ${parallel - 1} refused with the active-payment conflict`,
          oneAcceptedRestRefused === orderCount,
          `${ratio(oneAcceptedRestRefused, orderCount)} orders`,
        ),
      ],
      notes: [
        'With the same key the answers carry the same payment id, amount and currency. The status field can differ by a moment (pending or processing) because each request reads it at its own time.',
        'Each burst uses fresh unpaid orders, one customer per order; only the way the Idempotency-Key is chosen differs between the two bursts.',
      ],
    };
  },
};

// 4. Duplicate completion

const duplicateCompletion: ScenarioDefinition = {
  id: 4,
  title: 'Duplicate completion',
  proves:
    'The same demo payment is completed many times in parallel (a double click, a retry, a replayed callback). The order is confirmed exactly once: one request reports "applied", all others "already_applied".',
  async run(context) {
    const { orders: orderCount, parallel } = context.options;
    const variantId = await context.fixtures.createVariant(
      'duplicate',
      PLENTY_OF_STOCK,
    );
    const items = await ordersWithPayments(
      context,
      'duplicate',
      orderCount,
      variantId,
    );
    const stockBefore = await variantStock(context.ds, variantId);

    await warmUpConnections(context.api, orderCount * parallel);
    const { burst, responses } = await runBurst(
      `${orderCount} payments x ${parallel} completions`,
      items.flatMap((item) =>
        Array.from({ length: parallel }, () =>
          completeRequest(
            context,
            item,
            completion(['applied', 'already_applied']),
          ),
        ),
      ),
    );

    let exactlyOnce = 0;
    items.forEach((_, index) => {
      const answers = responses.slice(index * parallel, (index + 1) * parallel);
      const results = answers.map((answer) => fieldOf(answer, 'result'));
      if (
        results.filter((result) => result === 'applied').length === 1 &&
        results.filter((result) => result === 'already_applied').length ===
          parallel - 1
      ) {
        exactlyOnce += 1;
      }
    });

    const orderIds = items.map((item) => item.orderId);
    const paymentIds = items.map((item) => item.paymentId);
    const statuses = await orderStatuses(context.ds, orderIds);
    const payments = await paymentRows(context.ds, orderIds);
    const events = await eventRows(context.ds, paymentIds);
    const confirmed = orderIds.filter(
      (id) => statuses.get(id) === 'confirmed',
    ).length;
    const succeeded = orderIds.filter((id) => {
      const stored = payments.filter((row) => row.orderId === id);
      return stored.length === 1 && stored[0].status === 'succeeded';
    }).length;
    const oneEvent = events.filter(
      (event) => event.total === 1 && event.processed === 1,
    ).length;
    const stockAfter = await variantStock(context.ds, variantId);

    return {
      bursts: [burst],
      checks: [
        check(
          `One "applied" and ${parallel - 1} "already_applied" per payment`,
          exactlyOnce === orderCount,
          `${ratio(exactlyOnce, orderCount)} payments (${describeTally(burst)})`,
        ),
        check(
          'Every order is confirmed',
          confirmed === orderCount,
          `${ratio(confirmed, orderCount)} orders`,
        ),
        check(
          'Every order has exactly one payment, and it succeeded',
          succeeded === orderCount,
          `${ratio(succeeded, orderCount)} orders`,
        ),
        check(
          'Exactly one processed payment event per payment',
          oneEvent === orderCount && events.length === orderCount,
          `${ratio(oneEvent, orderCount)} payments`,
        ),
        check(
          'Confirming did not change stock',
          stockAfter === stockBefore,
          `stock ${stockBefore} before, ${stockAfter} after`,
        ),
      ],
      notes: [],
    };
  },
};

// 5. Late completion after cancellation

const lateCompletion: ScenarioDefinition = {
  id: 5,
  title: 'Late completion after cancellation',
  proves:
    'A payment is completed while its unpaid order is cancelled at the same moment, and again after the cancellation. A late success is recorded for review (requires reconciliation), never applied, and stock is returned once, never twice.',
  async run(context) {
    const { orders: orderCount, parallel } = context.options;
    const raceVariant = await context.fixtures.createVariant(
      'late-race',
      PLENTY_OF_STOCK,
    );
    const lateVariant = await context.fixtures.createVariant(
      'late-after',
      PLENTY_OF_STOCK,
    );

    // 5a: one cancel and many completions for each order, at the same moment.
    const raceItems = await ordersWithPayments(
      context,
      'race',
      orderCount,
      raceVariant,
    );
    const stockBeforeRace = await variantStock(context.ds, raceVariant);
    interface Planned {
      orderIndex: number;
      kind: 'cancel' | 'complete';
      request: PlannedRequest;
    }
    const planned: Planned[] = shuffle(
      raceItems.flatMap((item, orderIndex): Planned[] => [
        {
          orderIndex,
          kind: 'cancel',
          request: {
            send: async () => {
              // Every second cancel starts a few milliseconds late, so the
              // race is run in both orders: cancel first and payment first.
              if (orderIndex % 2 === 1) await sleep(CANCEL_HEAD_START_MS);
              return context.api.request(
                'POST',
                `/orders/${item.orderId}/cancel`,
                { token: item.user.token },
              );
            },
            classify: cancellation,
          },
        },
        ...Array.from(
          { length: parallel },
          (): Planned => ({
            orderIndex,
            kind: 'complete',
            request: completeRequest(
              context,
              item,
              completion(['applied', 'already_applied', 'recorded_for_review']),
            ),
          }),
        ),
      ]),
    );
    await warmUpConnections(context.api, planned.length);
    const race = await runBurst(
      `${orderCount} orders: 1 cancel + ${parallel} completions at once`,
      planned.map((entry) => entry.request),
    );

    const raceOrderIds = raceItems.map((item) => item.orderId);
    const raceStatuses = await orderStatuses(context.ds, raceOrderIds);
    const racePayments = await paymentRows(context.ds, raceOrderIds);
    const raceEvents = await eventRows(
      context.ds,
      raceItems.map((item) => item.paymentId),
    );
    let cancelWon = 0;
    let paymentWon = 0;
    let consistent = 0;
    raceItems.forEach((item, orderIndex) => {
      const answers = race.responses
        .map((response, index) => ({ response, entry: planned[index] }))
        .filter(({ entry }) => entry.orderIndex === orderIndex);
      const cancelAnswer = answers.find(
        ({ entry }) => entry.kind === 'cancel',
      )?.response;
      const results = answers
        .filter(({ entry }) => entry.kind === 'complete')
        .map(({ response }) => fieldOf(response, 'result'));
      const status = raceStatuses.get(item.orderId);
      const payment = racePayments.find((row) => row.orderId === item.orderId);
      const event = raceEvents.find((row) => row.paymentId === item.paymentId);

      if (cancelAnswer && isOk(cancelAnswer)) {
        cancelWon += 1;
        if (
          status === 'cancelled' &&
          payment?.status === 'cancelled' &&
          results.every((result) => result === 'recorded_for_review') &&
          event?.total === 1 &&
          event.reconciliation === 1
        ) {
          consistent += 1;
        }
      } else if (cancelAnswer?.status === 409) {
        paymentWon += 1;
        if (
          status === 'confirmed' &&
          payment?.status === 'succeeded' &&
          results.filter((result) => result === 'applied').length === 1 &&
          results.filter((result) => result === 'already_applied').length ===
            parallel - 1 &&
          event?.total === 1 &&
          event.processed === 1
        ) {
          consistent += 1;
        }
      }
    });
    const stockAfterRace = await variantStock(context.ds, raceVariant);
    const confirmedInRace = raceOrderIds.filter(
      (id) => raceStatuses.get(id) === 'confirmed',
    ).length;

    // 5b: cancel first, complete afterwards.
    const lateItems = await ordersWithPayments(
      context,
      'late',
      orderCount,
      lateVariant,
    );
    const stockBeforeLate = await variantStock(context.ds, lateVariant);
    await mapLimit(lateItems, SETUP_CONCURRENCY, async (item) =>
      requireOk(
        await context.api.request('POST', `/orders/${item.orderId}/cancel`, {
          token: item.user.token,
        }),
        'cancel order',
      ),
    );
    const stockAfterCancel = await variantStock(context.ds, lateVariant);
    await warmUpConnections(context.api, orderCount * parallel);
    const late = await runBurst(
      `${orderCount} cancelled orders x ${parallel} late completions`,
      lateItems.flatMap((item) =>
        Array.from({ length: parallel }, () =>
          completeRequest(context, item, completion(['recorded_for_review'])),
        ),
      ),
    );

    const lateOrderIds = lateItems.map((item) => item.orderId);
    const lateStatuses = await orderStatuses(context.ds, lateOrderIds);
    const latePayments = await paymentRows(context.ds, lateOrderIds);
    const lateEvents = await eventRows(
      context.ds,
      lateItems.map((item) => item.paymentId),
    );
    const stockAfterLate = await variantStock(context.ds, lateVariant);

    return {
      bursts: [race.burst, late.burst],
      checks: [
        check(
          'Race: every order ended in one consistent outcome',
          consistent === orderCount,
          `${ratio(consistent, orderCount)} orders (cancel won ${cancelWon}, payment won ${paymentWon})`,
        ),
        check(
          'Race: stock equals the original minus the orders that were paid',
          stockAfterRace === stockBeforeRace + (orderCount - confirmedInRace),
          `stock ${stockAfterRace}; before ${stockBeforeRace}, ${confirmedInRace} paid, ${orderCount - confirmedInRace} cancelled and returned once each`,
        ),
        check(
          'After cancel: every late completion is "recorded_for_review"',
          countOf(late.burst, 'success') === orderCount * parallel,
          describeTally(late.burst),
        ),
        check(
          'After cancel: orders and payments stay cancelled',
          lateOrderIds.every((id) => lateStatuses.get(id) === 'cancelled') &&
            latePayments.length === orderCount &&
            latePayments.every((row) => row.status === 'cancelled'),
          `${lateOrderIds.filter((id) => lateStatuses.get(id) === 'cancelled').length} orders cancelled, ${latePayments.filter((row) => row.status === 'cancelled').length} payments cancelled`,
        ),
        check(
          'After cancel: one reconciliation event per payment',
          lateEvents.length === orderCount &&
            lateEvents.every(
              (event) => event.total === 1 && event.reconciliation === 1,
            ),
          `${lateEvents.filter((event) => event.total === 1 && event.reconciliation === 1).length} of ${orderCount} payments`,
        ),
        check(
          'After cancel: stock was returned once and equals the original',
          stockAfterCancel === stockBeforeLate + orderCount &&
            stockAfterLate === stockAfterCancel,
          `before orders ${stockBeforeLate + orderCount}, after cancel ${stockAfterCancel}, after late completions ${stockAfterLate}`,
        ),
      ],
      notes: [
        'In the race either side may win, and both outcomes are correct: the cancel wins (the late success is recorded for review) or the payment wins (the cancel is refused because the order is paid). A mixed outcome would fail the check. Every second cancel is held back 15 ms so that both orderings occur.',
        'Order expiry is not exercised: the expiry job is off when NODE_ENV=test, and expiry cancels through the same function as a cancel.',
      ],
    };
  },
};

export const SCENARIOS: readonly ScenarioDefinition[] = [
  oversell,
  deadlockSafety,
  paymentIdempotency,
  duplicateCompletion,
  lateCompletion,
];
