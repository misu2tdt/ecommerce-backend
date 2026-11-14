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
  warmUpConnections,
  type ApiResponse,
  type Classifier,
  type PlannedRequest,
} from './http';
import {
  DEMO_OUTCOMES,
  answersMatchEvent,
  classifyCancelAnswer,
  demoEventId,
  distinctOutcomes,
  eventsMatchPayment,
  expectedOrderStatus,
  isTerminalPaymentStatus,
  oneCancelWon,
  outcomeForAttempt,
  type DemoOutcomeName,
  type EventStatus,
} from './outcomes';
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
// Parallel cancels sent for each order in scenario 5, cancel-first group.
const CANCELS_PER_ORDER = 3;

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

// The documented answers to a cancel: it worked, the order is paid, or the
// order is already cancelled. Each scenario checks which of them it expects.
const cancellation: Classifier = (response) => {
  const answer = classifyCancelAnswer(response.status, messageOf(response));
  if (answer === 'cancelled') return { kind: 'success', tag: 'cancelled' };
  if (answer === 'other') return { kind: 'unexpected' };
  return { kind: 'expected_refusal', tag: `cancel ${answer}` };
};

const ANY_COMPLETION = completion([
  'applied',
  'already_applied',
  'recorded_for_review',
]);

function cancelAnswer(response: ApiResponse) {
  return classifyCancelAnswer(response.status, messageOf(response));
}

function cancelRequest(
  context: ScenarioContext,
  item: OrderWithPayment,
): PlannedRequest {
  return {
    send: () =>
      context.api.request('POST', `/orders/${item.orderId}/cancel`, {
        token: item.user.token,
      }),
    classify: cancellation,
  };
}

