# Admin analytics API

Four read-only endpoints for the admin dashboard. They are ADMIN only, validate every
parameter, and compute every figure with one SQL aggregation in the database: no order
is loaded into memory. Money is whole VND (integers) end to end.

| Endpoint | Answers |
| --- | --- |
| `GET /admin/analytics/overview` | revenue, paid orders, average order value, cancelled rate and new customers, for the period and for the previous period of equal length |
| `GET /admin/analytics/revenue-by-day` | one row per calendar day, zero days included |
| `GET /admin/analytics/orders-by-status` | orders and their value in each status |
| `GET /admin/analytics/top-products` | best-selling products and categories (`limit`, default 10, at most 50) |

Swagger UI (`/api/docs`, outside production) lists them under "Admin - Analytics" with
examples. Without a token the answer is 401; with a customer's token it is 403.

## Parameters

| Parameter | Meaning | Default |
| --- | --- | --- |
| `from` | first day of the range, `YYYY-MM-DD`, included | 29 days before `to` |
| `to` | last day of the range, `YYYY-MM-DD`, included | today in `timezone` |
| `timezone` | IANA zone name that decides where a day starts and ends | `Asia/Ho_Chi_Minh` |
| `limit` | (`top-products` only) how many products and how many categories | 10 |

`timezone` is accepted by all four endpoints, not only `revenue-by-day`, so a range and
its day buckets always use the same calendar.

Rules, each answered with 400 and a message that names the problem:

- `from` and `to` must be real calendar dates in the form `YYYY-MM-DD` (`2026-02-30`,
  `2026-13-01`, `20261110` and timestamps are refused).
- `from` may not be after `to`. With only `from`, the range runs to today, so a `from`
  in the future is refused too.
- A range is at most **366 days**, both ends counted (so `2026-01-01` to `2027-01-01` is
  allowed and one day more is not).
- `timezone` must be an IANA name such as `Asia/Ho_Chi_Minh`, `UTC` or
  `America/Los_Angeles`. Offsets such as `+07:00` are refused on purpose: PostgreSQL
  reads them as POSIX zones with the **opposite sign**, which would silently move every
  day by hours.
- `limit` must be a whole number from 1 to 50 (`0`, `51`, `1.5`, `abc` and a repeated
  parameter are refused, not clamped).
- Unknown parameters are refused, and so is a repeated parameter.

## Definitions

These are the definitions the numbers can be defended with.

**Which orders count as revenue.** An order whose status is `confirmed`, `processing`,
`shipped` or `delivered`. Only a successful payment moves an order to `confirmed` (the
code refuses to confirm by hand), so these four statuses are exactly "paid". `pending`
orders are not paid yet and `cancelled` orders never will be (a paid order cannot be
cancelled: there is no refund feature), so both are left out. The response repeats the
list as `revenueStatuses`.

**Revenue** is the sum of `orders.totalPrice` of those orders: the amount the customer
was charged, after any coupon discount. There is no shipping fee in this model, so
nothing else is added.

**Which day an order belongs to.** The day it was **created** (`orders.createdAt`), in
the requested zone. This is the order date, not the payment date. Orders are paid within
minutes in this store, so the two almost always agree; they differ only for an order
created just before midnight and paid just after. The order date is used because it is
one stable column that never changes, so a past day's figures never move.

**Order count (`orderCount`)** is the number of those paid orders. **Average order value
(`averageOrderValue`)** is `revenue / orderCount` in whole VND, rounded half up with
integer arithmetic (`BigInt`, not a floating point division), and 0 when there are no
orders.

**Cancelled rate** is `cancelledOrders / placedOrders`, where `placedOrders` is every
order created in the period whatever its status, from 0 to 1 with 4 decimals (0 when
nothing was placed). It is a share, not money.

**New customers** are accounts with the `USER` role whose `createdAt` falls in the
period. Admin accounts are never counted.

**Previous period.** The period of the same number of days that ends the day before
`from`. For `2026-11-10` to `2026-11-12` it is `2026-11-07` to `2026-11-09`. The response
gives its dates as `previousRange`, and `previous` has the same figures as `current`.

**Orders by status** lists all six statuses in lifecycle order, even with zero orders,
with the number of orders created in the period and the sum of their totals
(`totalValue`). `totalValue` is only revenue for the four paid statuses; for `cancelled`
it is the value that was lost, for `pending` the value waiting for payment.

