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
| Date (UTC) | 2026-11-12T16:31:01.514Z |
| Run time | 20.94 s |
| OS | Windows_NT 10.0.26200 (x64) |
| CPU | 11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz (12 logical CPUs) |
| Memory | 16 GB |
| Node.js | v22.14.0 |
| PostgreSQL | PostgreSQL 16.14 |
| Parameters | customers 200, stock 10, parallel requests 20, orders per payment scenario 5 |

## Summary

| # | Scenario | Result | Requests | Unexpected | 429 | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Oversell | PASS | 200 | 0 | 0 | 1.06 s |
| 2 | Deadlock safety | PASS | 200 | 0 | 0 | 1.32 s |
| 3 | Payment idempotency | PASS | 200 | 0 | 0 | 1.13 s |
| 4 | Duplicate completion | PASS | 100 | 0 | 0 | 656.9 ms |
| 5 | Late completion after cancellation | PASS | 205 | 0 | 0 | 981.5 ms |

## 1. Oversell: PASS

Many customers check out the same scarce variant at the same moment through their carts. Exactly as many orders succeed as there are units; everyone else is refused with the insufficient-stock error; stock ends at 0 and is never negative.

| Burst | Requests | Successes | Expected refusals | Unexpected | 429 | p50 | p95 | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 200 carts check out together | 200 | 10 | 190 | 0 | 0 | 794.4 ms | 1.02 s | 1.06 s | 189.0/s |

| Check | Result | Detail |
| --- | --- | --- |
| Exactly 10 orders succeeded | PASS | 10 succeeded |
| The other 190 were refused with insufficient stock | PASS | 190 refused |
| Final stock is 0 | PASS | stock 0 |
| Stock was never negative at any sample | PASS | 48 samples, lowest seen 0 |
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
| 200 orders of both variants, half A,B and half B,A | 200 | 10 | 190 | 0 | 0 | 886.6 ms | 1.26 s | 1.32 s | 151.6/s |

| Check | Result | Detail |
| --- | --- | --- |
| Successes never exceed the stock (10) | PASS | 10 succeeded |
| No sale was lost (all units were sold) | PASS | 10 of 10 units sold |
| Stock of A matches the orders | PASS | stock 0, ordered 10 |
| Stock of B matches the orders | PASS | stock 0, ordered 10 |
| Both variants sold the same number of units | PASS | A 10, B 10, orders 10 |
| Stock was never negative at any sample | PASS | 65 samples, lowest seen 0 |
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
| 5 orders x 20 requests, same key | 100 | 100 | 0 | 0 | 0 | 601.3 ms | 623.5 ms | 637.4 ms | 156.9/s |
| 5 orders x 20 requests, different keys | 100 | 5 | 95 | 0 | 0 | 310.6 ms | 450.9 ms | 488.8 ms | 204.6/s |

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

## 4. Duplicate completion: PASS

The same demo payment is completed many times in parallel (a double click, a retry, a replayed callback). The order is confirmed exactly once: one request reports "applied", all others "already_applied".

| Burst | Requests | Successes | Expected refusals | Unexpected | 429 | p50 | p95 | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 payments x 20 completions | 100 | 100 | 0 | 0 | 0 | 628.5 ms | 643.3 ms | 656.9 ms | 152.2/s |

| Check | Result | Detail |
| --- | --- | --- |
| One "applied" and 19 "already_applied" per payment | PASS | 5 of 5 payments (already_applied 95, applied 5) |
| Every order is confirmed | PASS | 5 of 5 orders |
| Every order has exactly one payment, and it succeeded | PASS | 5 of 5 orders |
| Exactly one processed payment event per payment | PASS | 5 of 5 payments |
| Confirming did not change stock | PASS | stock 995 before, 995 after |
| No unexpected responses | PASS | 0 unexpected of 100 requests |
| No 429 (a 429 is a setup problem, not a pass) | PASS | 0 throttled |
| No 5xx responses | PASS | 0 server errors |
| No deadlock (40P01) in the backend output or in PostgreSQL | PASS | 0 in backend output, 0 counted by pg_stat_database |
| The backend logged no errors | PASS | 0 error lines |

## 5. Late completion after cancellation: PASS

A payment is completed while its unpaid order is cancelled at the same moment, and again after the cancellation. A late success is recorded for review (requires reconciliation), never applied, and stock is returned once, never twice.

| Burst | Requests | Successes | Expected refusals | Unexpected | 429 | p50 | p95 | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 orders: 1 cancel + 20 completions at once | 105 | 104 | 1 | 0 | 0 | 428.1 ms | 441.9 ms | 457.6 ms | 229.4/s |
| 5 cancelled orders x 20 late completions | 100 | 100 | 0 | 0 | 0 | 490.4 ms | 506.5 ms | 523.9 ms | 190.9/s |

| Check | Result | Detail |
| --- | --- | --- |
| Race: every order ended in one consistent outcome | PASS | 5 of 5 orders (cancel won 4, payment won 1) |
| Race: stock equals the original minus the orders that were paid | PASS | stock 999; before 995, 1 paid, 4 cancelled and returned once each |
| After cancel: every late completion is "recorded_for_review" | PASS | recorded_for_review 100 |
| After cancel: orders and payments stay cancelled | PASS | 5 orders cancelled, 5 payments cancelled |
| After cancel: one reconciliation event per payment | PASS | 5 of 5 payments |
| After cancel: stock was returned once and equals the original | PASS | before orders 1000, after cancel 1000, after late completions 1000 |
| No unexpected responses | PASS | 0 unexpected of 205 requests |
| No 429 (a 429 is a setup problem, not a pass) | PASS | 0 throttled |
| No 5xx responses | PASS | 0 server errors |
| No deadlock (40P01) in the backend output or in PostgreSQL | PASS | 0 in backend output, 0 counted by pg_stat_database |
| The backend logged no errors | PASS | 0 error lines |

- In the race either side may win, and both outcomes are correct: the cancel wins (the late success is recorded for review) or the payment wins (the cancel is refused because the order is paid). A mixed outcome would fail the check. Every second cancel is held back 15 ms so that both orderings occur.
- Order expiry is not exercised: the expiry job is off when NODE_ENV=test, and expiry cancels through the same function as a cancel.

## Clean-up

| Item | Result |
| --- | --- |
| Backend process stopped | yes |
| Rows created by the run removed | yes |
| Seeded demo rows unchanged | yes |
| Rows removed | payment events 15, payments 25, order items 55, orders 45, cart items 190, carts 200, addresses 425, customers 425, variants 7, products 1, categories 1 |

