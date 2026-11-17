import { UserRole } from '../users/entities/user-role.enum';
import { OrderStatus } from '../orders/entities/order-status.enum';
import {
  ORDER_STATUS_SEQUENCE,
  REVENUE_ORDER_STATUSES,
} from './analytics.constants';
import {
  dayAfter,
  type AnalyticsRange,
  type DateSpan,
} from './analytics-range';

// Every statement is one aggregation in the database: nothing is read into
// memory and summed in JavaScript. Dates and the time zone are always bound
// parameters; the only text spliced into the SQL is built here from enum
// constants.
export interface Statement {
  sql: string;
  params: unknown[];
}

// The order statuses that count as revenue, as a SQL list.
const PAID = REVENUE_ORDER_STATUSES.map((status) => `'${status}'`).join(', ');

// "createdAt" is a timestamp WITHOUT time zone, written by the database clock in
// its session time zone. A calendar day in the requested zone therefore starts at
// the wall clock of the session zone that the same instant has:
//   local midnight (a plain timestamp) AT TIME ZONE <requested>   -> an instant
//   <instant> AT TIME ZONE current_setting('TimeZone')            -> session wall clock
// Comparing "createdAt" with that, as a plain range, also lets an index on
// "createdAt" be used. The mirror image, "createdAt" read as the session zone and
// converted to the requested zone, gives the calendar day an order belongs to.
const startOfDay = (date: string, timezone: string) =>
  `((CAST(${date} AS date)::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE current_setting('TimeZone'))`;

const localDay = (column: string, timezone: string) =>
  `CAST((${column} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE ${timezone} AS date)`;

// Revenue, orders, cancellations and new customers for the range and for the
// previous period of the same length, in one statement (two rows).
export function overviewStatement(
  range: AnalyticsRange,
  previous: DateSpan,
): Statement {
  return {
    sql: `
WITH bounds AS (
  SELECT 'current' AS period,
         ${startOfDay('$2', '$4')} AS span_start,
         ${startOfDay('$3', '$4')} AS span_end
  UNION ALL
  SELECT 'previous',
         ${startOfDay('$1', '$4')},
         ${startOfDay('$2', '$4')}
)
SELECT bounds.period AS "period",
       CAST(COALESCE(SUM(o."totalPrice") FILTER (WHERE o."status" IN (${PAID})), 0) AS text) AS "revenue",
       CAST(COUNT(o."id") FILTER (WHERE o."status" IN (${PAID})) AS int) AS "orderCount",
       CAST(COUNT(o."id") AS int) AS "placedOrders",
       CAST(COUNT(o."id") FILTER (WHERE o."status" = '${OrderStatus.CANCELLED}') AS int) AS "cancelledOrders",
       (SELECT CAST(COUNT(*) AS int) FROM "users" u
         WHERE u."role" = '${UserRole.USER}'
           AND u."createdAt" >= bounds.span_start AND u."createdAt" < bounds.span_end) AS "newCustomers"
FROM bounds
LEFT JOIN "orders" o
  ON o."createdAt" >= bounds.span_start AND o."createdAt" < bounds.span_end
GROUP BY bounds.period, bounds.span_start, bounds.span_end`,
    params: [previous.from, range.from, dayAfter(range.to), range.timezone],
  };
}

// One row for every calendar day of the range, zero days included.
export function revenueByDayStatement(range: AnalyticsRange): Statement {
  return {
    sql: `
WITH days AS (
  SELECT CAST(g AS date) AS day
  FROM generate_series(
    CAST($1 AS date)::timestamp,
    (CAST($2 AS date) - 1)::timestamp,
    interval '1 day') AS g
),
per_day AS (
  SELECT ${localDay('o."createdAt"', '$3')} AS day,
         CAST(SUM(o."totalPrice") AS text) AS revenue,
         CAST(COUNT(*) AS int) AS orders
  FROM "orders" o
  WHERE o."status" IN (${PAID})
    AND o."createdAt" >= ${startOfDay('$1', '$3')}
    AND o."createdAt" <  ${startOfDay('$2', '$3')}
  GROUP BY 1
)
SELECT to_char(days.day, 'YYYY-MM-DD') AS "date",
       COALESCE(per_day.revenue, '0') AS "revenue",
       COALESCE(per_day.orders, 0) AS "orders"
FROM days
LEFT JOIN per_day ON per_day.day = days.day
ORDER BY days.day`,
    params: [range.from, dayAfter(range.to), range.timezone],
  };
}

