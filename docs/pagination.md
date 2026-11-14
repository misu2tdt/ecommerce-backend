# Pagination

List endpoints can be read one page at a time. Paging is **opt-in**, so clients
written before it existed keep working unchanged.

## The contract

| | |
|---|---|
| Opt in | Send `page` and/or `limit`. Sending neither returns the whole list as one array, exactly as before. |
| `page` | Whole number from 1 to 100000. Default 1 once paging is on. |
| `limit` | Whole number from 1 up to the maximum below. Default below once paging is on. A value above the maximum is rejected with 400, never reduced. |
| Body | Still a plain array. Only the rows of the requested page. |
| Totals | Response headers `X-Total-Count`, `X-Total-Pages`, `X-Page`, `X-Limit` (sent only when paging is on). |
| Past the end | `200` with `[]` and correct headers (`X-Total-Pages` tells the client where the end is). |
| Nothing matches | `200`, `[]`, `X-Total-Count: 0`, `X-Total-Pages: 0`. |
| Bad value | `400` with a message that starts with the parameter name, for example `page must be a whole number of 1 or more` or `limit must not be greater than 48`. Letters, decimals, `1e1`, `0x10`, an empty value, a negative or zero value and a repeated parameter are all rejected. |

| Endpoint | Default `limit` | Maximum `limit` | Order |
|---|---|---|---|
| `GET /products` | 12 | 48 | the `sort` value (see below), then `id` |
| `GET /orders` (the signed-in user's orders) | 20 | 100 | newest first, then `id` descending |
| `GET /admin/orders` | 20 | 100 | newest first, then `id` descending |
| `GET /products/admin` | 20 | 100 | name, then `id` |
| `GET /admin/reviews` | 20 | 100 | newest first, then `id` descending |
| `GET /admin/promotions` | 20 | 100 | newest first, then `id` descending |
| `GET /collections` | 20 | 100 | `sortOrder`, then `id` |
| `GET /admin/collections` | 20 | 100 | `sortOrder`, then `id` |

`GET /admin/payments/reconciliation` was already paginated with its own body
(`{ items, page, limit, total }`) and keeps that shape. It also takes an optional
`orderId` filter (see [payments](./payments.md#for-admins)); `total` counts the
filtered events.

The other lists (categories, brands, a user's addresses, wishlist, and the
payments of one order) are small by nature and stay unpaged. The public reviews
of one product are not paged yet.

## Stable pages

Every sort ends with the unique `id`, so the order is total: two rows never tie.
Without that, rows with the same name or price could swap places between two
requests and a page would repeat or skip a row.

| `sort` | Order |
|---|---|
| `featured` (default), `name_asc` | name ascending, id ascending |
| `name_desc` | name descending, id ascending |
| `price_asc` | lowest active variant price ascending (products without one last), name, id |
| `price_desc` | lowest active variant price descending (products without one last), name, id |
| `newest` | created descending, id descending |

All filters (`category`, `brand`, `collection`, `q`, `size`, `color`, `minPrice`,
`maxPrice`, `inStock`) work together with paging, and `X-Total-Count` counts the
filtered rows. With `collection=<slug>` and no `sort`, the order is the
collection's own display order, then `id`; any `sort` sent (even `featured`) is
used instead. An unknown or inactive collection is not an error: it gives an empty
list with `X-Total-Count: 0` and `X-Total-Pages: 0`. See
[collections](./collections.md).
A product page is chosen first from ids alone, then only those products are loaded
with their images and summaries.

## Browsers

The totals are in headers, so the API exposes them to cross-origin pages
(`Access-Control-Expose-Headers`). Without that a storefront on another origin
could not read them.

## Query plans and the one index that was added

The plans were reviewed on a synthetic catalog of 18,000 active products (rolled
back afterwards, local test database only):

| Query | Time |
|---|---|
| total count | ~7 ms |
| `featured`, page 1 / page 400 | ~7 ms / ~19 ms |
| `newest`, page 1 | ~7 ms |
| with a category filter | ~4 ms |
| `price_asc`, page 1, **before** the index | **~54 s** |
| `price_asc`, page 1, after the index | ~52 ms |

Name and date sorts are fine as they are (a top-N sort over a sequential scan).
The price sort, the price/stock summaries and the variant filters all look up the
variants of each product, and `product_variants."productId"` had no index, so the
price sort grew with the square of the catalog. The migration
`AddProductVariantProductIndex1787504400000` adds `IDX_product_variants_product`
on `product_variants ("productId")`. It only creates an index (no data or column
changes) and `down()` drops it. It must be run on production with the usual
manual migration step before the catalog grows; until then paging works but the
price sorts are as slow as before.
