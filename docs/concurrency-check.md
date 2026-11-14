# Concurrency check

A repeatable check that the ordering and payment guarantees hold when many
requests arrive at the same moment, with numbers. It is a script, not a CI test:
it takes about 30 seconds plus a build, writes real rows and starts the backend.

The latest figures are in [load-test-results.md](./load-test-results.md). They are
local numbers from one laptop against an isolated test database, not a production
benchmark.

## Run it

You need the isolated test database running (the `ecommerce_test` database of the
local test container) and its migrations applied. Set the environment for the one
command, then run it. PowerShell (use `npm.cmd`, because `npm` drops the flags
after `--`):

```powershell
$env:NODE_ENV = 'test'
$env:DB_HOST = 'localhost'
$env:DB_PORT = '<port of the test database>'
$env:DB_USERNAME = 'postgres'
$env:DB_NAME = 'ecommerce_test'
$env:ECOMMERCE_TEST_DB_PASSWORD = '<test database password>'
npm.cmd run loadtest:concurrency
```

```bash
NODE_ENV=test DB_PORT=<port> DB_NAME=ecommerce_test \
  ECOMMERCE_TEST_DB_PASSWORD=<password> npm run loadtest:concurrency
```

The npm script builds the backend first (`npm run build`), then runs
[scripts/loadtest/concurrency-check.ts](../scripts/loadtest/concurrency-check.ts).
It prints a Markdown summary and writes `docs/load-test-results.md`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--customers <n>` | 200 | Customers racing in scenarios 1 and 2 (2 to 2000) |
| `--stock <k>` | 10 | Units of the contested variant(s); must be below `--customers` |
| `--parallel <m>` | 20 | Parallel requests per order in scenarios 3 to 5 (2 to 100) |
| `--orders <r>` | 5 | Orders per payment scenario (1 to 50) |
| `--scenarios <list>` | all | For example `1,3` |
| `--output <file>` | `docs/load-test-results.md` | Where to write the results |
| `--no-write` | | Print only. A partial `--scenarios` run never overwrites the default file |
| `--cleanup-leftovers` | | Remove rows left by an interrupted run, then exit |

Exit code: `0` all checks passed, `1` a check failed, `2` refused or bad
arguments, `3` the run or its clean-up could not complete.

After a run, **run the test seed again (`npm run seed:demo:test`) before any
browser smoke run.** The check removes what it created and verifies that the
seeded demo rows are unchanged, but it does write to and delete from the test
database, and the smoke tests expect a freshly seeded one.

## Safety

- **Refuses to start** unless `NODE_ENV=test`, `DB_NAME=ecommerce_test`,
  `ECOMMERCE_TEST_DB_PASSWORD` is set, `DB_HOST` is this machine and `DB_PORT` is
  set explicitly and is not 5432 (the development database port). A
  `DATABASE_URL` is refused. `DB_PASSWORD` is ignored. After connecting it asks
  the server for `current_database()` and refuses anything but `ecommerce_test`.
- **No URL to aim at.** The script has no option for a URL or host to call. It
  starts its own backend (`node dist/main`) on `127.0.0.1`, on port 3000 if that
  is free and on a free port otherwise, and only ever talks to that process.
- **The child backend is configured explicitly**: test database, demo payment
  provider, `TZ=UTC`, a random JWT secret for this run, and empty Telegram
  settings so no notification can leave the machine. Nothing is inherited from
  a developer's shell or env files for these settings.
- **Everything it creates is marked** with a run id (emails
  `loadtest-<run>-...@loadtest.invalid`, SKUs `LOADTEST-<run>-...`, slugs
  `loadtest-<run>...`) and removed at the end in one transaction. The seeded demo
  data is never modified; the script compares counts and total stock of the demo
  rows before and after. If clean-up fails, it says so and exits with `3`; run
  `--cleanup-leftovers` to remove what is left.
- **Accounts can not log in.** Customers are inserted directly with a password
  that is not a valid hash, and their access tokens are signed with the run's
  secret. This keeps the register and login rate limits (which are not what is
  tested) out of the way.
- **The backend is stopped at the end** and the script checks that its port is
  free again.

## What each scenario proves

Every scenario sends its requests through one gate, so they leave the client in
the same instant after the connections were opened. For each it reports requests,
successes, expected refusals, unexpected answers, 429 answers, p50 and p95
latency, wall time and throughput. Every scenario also fails on any unexpected
answer, any 429 (a throttled request is a setup problem, never a pass), any 5xx,
any deadlock and any error line in the backend's output.

1. **Oversell.** 200 customers each put one unit of a variant with 10 in stock in
   their cart and check out at the same moment (`POST /cart/checkout`). Exactly
   10 orders succeed, the other 190 get the insufficient-stock error, final stock
   is 0 and the ordered quantities add up to 10. Stock is also read every few
   milliseconds during the burst and must never be seen below 0. This exercises
   the row lock on the variant in `OrdersService.checkoutPrepared`.
2. **Deadlock safety.** Two variants A and B with 10 units each. Half of the
   customers order A then B, half order B then A (`POST /orders/checkout`). The
   service sorts the lines by variant id before locking (`normalizeItems`), so
   the two orders can not wait on each other. Passes only if nothing returns a
   5xx, no deadlock (`40P01`) appears in the backend output or in
   `pg_stat_database`, no more than 10 orders succeed, and both stocks equal the
   stock minus the ordered quantities.
3. **Payment idempotency.** For several fresh unpaid orders: many parallel
   `POST /orders/:id/payments` with the **same** `Idempotency-Key` give one
   payment row and every answer names that payment; many with **different** keys
   for one order give exactly one active payment and the rest are refused with
   `409 Order already has an active payment`. The payments table is checked
   directly.
4. **Concurrent payment events.** Each demo payment receives many parallel
   completions (`POST /payments/:id/demo/complete`) with **different** events: the
   outcome rotates success, failure, cancel across the requests, so one payment
   gets three event ids (`demo:<paymentId>:<outcome>`) at once, each repeated
   several times. Which event wins the payment lock is not fixed, so the check
   does not assume a winner. Every answer must be `applied`, `already_applied` or
   `recorded_for_review`, and then, per payment:
   - the payment ends in exactly one terminal state (`succeeded`, `failed` or
     `cancelled`) and the order matches it (`confirmed` after a success, still
     `pending` otherwise);
   - exactly one event is stored for each distinct event id sent (3 per payment),
     no more and no fewer;
   - the stored events agree with the final state: if the success won, it is
     `processed` and the failure and cancel were recorded for review
     (`requires_reconciliation`); otherwise the success was recorded for review
     and the failure and cancel were `processed`;
   - for each event id, the answers match how it was stored: one `applied` and the
     rest `already_applied` for a processed event, all `recorded_for_review` for
     one recorded for review;
   - stock did not change.
5. **Cancellation against payment completion.** The same payment and unpaid order
   are run in three orders of arrival. The first two do not depend on timing: the
   first request is answered before the second one is sent.
   - *Payment first.* The completion is answered (`applied`, order `confirmed`),
     then the cancel is sent and must be refused with `409` (a paid order can not
     be cancelled). No stock is returned.
   - *Cancel first.* Each order is cancelled by **three cancels at once**: exactly
     one succeeds and the other two are refused with `400` ("Cannot transition
     Order from cancelled to cancelled"), never a 5xx. Then the payment is
     completed many times in parallel: every completion is
     `recorded_for_review`, there is one `requires_reconciliation` event per
     payment, the order and payment stay cancelled and stock is back to the
     original value exactly, never returned twice.
   - *Simultaneous.* For each order one cancel and many completions are sent at
     the same moment. Either side may win and both outcomes are valid: the cancel
     wins and every completion is `recorded_for_review`, or the payment wins and
     the cancel is refused with `409`. The winner is **reported, not asserted**
     (the results file prints the split); a mixed outcome fails, and stock must
     equal the original minus the orders that were paid.

## Sensitivity check

A check that always passes proves nothing, so the check was tried against five
deliberately broken versions of the backend. Each break was applied on its own to
a throwaway copy of the repository (never to the real one), the check was run,
and the copy was thrown away.

| # | Break (in the copy) | Detected by | What the check showed |
| --- | --- | --- | --- |
| 1 | Remove the row lock on the variant in `OrdersService.checkoutPrepared` | Scenarios 1 and 2 | More orders succeeded than there were units (105 and 144 instead of 10) |
| 2 | Remove the sorting of variant ids before locking (`normalizeItems`) | Scenario 2 | 5xx answers and deadlocks (184 of 200 requests) |
| 3 | Insert the payment event before locking the payment row in `PaymentsService.processEvent` | Scenario 4 | 5xx answers and deadlocks, and a missing event. Needs the mixed outcomes of scenario 4: with one outcome repeated, every request carries the same event id and they only queue behind each other |
| 4 | Remove the guard against returning stock twice when an order is cancelled (the `assertTransition` call in `cancel`) | Scenario 5, cancel-first group | More than one cancel succeeded for an order and stock came back as 1010 instead of 1000. Needs the repeated cancels |
| 5 | Skip the application pre-check for "one active payment per order" in `PaymentsService.establishAttempt` | **Not detected, by design** | Still exactly one active payment per order |

Break 5 is not caught because it should not be: it is caught by the database, not
by application code. The partial unique index `UQ_payments_one_active_per_order`
refuses a second active payment, and `establishAttempt` turns that into the same
`409` ("Order already has an active payment") the pre-check gives. The pre-check
only makes the common case cheaper and the message earlier. This is the reading of
the code and of an unchanged result; the index was not dropped to prove it.

Breaks 3 and 4 were first **not** detected by the earlier version of the check.
Scenario 4 now sends different outcomes at once and scenario 5 sends repeated
cancels, which is what finds them. Against the updated check, break 3 fails
scenario 4 (16 of 100 requests answered 5xx, 16 deadlocks counted by PostgreSQL,
14 of 15 events stored) and break 4 fails scenario 5 (0 of 5 orders with exactly
one successful cancel, stock 1010 instead of 1000).

This was run **once, by hand, in a throwaway copy**. It is not part of CI and not
automated; repeat it by hand after changing the locking in `OrdersService` or
`PaymentsService`.

## How the numbers are produced

Each figure in the results file is measured by the run that wrote it; nothing is
estimated. Latency is measured per request from sending to the last byte of the
answer (client and server share the machine). Wall time runs from opening the
gate to the last answer. Throughput is requests divided by that wall time. Setup
requests (creating orders and payments for the scenarios) are not counted.

Deadlocks are detected two ways: the backend's output is scanned for `40P01` and
`deadlock detected`, and the `deadlocks` counter of `pg_stat_database` is read
before the scenario and two seconds after it (PostgreSQL publishes statistics a
moment late).

## Limits

- **One machine.** The client, the backend and PostgreSQL share the same CPUs, and
  everything runs on localhost, so latency includes the client's own cost and no
  network. The numbers say nothing about capacity or about a hosted deployment.
- **Small and short.** 200 requests in about a second per scenario. A longer or
  larger run could find more; this finds the specific races it was written for.
  It can not prove that no race exists.
- **In-memory rate limits.** Throttler counters live in the memory of the one
  backend process, as in the free deployment. Customers are created directly so
  that registration and login limits are not involved. Each customer sends far
  fewer requests than the per-user limit (300 a minute per route); any 429 is
  reported as a setup problem and fails the run. Several backend instances, which
  would need a shared counter store, are not tested.
- **Demo payment provider.** Payments use `PAYMENT_PROVIDER=demo`: there is no
  provider call, no checkout link and no real webhook. The completion endpoint
  runs the same `PaymentsService.processEvent` that a MoMo notification uses, so
  the locking and idempotency under test are the real ones, but provider latency
  and retries are not.
- **Order expiry is not run.** The expiry job is off when `NODE_ENV=test`. Expiry
  cancels through the same `cancelLockedOrder` function as a cancel, which
  scenario 5 does exercise.
- **Stock samples see committed values only.** The database also refuses negative
  stock with a CHECK constraint, so "never negative" has a second line of defence
  that the samples can not show.
- **Variation between runs.** Latency and throughput vary by up to about 20
  percent between runs on the same machine. Counts of successes and refusals do not vary;
  in scenario 4 the split of final payment states and in the simultaneous part of
  scenario 5 the split between "cancel won" and "payment won" does.

## Files

- [scripts/loadtest/concurrency-check.ts](../scripts/loadtest/concurrency-check.ts):
  the entry point.
- [scenarios.ts](../scripts/loadtest/scenarios.ts): the five scenarios.
- [guard.ts](../scripts/loadtest/guard.ts), [args.ts](../scripts/loadtest/args.ts),
  [report.ts](../scripts/loadtest/report.ts),
  [outcomes.ts](../scripts/loadtest/outcomes.ts): the safety guard, the
  command-line options, the report and the pure rules for mixed payment events
  and repeated cancels; these have unit tests (`npm test`).
- [backend.ts](../scripts/loadtest/backend.ts), [http.ts](../scripts/loadtest/http.ts),
  [database.ts](../scripts/loadtest/database.ts): starting the backend, sending
  requests together, fixtures, verification queries and clean-up.

The scripts folder is outside `src`: `tsconfig.build.json` excludes it from the
build, and the unit test config (`package.json`, `jest.roots`) and `npm run lint`
include it.
