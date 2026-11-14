# Load test results

> These are **local numbers from one laptop against an isolated test
> database**, with the demo payment provider. They show that the ordering and
> payment guarantees hold under concurrent requests. They are not a
> production benchmark and say nothing about capacity. See
> [concurrency-check.md](concurrency-check.md) for what each scenario proves
> and its limits.

Result of the run: **PASS**

| Item | Value |
| --- | --- |
| Date (UTC) | 2026-11-13T15:36:55.938Z |
| Run time | 29.81 s |
| OS | Windows_NT 10.0.26200 (x64) |
| CPU | 11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz (12 logical CPUs) |
| Memory | 16 GB |
| Node.js | v22.14.0 |
| PostgreSQL | PostgreSQL 16.14 |
| Parameters | customers 200, stock 10, parallel requests 20, orders per payment scenario 5 |

## Summary

| # | Scenario | Result | Requests | Unexpected | 429 | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Oversell | PASS | 200 | 0 | 0 | 1.65 s |
| 2 | Deadlock safety | PASS | 200 | 0 | 0 | 1.89 s |
| 3 | Payment idempotency | PASS | 200 | 0 | 0 | 1.98 s |
| 4 | Concurrent payment events | PASS | 100 | 0 | 0 | 925.1 ms |
| 5 | Cancellation against payment completion | PASS | 225 | 0 | 0 | 2.25 s |

## 1. Oversell: PASS

Many customers check out the same scarce variant at the same moment through their carts. Exactly as many orders succeed as there are units; everyone else is refused with the insufficient-stock error; stock ends at 0 and is never negative.

| Burst | Requests | Successes | Expected refusals | Unexpected | 429 | p50 | p95 | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200 carts check out together | 200 | 10 | 190 | 0 | 0 | 1.13 s | 1.57 s | 1.65 s | 121.0/s |

| Check | Result | Detail |
| --- | --- | --- |
| Exactly 10 orders succeeded | PASS | 10 succeeded |
| The other 190 were refused with insufficient stock | PASS | 190 refused |
| Final stock is 0 | PASS | stock 0 |
| Stock was never negative at any sample | PASS | 73 samples, lowest seen 0 |
| Ordered quantities add up to 10 | PASS | 10 orders, 10 units |
| No unexpected responses | PASS | 0 unexpected of 200 requests |
| No 429 (a 429 is a setup problem, not a pass) | PASS | 0 throttled |
| No 5xx responses | PASS | 0 server errors |
| No deadlock (40P01) in the backend output or in PostgreSQL | PASS | 0 in backend output, 0 counted by pg_stat_database |
| The backend logged no errors | PASS | 0 error lines |

- All 200 requests were sent in the same instant after 200 keep-alive connections were opened.

## 2. Deadlock safety: PASS

Customers order the same two variants in opposite orders (A,B and B,A). The service locks variants in ascending id order, so no deadlock can form. Successes never exceed the stock and both stock counts match the orders exactly.

| Burst | Requests | Successes | Expected refusals | Unexpected | 429 | p50 | p95 | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200 orders of both variants, half A,B and half B,A | 200 | 10 | 190 | 0 | 0 | 1.22 s | 1.79 s | 1.89 s | 105.7/s |

| Check | Result | Detail |
| --- | --- | --- |
| Successes never exceed the stock (10) | PASS | 10 succeeded |
| No sale was lost (all units were sold) | PASS | 10 of 10 units sold |
| Stock of A matches the orders | PASS | stock 0, ordered 10 |
| Stock of B matches the orders | PASS | stock 0, ordered 10 |
| Both variants sold the same number of units | PASS | A 10, B 10, orders 10 |
| Stock was never negative at any sample | PASS | 88 samples, lowest seen 0 |
| No unexpected responses | PASS | 0 unexpected of 200 requests |
| No 429 (a 429 is a setup problem, not a pass) | PASS | 0 throttled |
| No 5xx responses | PASS | 0 server errors |
| No deadlock (40P01) in the backend output or in PostgreSQL | PASS | 0 in backend output, 0 counted by pg_stat_database |
| The backend logged no errors | PASS | 0 error lines |

