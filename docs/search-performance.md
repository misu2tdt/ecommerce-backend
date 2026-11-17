# Product search: trigram index and measurement

> The numbers below are **local numbers from one laptop against the isolated
> test database**, on throwaway rows. They show what the planner does with the
> index and roughly how much work it saves. They are not a production benchmark.
> A different machine, a different data shape or a warm production cache will give
> different milliseconds. Compare the plans and the relative change, not the
> absolute times.

## How search works

`GET /products?q=...` keeps its contract: the same query parameters, the same
response, the same order (name, then id; every sort ends with the id so pages never
overlap).

- The term is matched against the product **name only**, as a case-insensitive
  "contains" match: `products.name ILIKE '%term%'`, on active products.
- **Fix in this change:** `%`, `_` and `\` in the term are now escaped, so they
  match themselves. Before, a search for `100%` or `a_b` treated them as wildcards
  and returned wrong products. The escaping is in
  `src/products/search-pattern.ts` and works with or without the index.
- A `LIKE '%term%'` pattern cannot use an ordinary B-tree index, so before this
  change every search read the whole `products` table.

## What was added

Migration `AddProductNameTrigramIndex1787677200000`:

- `CREATE EXTENSION IF NOT EXISTS pg_trgm`
- `CREATE INDEX "IDX_products_name_trgm" ON "products" USING gin ("name" gin_trgm_ops)`
- `down()` drops the index and **leaves the extension** (other objects could use
  it, and dropping an extension is not something a rollback should do).

The index is a plain `CREATE INDEX`, not `CONCURRENTLY`: migrations run inside a
transaction. It locks writes to `products` while it builds; at catalog sizes like
the ones measured above that should be brief, but build time on production was not
measured.

**Not added, on purpose:** typo tolerance (`similarity()`, `%`) and relevance
ranking. They would change which products come back and in what order, which is a
contract change, and they are harder to make deterministic. If wanted later, they
belong in their own change.

Postgres only uses the index when the term has at least three characters (a
trigram is three letters). A one or two letter term still scans the table; that is
unchanged behaviour, not a regression.

## Results

Run on 2026-11-17. PostgreSQL 16.14 in Docker, Windows 11, 11th Gen Intel Core
i5-11400H (12 logical CPUs), 16 GB, Node.js v22.14.0. Each figure is the median of
5 timed runs after one warm-up run; planning time is shown separately. All data was
in cache (no disk reads in any run).

Rows are throwaway products with generated names: one in a thousand contains
"Zephyr" (about 0.1%), about 10% contain "Linen", about 7% "Tee", and about 25%
contain "er". The statements measured are the two the list endpoint sends for the
first page, taken from the service itself: the `COUNT` and the page of ids
(`ORDER BY name, id LIMIT 20`). Before and after return identical rows.

"Before" is the same database with the index dropped inside a transaction that is
rolled back.

| Products | Term (share of rows) | Count: before | Count: after | Page: before | Page: after | Plan after |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | zephyr (0.1%) | 0.47 ms | 0.10 ms | 0.52 ms | 0.08 ms | Bitmap index scan |
| 1,000 | linen (10%) | 0.56 ms | 0.59 ms | 0.57 ms | 0.58 ms | **Seq scan (index not used)** |
| 1,000 | tee (7%) | 0.52 ms | 0.16 ms | 0.54 ms | 0.18 ms | Bitmap index scan |
| 1,000 | er (25%, 2 letters) | 0.71 ms | 0.66 ms | 0.72 ms | 0.72 ms | Seq scan (term too short) |
| 10,000 | zephyr (0.1%) | 4.46 ms | 0.11 ms | 4.30 ms | 0.11 ms | Bitmap index scan |
| 10,000 | linen (10%) | 5.08 ms | 1.32 ms | 5.12 ms | 1.35 ms | Bitmap index scan |
| 10,000 | tee (7%) | 4.73 ms | 0.90 ms | 4.82 ms | 0.95 ms | Bitmap index scan |
| 10,000 | er (25%, 2 letters) | 5.78 ms | 5.83 ms | 5.81 ms | 5.74 ms | Seq scan (term too short) |
| 50,000 | zephyr (0.1%) | 21.8 ms | 0.17 ms | 21.6 ms | 0.27 ms | Bitmap index scan |
| 50,000 | linen (10%) | 25.6 ms | 5.46 ms | 25.8 ms | 6.08 ms | Bitmap index scan |
| 50,000 | tee (7%) | 24.3 ms | 3.95 ms | 23.4 ms | 4.23 ms | Bitmap index scan |
| 50,000 | er (25%, 2 letters) | 38.2 ms | 33.6 ms | 28.8 ms | 28.8 ms | Seq scan / PK scan (term too short) |

The planner used the index in 16 of the 24 measurements, and the same 16 in two
full runs. Full output, including buffers per statement, is what the script
prints.

### How to read this

- **At 1,000 products the difference is a fraction of a millisecond either way.**
  The whole table is 17 pages; scanning it is already cheap. The planner even
  ignores the index for "linen" there (10% of rows: scanning everything is
  cheaper than visiting a tenth of them through the index). Nobody would notice
  this change on a catalog the size of the demo (tens of products).
- **The index helps where the term is selective and the table is large.** At
  50,000 products, a rare word goes from about 22 ms to about 0.2 ms, and a
  common one (10%, 7%) from about 25 ms to 4 to 6 ms. The work is no longer
  proportional to the table: for "zephyr", buffers touched fall from 806 to 61.
- **Terms under three letters see no change.** "er" reads the whole table before
  and after.
- The timings above include only the database. Network, serialising the response
  and loading the images and prices of the 20 products on the page cost the same
  before and after.

### A measurement pitfall found along the way

A first version of the script gave a different and misleading result: the same
50,000-row "zephyr" search used a sequential scan and showed no gain. Two things
about the **state** of the table changed the planner's choice, not the index:

- rows deleted by the previous size left a bloated table (a 1,000-row table
  showed 722 buffers instead of 17), and
- a bulk insert leaves the index's pending list unmerged until a vacuum runs. I
  believe this is what made the planner avoid the index at 50,000 rows in that run,
  but I did not isolate it separately from the bloat.

The script now starts every size from the same physical state (`VACUUM FULL` after
clearing the scratch rows, `VACUUM (ANALYZE)` after inserting) and the two full
runs agree on every plan choice. The practical lesson for production: after a
large bulk load into `products`, run `VACUUM ANALYZE products`; routine
autovacuum does this on a live table.

## Correctness

Integration tests in `test/integration/product-search.integration-spec.ts` cover
case-insensitivity, partial words, phrases, no match, inactive products excluded,
category and brand filters together with search, `%`, `_`, `\`, quotes, `&`,
injection-style strings and a 255-character term, an empty or missing `q`, paging
with totals, a stable order among products with the same name, and the other sort
orders. A further group checks that the index exists (type, operator class,
extension installed), that reverting the migration drops the index but keeps the
extension and the data with the same results, and that the planner uses the index
for a rare word and not for a two-letter term.

## Commands

All against the isolated test database (port 5434, never 5432). Set these in the
same shell first (PowerShell shown):

```powershell
$env:NODE_ENV = 'test'
$env:DB_HOST = 'localhost'
$env:DB_PORT = '5434'
$env:DB_USERNAME = 'postgres'
$env:DB_NAME = 'ecommerce_test'
$env:ECOMMERCE_TEST_DB_PASSWORD = '<the test password>'
```

Apply the migration to the test database, then measure:

```powershell
npm.cmd run migration:run
npm.cmd run search:explain
```

Options: `--sizes 1000,10000,50000` (rows per round, up to 500,000), `--runs 5`
(timed runs per statement) and `--plans` (also print the full `EXPLAIN (ANALYZE,
BUFFERS)` text of every "after" statement).

The script uses the same guard as the concurrency check and refuses to run unless
`NODE_ENV=test`, the database is `ecommerce_test`, the host is loopback, the port
is explicit and not 5432, the password comes from `ECOMMERCE_TEST_DB_PASSWORD` and
`DATABASE_URL` is unset. It inserts scratch products (slug prefix
`search-explain-`, one scratch category), measures, and deletes exactly those
rows again, also when something fails. It exits with an error if the index changes
any result.

## Applying the migration to production

Not run as part of this change; for the operator. This follows section C of
[free-deployment.md](free-deployment.md).

1. **Restore point.** In the Neon console, create a branch (or note a restore
   time) of the production database.
2. **Prepare** a trusted local or CI environment on the exact revision to deploy:
   `npm ci --include=dev`, then `npm run build`.
3. **Point at production** in that shell only: `NODE_ENV=production` and
   `DATABASE_URL` for Neon (with `sslmode=require`).
4. `npm run migration:show`. Exactly one pending migration should appear:
   `AddProductNameTrigramIndex1787677200000`.
5. `npm run migration:run:prod`, once. It blocks writes to `products` while the
   index builds (brief for a catalog this size, not measured on Neon). The role needs
   permission to create the `pg_trgm` extension; it is a trusted extension, so the
   database owner can.
6. **Verify:** `SELECT indexname FROM pg_indexes WHERE indexname =
   'IDX_products_name_trgm';` returns one row and
   `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';` returns one row.
7. Then the manual Render deploy of the matching code.

Order is not critical: the escaping fix works without the index, and the index
changes no result, so either order is safe. Rollback is `npm run migration:revert`
(drops the index, keeps the extension), a deliberate operator action.