// Every status, always, in lifecycle order; count and the sum of order totals.
export function ordersByStatusStatement(range: AnalyticsRange): Statement {
  const statuses = ORDER_STATUS_SEQUENCE.map(
    (status, index) => `('${status}', ${index})`,
  ).join(', ');
  return {
    sql: `
SELECT statuses.status AS "status",
       CAST(COALESCE(found.orders, 0) AS int) AS "orderCount",
       CAST(COALESCE(found.total, 0) AS text) AS "totalValue"
FROM (VALUES ${statuses}) AS statuses(status, position)
LEFT JOIN (
  SELECT o."status" AS status, COUNT(*) AS orders, SUM(o."totalPrice") AS total
  FROM "orders" o
  WHERE o."createdAt" >= ${startOfDay('$1', '$3')}
    AND o."createdAt" <  ${startOfDay('$2', '$3')}
  GROUP BY o."status"
) AS found ON found.status = statuses.status
ORDER BY statuses.position`,
    params: [range.from, dayAfter(range.to), range.timezone],
  };
}

// Units and revenue per product and per category, from the order lines of paid
// orders. Revenue here is price x quantity of the lines, before any order-level
// coupon discount. Ranked by revenue, then units, then id, so ties are stable.
//
// The lines are kept narrow (ids and numbers only) and the names are looked up
// for the few ranked rows afterwards: measured on 200,000 orders, a wide row made
// COUNT(DISTINCT order_id) sort hundreds of thousands of rows on disk.
export function topProductsStatement(
  range: AnalyticsRange,
  limit: number,
): Statement {
  const entry = (ranked: string, named: string) =>
    `json_build_object('id', ${ranked}.id, 'name', ${named}.name, 'slug', ${named}.slug, 'units', ${ranked}.units, 'revenue', ${ranked}.revenue, 'orders', ${ranked}.orders)`;
  return {
    sql: `
WITH lines AS (
  SELECT v."productId" AS product_id, p."categoryId" AS category_id,
         o."id" AS order_id, oi."quantity" AS quantity, oi."price" AS price
  FROM "orders" o
  INNER JOIN "order_items" oi ON oi."orderId" = o."id"
  INNER JOIN "product_variants" v ON v."id" = oi."variantId"
  INNER JOIN "products" p ON p."id" = v."productId"
  WHERE o."status" IN (${PAID})
    AND o."createdAt" >= ${startOfDay('$1', '$3')}
    AND o."createdAt" <  ${startOfDay('$2', '$3')}
),
ranked_products AS (
  SELECT product_id AS id,
         CAST(SUM(quantity) AS bigint) AS units,
         CAST(SUM(price * quantity) AS bigint) AS revenue,
         CAST(COUNT(DISTINCT order_id) AS int) AS orders
  FROM lines
  GROUP BY product_id
  ORDER BY revenue DESC, units DESC, id ASC
  LIMIT $4
),
ranked_categories AS (
  SELECT category_id AS id,
         CAST(SUM(quantity) AS bigint) AS units,
         CAST(SUM(price * quantity) AS bigint) AS revenue,
         CAST(COUNT(DISTINCT order_id) AS int) AS orders
  FROM lines
  GROUP BY category_id
  ORDER BY revenue DESC, units DESC, id ASC
  LIMIT $4
)
SELECT
  (SELECT COALESCE(json_agg(${entry('r', 'p')} ORDER BY r.revenue DESC, r.units DESC, r.id ASC), '[]'::json)
     FROM ranked_products r INNER JOIN "products" p ON p."id" = r.id) AS "products",
  (SELECT COALESCE(json_agg(${entry('r', 'c')} ORDER BY r.revenue DESC, r.units DESC, r.id ASC), '[]'::json)
     FROM ranked_categories r INNER JOIN "categories" c ON c."id" = r.id) AS "categories"`,
    params: [range.from, dayAfter(range.to), range.timezone, limit],
  };
}