- Orders that succeeded: 5 sent as A,B and 5 sent as B,A.

## 3. Payment idempotency: PASS

Parallel create-payment requests with the same Idempotency-Key produce one payment and answer with that same payment. Parallel requests with different keys for one order produce exactly one active payment; the others are refused with the documented conflict.

| Burst | Requests | Successes | Expected refusals | Unexpected | 429 | p50 | p95 | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 orders x 20 requests, same key | 100 | 100 | 0 | 0 | 0 | 1.04 s | 1.10 s | 1.14 s | 87.8/s |
| 5 orders x 20 requests, different keys | 100 | 5 | 95 | 0 | 0 | 546.8 ms | 792.2 ms | 842.2 ms | 118.7/s |

| Check | Result | Detail |
| --- | --- | --- |
| Same key: one payment row per order | PASS | 5 of 5 orders |
| Same key: every answer names that one payment | PASS | 5 of 5 orders, 100 answers |
| Different keys: exactly one payment row per order, and it is active | PASS | 5 of 5 orders |
| Different keys: one accepted and 19 refused with the active-payment conflict | PASS | 5 of 5 orders |
| No unexpected responses | PASS | 0 unexpected of 200 requests |
| No 429 (a 429 is a setup problem, not a pass) | PASS | 0 throttled |
| No 5xx responses | PASS | 0 server errors |
| No deadlock (40P01) in the backend output or in PostgreSQL | PASS | 0 in backend output, 0 counted by pg_stat_database |
| The backend logged no errors | PASS | 0 error lines |

- With the same key the answers carry the same payment id, amount and currency. The status field can differ by a moment (pending or processing) because each request reads it at its own time.
- Each burst uses fresh unpaid orders, one customer per order; only the way the Idempotency-Key is chosen differs between the two bursts.

## 4. Concurrent payment events: PASS

Several different events reach the same demo payment at the same moment (success, failure and cancel, each repeated: a double click, a retry, a replayed callback). Whichever wins the payment lock decides the final state; the others are recorded for review or ignored. The payment ends in exactly one terminal state, the order matches it, and every event id is stored once.

| Burst | Requests | Successes | Expected refusals | Unexpected | 429 | p50 | p95 | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 payments x 20 completions, success / failure / cancel mixed | 100 | 100 | 0 | 0 | 0 | 824.9 ms | 909.4 ms | 925.1 ms | 108.1/s |

| Check | Result | Detail |
| --- | --- | --- |
| Every order has one payment in one terminal state, and the order matches it | PASS | 5 of 5 payments (final states: cancelled 4, succeeded 1) |
| Exactly one stored event per distinct event id sent (3 per payment) | PASS | 5 of 5 payments, 15 events stored |
| The stored events agree with the final state (the first event to win the lock decides) | PASS | 5 of 5 payments |
| Answers per event id: one "applied" and the rest "already_applied", or all "recorded_for_review" | PASS | 5 of 5 payments (already_applied 50, applied 9, recorded_for_review 41) |
| Completing did not change stock | PASS | stock 995 before, 995 after |
| No unexpected responses | PASS | 0 unexpected of 100 requests |
| No 429 (a 429 is a setup problem, not a pass) | PASS | 0 throttled |
| No 5xx responses | PASS | 0 server errors |
| No deadlock (40P01) in the backend output or in PostgreSQL | PASS | 0 in backend output, 0 counted by pg_stat_database |
| The backend logged no errors | PASS | 0 error lines |

- Each payment received 20 requests carrying 3 different event ids (success, failure, cancel, rotated); the same id is repeated 6 to 7 times.
- Which event wins the payment lock first is not fixed and decides the final state: a success first confirms the order and later failures and cancels are recorded for review; anything else first leaves the order pending and the late success is recorded for review. The split of final states varies between runs; every split is correct.