**Top products and categories** are ranked from the **order lines** of paid orders
created in the period: `units` is the sum of quantities, `revenue` is the sum of
`price x quantity` of the lines, and `orders` is the number of distinct paid orders that
contain the product (or any product of the category). Ranking is by `revenue`, then
`units`, then `id`, so ties always come out in the same order. Line revenue is taken
**before** an order-level coupon discount (the discount belongs to the order, not to a
line), so the products' revenues add up to the overview revenue **plus** the discounts of
those orders. This is checked: on the seeded history, line totals 337,844,000 minus
discounts 7,058,550 equal the revenue 330,785,450 exactly.

## How days are bucketed

`orders.createdAt` is a `timestamp without time zone`, filled by the database clock in
its **session time zone** (the order expiry job reads it the same way). So the stored
value is a wall clock, and to find the calendar day in another zone the query converts
it in two steps:

```sql
-- the day an order belongs to, in the requested zone
CAST((o."createdAt" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE $tz AS date)
--      wall clock -> instant (read it as the session zone)   -> wall clock in $tz
```

The range edges go the other way, so the filter is a plain range on the column:

```sql
-- start of a local day, as the session's wall clock
(CAST($date AS date)::timestamp AT TIME ZONE $tz) AT TIME ZONE current_setting('TimeZone')

o."createdAt" >= start_of(from) AND o."createdAt" < start_of(to + 1 day)
```

The end of a range is the start of the day after `to`, exclusive, so an order at exactly
00:00:00 of the next day is outside. Because the conversion goes through real instants,
daylight saving needs no special case: a 25-hour day (the US, 1 November 2026) holds all
25 hours, and the repeated 01:30 counts on that day.

Nothing depends on the session zone of the connection as long as rows follow the
convention above; this is tested with a connection whose session zone is `Asia/Tokyo`.

## Money

All money is `bigint` in the database and whole VND in the API. `SUM` results travel as
text from the database and are parsed with the same `parseVndAmount` check the rest of the
code uses (a non-negative safe integer or an error). No amount is ever divided by a
float; the one division (the average) uses `BigInt`. The only non-integer in the
responses is `cancelledRate`.

## One aggregation per endpoint

Each endpoint sends exactly one SQL statement (a test asserts this by counting calls).
Dates and the time zone are bound parameters; the only text built into the SQL comes from
the enum of revenue statuses.

- `overview`: a two-row `bounds` CTE (current and previous period) left-joined to
  `orders`, with `FILTER` aggregates; new customers is a correlated count on `users`.
- `revenue-by-day`: `generate_series` of the local dates left-joined to a per-day
  aggregate, so a day without orders is a row of zeros.
- `orders-by-status`: a `VALUES` list of the statuses left-joined to the grouped orders.
- `top-products`: a narrow `lines` CTE (ids and numbers only), two ranked aggregates,
  and the names looked up for the few ranked rows at the end.

## Worked example (the test fixtures)

`test/integration/admin-analytics.integration-spec.ts` builds these orders by hand and
asserts the exact figures, with orders placed one second either side of local midnight
(Vietnam is UTC+7, so local midnight is 17:00 UTC the day before). Prices: P1 Tee has
V1a 100,000 and V1b 250,000, P2 Socks V2 50,000, P3 Jacket V3 400,000.

| Created (UTC) | Local (UTC+7) | Status | Lines | Total | Counts in |
| --- | --- | --- | --- | --- | --- |
| 11-06 16:59:59 | 11-06 23:59:59 | delivered | V3 | 400,000 | neither period |
| 11-06 17:00:00 | 11-07 00:00:00 | shipped | V1a | 100,000 | previous |
| 11-07 10:00 | 11-07 | cancelled | V1b | 250,000 | previous, cancelled |
| 11-08 03:00 | 11-08 | delivered | V2 | 50,000 | previous |
| 11-09 16:59:59 | 11-09 23:59:59 | delivered | V1a | 100,000 | previous (last second) |
| 11-09 17:00:00 | 11-10 00:00:00 | delivered | V1a, 4 x V2 | 300,000 | this (first second) |
| 11-10 09:00 | 11-10 | shipped | V3, coupon 50,000 | 350,000 | this |
| 11-10 16:59:59 | 11-10 23:59:59 | confirmed | 2 x V1b | 500,000 | this (last second of the 10th) |
| 11-10 17:00:00 | 11-11 00:00:00 | processing | 2 x V2 | 100,000 | this |
| 11-11 05:00 | 11-11 | cancelled | V3 | 400,000 | this, cancelled |
| 11-11 20:00 | 11-12 03:00 | pending | V1a | 100,000 | this, not revenue |
| 11-12 16:59:59 | 11-12 23:59:59 | delivered | 3 x V1a | 300,000 | this (last second of the range) |
| 11-12 17:00:00 | 11-13 00:00:00 | delivered | 2 x V3 | 800,000 | after it |