function completeRequest(
  context: ScenarioContext,
  item: OrderWithPayment,
  classify: Classifier,
  outcome: DemoOutcomeName = 'success',
): PlannedRequest {
  return {
    send: () =>
      context.api.request('POST', `/payments/${item.paymentId}/demo/complete`, {
        token: item.user.token,
        body: { outcome },
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

interface EventDetail {
  paymentId: number;
  providerEventId: string;
  processingStatus: string;
}

function eventDetails(
  ds: DataSource,
  paymentIds: number[],
): Promise<EventDetail[]> {
  return rows<EventDetail>(
    ds,
    `SELECT "paymentId", "providerEventId", "processingStatus"
     FROM "payment_events" WHERE "paymentId" = ANY($1::int[]) ORDER BY "id"`,
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

// 4. Concurrent payment events

const duplicateCompletion: ScenarioDefinition = {
  id: 4,
  title: 'Concurrent payment events',
  proves:
    'Several different events reach the same demo payment at the same moment (success, failure and cancel, each repeated: a double click, a retry, a replayed callback). Whichever wins the payment lock decides the final state; the others are recorded for review or ignored. The payment ends in exactly one terminal state, the order matches it, and every event id is stored once.',
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

    interface Planned {
      itemIndex: number;
      outcome: DemoOutcomeName;
      request: PlannedRequest;
    }
    // The outcome rotates over the parallel requests of a payment, so one
    // payment gets success, failure and cancel (three different event ids) at
    // once, each of them several times.
    const planned: Planned[] = shuffle(
      items.flatMap((item, itemIndex) =>
        Array.from({ length: parallel }, (_, attempt): Planned => {
          const outcome = outcomeForAttempt(attempt);
          return {
            itemIndex,
            outcome,
            request: completeRequest(context, item, ANY_COMPLETION, outcome),
          };
        }),
      ),
    );

    await warmUpConnections(context.api, planned.length);
    const { burst, responses } = await runBurst(
      `${orderCount} payments x ${parallel} completions, success / failure / cancel mixed`,
      planned.map((entry) => entry.request),
    );

    const orderIds = items.map((item) => item.orderId);
    const paymentIds = items.map((item) => item.paymentId);
    const statuses = await orderStatuses(context.ds, orderIds);
    const payments = await paymentRows(context.ds, orderIds);
    const events = await eventDetails(context.ds, paymentIds);
    const sentOutcomes = distinctOutcomes(parallel);

    let terminalAndMatching = 0;
    let eventIdsStoredOnce = 0;
    let eventsAgree = 0;
    let answersAgree = 0;
    const finalStates = new Map<string, number>();
    items.forEach((item, itemIndex) => {
      const stored = payments.filter((row) => row.orderId === item.orderId);
      const status = stored.length === 1 ? stored[0].status : undefined;
      if (status !== undefined) {
        finalStates.set(status, (finalStates.get(status) ?? 0) + 1);
      }
      if (
        status !== undefined &&
        isTerminalPaymentStatus(status) &&
        statuses.get(item.orderId) === expectedOrderStatus(status)
      ) {
        terminalAndMatching += 1;
      }

      const own = events.filter((event) => event.paymentId === item.paymentId);
      const expectedIds = sentOutcomes.map((outcome) =>
        demoEventId(item.paymentId, outcome),
      );
      if (
        own.length === expectedIds.length &&
        expectedIds.every((id) =>
          own.some((event) => event.providerEventId === id),
        )
      ) {
        eventIdsStoredOnce += 1;
      }

      const byOutcome = new Map<DemoOutcomeName, EventStatus>();
      for (const outcome of sentOutcomes) {
        const found = own.find(
          (event) =>
            event.providerEventId === demoEventId(item.paymentId, outcome),
        );
        if (
          found?.processingStatus === 'processed' ||
          found?.processingStatus === 'requires_reconciliation'
        ) {
          byOutcome.set(outcome, found.processingStatus);
        }
      }
      if (
        byOutcome.size === sentOutcomes.length &&
        eventsMatchPayment(status, byOutcome)
      ) {
        eventsAgree += 1;
      }

      if (
        sentOutcomes.every((outcome) =>
          answersMatchEvent(
            responses
              .filter(
                (_, index) =>
                  planned[index].itemIndex === itemIndex &&
                  planned[index].outcome === outcome,
              )
              .map((answer) => fieldOf(answer, 'result')),
            byOutcome.get(outcome),
          ),
        )
      ) {
        answersAgree += 1;
      }
    });
    const stockAfter = await variantStock(context.ds, variantId);
    const split =
      [...finalStates]
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([status, count]) => `${status} ${count}`)
        .join(', ') || 'none';

    return {
      bursts: [burst],
      checks: [
        check(
          'Every order has one payment in one terminal state, and the order matches it',
          terminalAndMatching === orderCount,
          `${ratio(terminalAndMatching, orderCount)} payments (final states: ${split})`,
        ),
        check(
          `Exactly one stored event per distinct event id sent (${sentOutcomes.length} per payment)`,
          eventIdsStoredOnce === orderCount &&
            events.length === orderCount * sentOutcomes.length,
          `${ratio(eventIdsStoredOnce, orderCount)} payments, ${events.length} events stored`,
        ),
        check(
          'The stored events agree with the final state (the first event to win the lock decides)',
          eventsAgree === orderCount,
          `${ratio(eventsAgree, orderCount)} payments`,
        ),
        check(
          'Answers per event id: one "applied" and the rest "already_applied", or all "recorded_for_review"',
          answersAgree === orderCount,
          `${ratio(answersAgree, orderCount)} payments (${describeTally(burst)})`,
        ),
        check(
          'Completing did not change stock',
          stockAfter === stockBefore,
          `stock ${stockBefore} before, ${stockAfter} after`,
        ),
      ],
      notes: [
        `Each payment received ${parallel} requests carrying ${sentOutcomes.length} different event ids (${DEMO_OUTCOMES.slice(0, sentOutcomes.length).join(', ')}, rotated); the same id is repeated ${Math.floor(parallel / DEMO_OUTCOMES.length)} to ${Math.ceil(parallel / DEMO_OUTCOMES.length)} times.`,
        'Which event wins the payment lock first is not fixed and decides the final state: a success first confirms the order and later failures and cancels are recorded for review; anything else first leaves the order pending and the late success is recorded for review. The split of final states varies between runs; every split is correct.',
      ],
    };
  },
};

// 5. Cancellation against payment completion

const lateCompletion: ScenarioDefinition = {
  id: 5,
  title: 'Cancellation against payment completion',
  proves:
    'A payment is completed and its unpaid order cancelled in all three orders of arrival: the payment first (a paid order can not be cancelled), the cancel first (a late success is recorded for review, never applied) and both at the same moment. Stock is returned exactly once for a cancelled order, even when the cancel is repeated, and never for a paid one.',
  async run(context) {
    const { orders: orderCount, parallel } = context.options;
    const paidVariant = await context.fixtures.createVariant(
      'late-paid-first',
      PLENTY_OF_STOCK,
    );
    const cancelVariant = await context.fixtures.createVariant(
      'late-cancel-first',
      PLENTY_OF_STOCK,
    );
    const raceVariant = await context.fixtures.createVariant(
      'late-race',
      PLENTY_OF_STOCK,
    );

    // 5a: the payment completes first, then a cancel arrives. Not a race: the
    // completion is answered before the cancel is sent.
    const paidItems = await ordersWithPayments(
      context,
      'paid-first',
      orderCount,
      paidVariant,
    );
    const stockBeforePaid = await variantStock(context.ds, paidVariant);
    const firstCompletions = await mapLimit(
      paidItems,
      SETUP_CONCURRENCY,
      async (item) =>
        requireOk(
          await completeRequest(context, item, ANY_COMPLETION).send(),
          'complete payment',
        ),
    );
    await warmUpConnections(context.api, orderCount);
    const cancelAfterPayment = await runBurst(
      `${orderCount} paid orders: cancel sent after the payment completed`,
      paidItems.map((item) => cancelRequest(context, item)),
    );
    const paidOrderIds = paidItems.map((item) => item.orderId);
    const paidStatuses = await orderStatuses(context.ds, paidOrderIds);
    const paidPayments = await paymentRows(context.ds, paidOrderIds);
    const paidEvents = await eventRows(
      context.ds,
      paidItems.map((item) => item.paymentId),
    );
    const stockAfterPaid = await variantStock(context.ds, paidVariant);
    const paidFirstApplied = firstCompletions.filter(
      (response) => fieldOf(response, 'result') === 'applied',
    ).length;
    const cancelRefusedPaid = cancelAfterPayment.responses.filter(
      (response) => cancelAnswer(response) === 'refused: paid',
    ).length;
    const paidAndConfirmed = paidItems.filter((item) => {
      const stored = paidPayments.filter((row) => row.orderId === item.orderId);
      return (
        paidStatuses.get(item.orderId) === 'confirmed' &&
        stored.length === 1 &&
        stored[0].status === 'succeeded'
      );
    }).length;
    const paidOneEvent = paidEvents.filter(
      (event) => event.total === 1 && event.processed === 1,
    ).length;

    // 5b: the cancel completes first (sent three times at once for each order),
    // then the payment is completed many times.
    const cancelItems = await ordersWithPayments(
      context,
      'cancel-first',
      orderCount,
      cancelVariant,
    );
    const stockBeforeCancel = await variantStock(context.ds, cancelVariant);
    await warmUpConnections(context.api, orderCount * CANCELS_PER_ORDER);
    const repeatedCancel = await runBurst(
      `${orderCount} orders x ${CANCELS_PER_ORDER} cancels at once`,
      cancelItems.flatMap((item) =>
        Array.from({ length: CANCELS_PER_ORDER }, () =>
          cancelRequest(context, item),
        ),
      ),
    );
    const stockAfterCancel = await variantStock(context.ds, cancelVariant);
    const oneCancelPerOrder = cancelItems.filter((_, orderIndex) =>
      oneCancelWon(
        repeatedCancel.responses
          .slice(
            orderIndex * CANCELS_PER_ORDER,
            (orderIndex + 1) * CANCELS_PER_ORDER,
          )
          .map(cancelAnswer),
      ),
    ).length;

    await warmUpConnections(context.api, orderCount * parallel);
    const lateAfterCancel = await runBurst(
      `${orderCount} cancelled orders x ${parallel} late completions`,
      cancelItems.flatMap((item) =>
        Array.from({ length: parallel }, () =>
          completeRequest(context, item, completion(['recorded_for_review'])),
        ),
      ),
    );
    const cancelOrderIds = cancelItems.map((item) => item.orderId);
    const cancelStatuses = await orderStatuses(context.ds, cancelOrderIds);
    const cancelPayments = await paymentRows(context.ds, cancelOrderIds);
    const cancelEvents = await eventRows(
      context.ds,
      cancelItems.map((item) => item.paymentId),
    );
    const stockAfterLate = await variantStock(context.ds, cancelVariant);

    // 5c: one cancel and many completions for each order at the same moment.
    // Either side may win, so only the consistency of the outcome is asserted;
    // the split of winners is reported.
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
        { orderIndex, kind: 'cancel', request: cancelRequest(context, item) },
        ...Array.from(
          { length: parallel },
          (): Planned => ({
            orderIndex,
            kind: 'complete',
            request: completeRequest(context, item, ANY_COMPLETION),
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
      const cancelResponse = answers.find(
        ({ entry }) => entry.kind === 'cancel',
      )?.response;
      const results = answers
        .filter(({ entry }) => entry.kind === 'complete')
        .map(({ response }) => fieldOf(response, 'result'));
      const status = raceStatuses.get(item.orderId);
      const payment = racePayments.find((row) => row.orderId === item.orderId);
      const event = raceEvents.find((row) => row.paymentId === item.paymentId);
      const cancelOutcome = cancelResponse && cancelAnswer(cancelResponse);

      if (cancelOutcome === 'cancelled') {
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
      } else if (cancelOutcome === 'refused: paid') {
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

    return {
      bursts: [
        cancelAfterPayment.burst,
        repeatedCancel.burst,
        lateAfterCancel.burst,
        race.burst,
      ],
      checks: [
        check(
          'Payment first: the completion was applied and the order is confirmed',
          paidFirstApplied === orderCount &&
            paidAndConfirmed === orderCount &&
            paidOneEvent === orderCount,
          `${ratio(paidAndConfirmed, orderCount)} orders confirmed, ${paidFirstApplied} completions applied`,
        ),
        check(
          'Payment first: the later cancel is refused because the order is paid',
          cancelRefusedPaid === orderCount,
          `${cancelRefusedPaid} of ${orderCount} refused (${describeTally(cancelAfterPayment.burst)})`,
        ),
        check(
          'Payment first: no stock was returned',
          stockAfterPaid === stockBeforePaid,
          `stock ${stockBeforePaid} before, ${stockAfterPaid} after`,
        ),
        check(
          `Cancel first: exactly one of ${CANCELS_PER_ORDER} cancels per order succeeded, the others were refused as already cancelled`,
          oneCancelPerOrder === orderCount,
          `${ratio(oneCancelPerOrder, orderCount)} orders (${describeTally(repeatedCancel.burst)})`,
        ),
        check(
          'Cancel first: stock was returned once and equals the original',
          stockAfterCancel === stockBeforeCancel + orderCount &&
            stockAfterLate === stockAfterCancel,
          `before orders ${stockBeforeCancel + orderCount}, after cancels ${stockAfterCancel}, after late completions ${stockAfterLate}`,
        ),
        check(
          'Cancel first: every late completion is "recorded_for_review"',
          countOf(lateAfterCancel.burst, 'success') === orderCount * parallel,
          describeTally(lateAfterCancel.burst),
        ),
        check(
          'Cancel first: orders and payments stay cancelled',
          cancelOrderIds.every(
            (id) => cancelStatuses.get(id) === 'cancelled',
          ) &&
            cancelPayments.length === orderCount &&
            cancelPayments.every((row) => row.status === 'cancelled'),
          `${cancelOrderIds.filter((id) => cancelStatuses.get(id) === 'cancelled').length} orders cancelled, ${cancelPayments.filter((row) => row.status === 'cancelled').length} payments cancelled`,
        ),
        check(
          'Cancel first: one reconciliation event per payment',
          cancelEvents.length === orderCount &&
            cancelEvents.every(
              (event) => event.total === 1 && event.reconciliation === 1,
            ),
          `${cancelEvents.filter((event) => event.total === 1 && event.reconciliation === 1).length} of ${orderCount} payments`,
        ),
        check(
          'Race: every order ended in one consistent outcome (the winner is reported, not asserted)',
          consistent === orderCount,
          `${ratio(consistent, orderCount)} orders (cancel won ${cancelWon}, payment won ${paymentWon})`,
        ),
        check(
          'Race: stock equals the original minus the orders that were paid',
          stockAfterRace === stockBeforeRace + (orderCount - confirmedInRace),
          `stock ${stockAfterRace}; before ${stockBeforeRace}, ${confirmedInRace} paid, ${orderCount - confirmedInRace} cancelled and returned once each`,
        ),
      ],
      notes: [
        `Who won, out of ${orderCount} orders in each group: payment first, the payment won ${paidAndConfirmed} (the cancel was refused ${cancelRefusedPaid}); cancel first, the cancel won ${oneCancelPerOrder} (late successes recorded for review); simultaneous race, the cancel won ${cancelWon} and the payment won ${paymentWon}.`,
        'The first two groups fix the order of arrival by waiting for the first request to be answered before the next is sent, so both orders are always exercised. In the simultaneous race either side may win and both outcomes are correct (cancel wins: the late success is recorded for review; payment wins: the cancel is refused because the order is paid). A mixed outcome would fail the check.',
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