## 5. Cancellation against payment completion: PASS

A payment is completed and its unpaid order cancelled in all three orders of arrival: the payment first (a paid order can not be cancelled), the cancel first (a late success is recorded for review, never applied) and both at the same moment. Stock is returned exactly once for a cancelled order, even when the cancel is repeated, and never for a paid one.

| Burst | Requests | Successes | Expected refusals | Unexpected | 429 | p50 | p95 | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 paid orders: cancel sent after the payment completed | 5 | 0 | 5 | 0 | 0 | 59.7 ms | 64.4 ms | 66.5 ms | 75.2/s |
| 5 orders x 3 cancels at once | 15 | 5 | 10 | 0 | 0 | 89.6 ms | 108.2 ms | 111.3 ms | 134.8/s |
| 5 cancelled orders x 20 late completions | 100 | 100 | 0 | 0 | 0 | 808.5 ms | 839.3 ms | 855.9 ms | 116.8/s |
| 5 orders: 1 cancel + 20 completions at once | 105 | 105 | 0 | 0 | 0 | 1.15 s | 1.16 s | 1.22 s | 86.0/s |

| Check | Result | Detail |
| --- | --- | --- |
| Payment first: the completion was applied and the order is confirmed | PASS | 5 of 5 orders confirmed, 5 completions applied |
| Payment first: the later cancel is refused because the order is paid | PASS | 5 of 5 refused (cancel refused: paid 5) |
| Payment first: no stock was returned | PASS | stock 995 before, 995 after |
| Cancel first: exactly one of 3 cancels per order succeeded, the others were refused as already cancelled | PASS | 5 of 5 orders (cancel refused: already cancelled 10, cancelled 5) |
| Cancel first: stock was returned once and equals the original | PASS | before orders 1000, after cancels 1000, after late completions 1000 |
| Cancel first: every late completion is "recorded_for_review" | PASS | recorded_for_review 100 |
| Cancel first: orders and payments stay cancelled | PASS | 5 orders cancelled, 5 payments cancelled |
| Cancel first: one reconciliation event per payment | PASS | 5 of 5 payments |
| Race: every order ended in one consistent outcome (the winner is reported, not asserted) | PASS | 5 of 5 orders (cancel won 5, payment won 0) |
| Race: stock equals the original minus the orders that were paid | PASS | stock 1000; before 995, 0 paid, 5 cancelled and returned once each |
| No unexpected responses | PASS | 0 unexpected of 225 requests |
| No 429 (a 429 is a setup problem, not a pass) | PASS | 0 throttled |
| No 5xx responses | PASS | 0 server errors |
| No deadlock (40P01) in the backend output or in PostgreSQL | PASS | 0 in backend output, 0 counted by pg_stat_database |
| The backend logged no errors | PASS | 0 error lines |

- Who won, out of 5 orders in each group: payment first, the payment won 5 (the cancel was refused 5); cancel first, the cancel won 5 (late successes recorded for review); simultaneous race, the cancel won 5 and the payment won 0.
- The first two groups fix the order of arrival by waiting for the first request to be answered before the next is sent, so both orders are always exercised. In the simultaneous race either side may win and both outcomes are correct (cancel wins: the late success is recorded for review; payment wins: the cancel is refused because the order is paid). A mixed outcome would fail the check.
- Order expiry is not exercised: the expiry job is off when NODE_ENV=test, and expiry cancels through the same function as a cancel.

## Clean-up

| Item | Result |
| --- | --- |
| Backend process stopped | yes |
| Rows created by the run removed | yes |
| Seeded demo rows unchanged | yes |
| Rows removed | payment events 30, payments 30, order items 60, orders 50, cart items 190, carts 200, addresses 430, customers 430, variants 8, products 1, categories 1 |

