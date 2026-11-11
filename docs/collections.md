# Collections

A collection is a curated, **ordered** group of products, for example "Everyday
Essentials". An admin builds it by hand; shoppers browse it through the public
API. A collection never changes a product: removing a product from a collection,
or deleting either side, leaves the other side as it was.

## Model

| Table `collections` | |
|---|---|
| `id` | serial primary key |
| `slug` | unique, up to 255 characters; the public address of the collection |
| `name` | required |
| `description` | text, optional |
| `heroImageUrl` | public `http(s)` address of a picture, optional |
| `isActive` | default `true`; an inactive collection is hidden from the public |
| `isFeatured` | default `false`; marks a collection for prominent placement |
| `sortOrder` | integer, default `0`; lower comes first in the public list, ties by `id` |
| `createdAt`, `updatedAt` | like the other tables |

| Table `collection_products` | |
|---|---|
| `collectionId`, `productId` | composite primary key: a product is in a collection at most once |
| `position` | 0-based place in the collection, checked `>= 0` |

Both foreign keys are `ON DELETE CASCADE`: deleting a product removes its
memberships, deleting a collection removes its memberships, and neither deletes
the other side. Indexes: unique `slug`, `(isActive, sortOrder)` for the public
list, and `productId` on the membership table (the primary key already serves
"the products of a collection").

Migration: `AddCollections1787590800000` (additive: two new tables, no change to
existing data; `down` drops them).

## What the public sees

A product is **visible** in a collection when it is `active` **and** has at least
one active variant (something a shopper can actually buy). Inactive products can
be put in a collection by an admin, but every public endpoint hides them.

- A collection is listed only when it is active and holds at least one visible
  product. Its `productCount` counts visible products only.
- `GET /products?collection=<slug>` lists only visible products of an **active**
  collection. A product with no active variant is left out there too, so the list
  always agrees with `productCount`. (Outside a collection, `/products` still
  lists every active product, as before.)

## Public endpoints

| Endpoint | Notes |
|---|---|
| `GET /collections` | Active collections with a visible product, by `sortOrder` then `id`. Opt-in paging like the other lists (`page` and/or `limit`; default 20, at most 100) with the `X-Total-Count`, `X-Total-Pages`, `X-Page`, `X-Limit` headers; with neither the whole list is returned and no headers are sent. See [pagination](./pagination.md). |
| `GET /collections/:slug` | One collection. `404 Collection not found` when the slug is unknown, the collection is inactive, or it has no visible product. |
| `GET /products?collection=<slug>` | The collection's products, with every other filter, sort and the paging headers working as usual. |

Fields of a collection: `id`, `slug`, `name`, `description`, `heroImageUrl`,
`isFeatured`, `productCount`. Nothing else is public.

```http
GET /collections?page=1&limit=2

200 OK
X-Total-Count: 3
X-Total-Pages: 2
X-Page: 1
X-Limit: 2

[
  {
    "id": 1,
    "slug": "everyday-essentials",
    "name": "Everyday Essentials",
    "description": "Simple pieces that go with everything, from tees to socks.",
    "heroImageUrl": null,
    "isFeatured": true,
    "productCount": 7
  }
]
```

### Order inside a collection

With `collection=<slug>` and **no** `sort`, products come in the collection's own
display order (`position`), then `id`. Any `sort` that is sent, even `featured`,
is used instead (see [pagination](./pagination.md#stable-pages)); every order ends
with the product `id`, so pages never overlap or skip.

An unknown or inactive collection is not an error: the list is empty and, when
paging is on, the headers say `X-Total-Count: 0` and `X-Total-Pages: 0`.

```http
GET /products?collection=everyday-essentials&page=2&limit=3
GET /products?collection=everyday-essentials&sort=price_asc&maxPrice=300000
```

`GET /products/filters` is not affected by collections.

## Admin endpoints

All need an `ADMIN` bearer token (`401` without a token, `403` for a customer).
Like every route, they are rate limited per signed-in user (see
[rate limiting](./rate-limiting.md)).

| Endpoint | Notes |
|---|---|
| `GET /admin/collections` | Every collection, inactive ones included, by `sortOrder` then `id`. Opt-in paging (default 20, at most 100). Each row adds `isActive`, `sortOrder`, `createdAt`, `updatedAt`, `productCount` (every product in it) and `visibleProductCount` (what the public sees). |
| `POST /admin/collections` | `name` required (2 to 120 characters). The slug is made from the name with the catalog's slug helper, or taken from `slug` when it is valid (lowercase letters and numbers joined by single dashes, at most 160 characters). Optional: `description`, `heroImageUrl`, `isActive` (default true), `isFeatured` (default false), `sortOrder` (0 to 100000, default 0). `409` with a clear message when the slug is taken. |
| `GET /admin/collections/:id` | The collection and its `products` in display order, inactive products included. |
| `PATCH /admin/collections/:id` | Any of the fields above. Changing the name does **not** change the slug (addresses stay stable); send `slug` to change it (`409` when another collection has it). `null` clears `description` and `heroImageUrl`. |
| `PATCH /admin/collections/:id/toggle` | Flips `isActive`. |
| `PUT /admin/collections/:id/products` | Replaces the whole membership, see below. |

### Replacing the products

```http
PUT /admin/collections/3/products
Authorization: Bearer <admin token>

{ "productIds": [12, 7, 31] }
```

`productIds` is the new membership **in display order**; positions are rewritten
`0..n-1`. The response is the saved ordered list:

```json
[
  { "id": 12, "name": "Classic Crewneck Cotton Tee", "slug": "classic-crewneck-cotton-tee", "status": "active", "position": 0 },
  { "id": 7, "name": "Heavy Canvas Daily Tote Bag", "slug": "heavy-canvas-daily-tote-bag", "status": "active", "position": 1 },
  { "id": 31, "name": "Old Jacket", "slug": "old-jacket", "status": "inactive", "position": 2 }
]
```

Rules:

- **One transaction.** The old rows are deleted and the new ones inserted
  together; if anything fails, the old membership is untouched. The collection row
  is locked first, so two replacements of the same collection run one after the
  other and never mix.
- **Every id must exist** (`400 These product ids do not exist: 40, 41`), **no
  repeats** (`400 productIds must not contain duplicates`), **at most 200**
  (`400`). Nothing is changed when a check fails. An empty list empties the
  collection.
- **Inactive products are allowed**, so an admin can prepare a collection before a
  product goes live; the public endpoints hide them until it is active.
- `404` for an unknown collection.

## Demo data

The development and test seeds create two sample collections (Everyday Essentials,
featured, and Layering Pieces) from products the seed already creates. The
production seed does not create collections yet. See [demo data](./demo-data.md).

## Tests

- Unit: slug handling, duplicate slugs, replacing the membership, the visibility
  rule and the DTOs (`src/collections`).
- Integration, against the isolated test database: the migration up and down, the
  constraints and cascades, the public and admin API, the all-or-nothing
  replacement (with a database trigger that makes one insert fail), roles, and
  `/products?collection=` with paging and sorting (`test/integration/collections*`
  and `demo-seed-collections`).