For `from=2026-11-10&to=2026-11-12`:

- **Revenue** = 300,000 + 350,000 + 500,000 + 100,000 + 300,000 = **1,550,000** from
  **5** paid orders, so the average is 310,000.
- **Placed** = 7 (the five, the cancelled one and the pending one); **cancelled** = 1, so
  the rate is 1/7 = 0.1429.
- **Previous** (11-07 to 11-09) = 100,000 + 50,000 + 100,000 = **250,000** from 3 orders,
  average 83,333 (250,000 / 3 = 83,333.33); 4 placed, 1 cancelled, rate 0.25.
- **By day**: the 10th 1,150,000 (3 orders), the 11th 100,000 (1), the 12th 300,000 (1).
- **New customers**: two accounts created inside the range (one at 00:00:00 of the 10th,
  one at 23:59:59 of the 12th) count; one at 00:00:00 of the 13th and an admin created
  inside the range do not.
- **Top products**: P1 900,000 (6 units, 3 orders), P3 400,000 (1 unit; the 50,000 coupon
  is not taken off a line), P2 300,000 (6 units, 2 orders).

The same orders give different days in other zones, which the tests also assert: in UTC
the first two orders are both on 11-09; in Los Angeles (UTC-8) the 9th ends at 08:00
UTC on the 10th.

## Performance and indexes

No index was added. The statements were measured with `npm run analytics:explain`
(isolated test database only; it inserts scratch rows, measures and deletes them) at three
sizes, with the schema as it is and, inside a rolled-back transaction, with two candidate
indexes: `orders ("createdAt")` and `order_items ("orderId")`. Each figure is the median
of 5 timed runs after a warm-up.

> These are **local numbers from one laptop** (Windows 11, 11th Gen Intel Core i5-11400H,
> 16 GB, PostgreSQL 16.14 in Docker, Node.js v22.14.0, measured 2026-11-17) against
> synthetic orders. Use the plans and the ratios, not the milliseconds, and expect
> different times elsewhere.

Execution time, current schema (the default 30-day window and the longest allowed, 366
days):

| Orders (items) | Window | overview | revenue-by-day | orders-by-status | top-products |
| --- | --- | --- | --- | --- | --- |
| 10,000 (20,000) | 30 days | 5.9 ms | 3.0 ms | 2.0 ms | 8.0 ms |
| 10,000 | 366 days | 10.4 ms | 8.6 ms | 4.7 ms | 34.8 ms |
| 50,000 (100,000) | 30 days | 29.0 ms | 14.5 ms | 10.1 ms | 39.1 ms |
| 50,000 | 366 days | 46.5 ms | 43.1 ms | 23.7 ms | 206 ms |
| 200,000 (400,001) | 30 days | 57.5 ms | 44.7 ms | 38.3 ms | 110 ms |
| 200,000 | 366 days | 124 ms | 161 ms | 63.0 ms | 879 ms |

With the candidate indexes added, the planner uses the `createdAt` index (a bitmap scan)
for every 30-day statement, but only the three that read `orders` alone gain from it
(`top-products` is dominated by reading `order_items`):

| Orders | Window | overview | revenue-by-day | orders-by-status | top-products |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 30 days | 1.5 ms | 0.7 ms | 0.4 ms | 5.6 ms |
| 50,000 | 30 days | 5.7 ms | 3.6 ms | 1.5 ms | 27.3 ms |
| 200,000 | 30 days | 25.5 ms | 13.0 ms | 6.8 ms | 133 ms (no gain) |

For the 366-day windows the range covers about 92% of the rows, so the index cannot help
much: `overview` still uses it (46.5 to 30.1 ms at 50,000 orders, no gain at 200,000),
and `revenue-by-day`, `orders-by-status` and `top-products` keep the sequential scan. The
planner never uses an index on `order_items` (it reads all of it and hash-joins). The 2
to 7 times gain for the 30-day window is real but the absolute times are small: at
10,000 orders everything is under 40 ms and even
at 200,000 orders (500 times this demo's order count) the default window is under 115 ms.
That is not a need, so no index is added. When the orders table grows beyond roughly
200,000 rows, the first one to add is
`CREATE INDEX CONCURRENTLY "IDX_orders_created_at" ON "orders" ("createdAt")` (in a
migration that opts out of the transaction); the statements already filter on a plain
range of that column so the planner will use it.

**What the measurement did change.** The first version of `top-products` took 1,980 ms
for 366 days (186 ms for 30) at 200,000 orders and the candidate indexes did not help. The
plan showed why: `COUNT(DISTINCT order_id)` sorted 336,000 wide rows (they carried product
and category names) on disk, twice. Keeping the lines narrow (ids and numbers) and looking
the names up for the ten ranked rows cut it to 879 ms (110 ms for 30 days) with the same
results; the exact-number tests pass unchanged. The remaining time is that distinct count
and is acceptable for the longest window at this size.

Reproduce (PowerShell, isolated test database, port 5434, never 5432):

```powershell
$env:NODE_ENV = 'test'
$env:DB_HOST = 'localhost'
$env:DB_PORT = '5434'
$env:DB_USERNAME = 'postgres'
$env:DB_NAME = 'ecommerce_test'
$env:ECOMMERCE_TEST_DB_PASSWORD = '<the test password>'
npm.cmd run analytics:explain -- --orders 200000    # --runs 5, --plans for the full plans
```

It uses the same guard as the concurrency check and the search measurement and refuses
to run anywhere else.

## A sanity check on the seeded history

With the base catalog, the catalog expansion and the [seeded order
history](./demo-data.md#seeded-order-history) in the isolated test database (run on
2026-11-17, so "today" is 17 November):

- **Last 30 days** (19 October to 17 November): revenue 133,397,200 VND from 136 paid
  orders (average 980,862), 156 placed, 14 cancelled (0.0897), 1 new customer. The
  previous 30 days: 109,239,500 VND from 127 orders, 134 placed, 7 cancelled (0.0522).
- **Last 90 days**: revenue 330,785,450 VND from 363 paid orders (average 911,255), 401
  placed (the 400 seeded plus the base seed's demo order), 32 cancelled (0.0798), 38 new
  customers. The 90 days before are empty, as they should be.
- **Weekly revenue** rises from about 17 to 27 million VND a week in September to 26 to
  39 million from October to early November (the first and last weeks are partial). A
  week has 29 to 35 paid orders in the second half of the window against 21 to 28 in the
  first.
- **Weekends**: 5.04 orders a day on Saturday and Sunday against 3.63 on weekdays
  (+39%), 4.61 million against 3.30 million VND a day.
- **Orders by status** (90 days): delivered 343 (313,889,450), shipped 15 (12,865,000),
  processing 4 (3,842,000), confirmed 1 (189,000), pending 6 (4,212,100), cancelled 32
  (32,854,000): 401 in all.
- **Top products by revenue**: Water-Resistant Commuter Parka (24,459,000; 31 units),
  Canvas Carpenter Pants (20,313,000; 37), Structured Workwear Overshirt (16,470,000; 30),
  Waxed Cotton Work Jacket, Cotton Gauze Pajama Set. **Top categories**: Hoodies &
  Outerwear (102,094,000; 146 units), Shirts & Polos (64,726,000), Pants & Shorts
  (59,603,000).
- **Reconciliation**: 4 unresolved and 2 resolved payment events.
- **Reconciles to the VND**: paid line totals 337,844,000 minus the 7,058,550 discount on
  the 77 paid orders that used a coupon equal the revenue 330,785,450 exactly.

## Limits

- Revenue is by order date, not payment date (see above), and it is gross: there are no
  refunds in this model, so nothing is subtracted.
- The previous period is the preceding block of equal length, not the same dates a year
  earlier.
- `top-products` counts line revenue before order-level coupon discounts.
- A time zone the runtime knows but PostgreSQL does not is answered with 400, not 500.
