# Local demo data and catalog seeding

Run the deterministic development seed from `ecommerce-backend`:

```powershell
npm.cmd run seed:demo
```

The command is development-only and refuses every database except the exact
`ecommerce_dev` allowlist target. It never truncates tables or deletes unrelated
developer records. Rerunning it updates or reuses records identified by the
seed-owned demo emails, slugs, SKUs, address label, cart relationships, Order
snapshot marker, and review relationship.

## Development-only logins

| Role     | Email                       | Password        |
| -------- | --------------------------- | --------------- |
| Customer | `demo.customer@example.com` | `DemoOnly!2026` |
| Admin    | `demo.admin@example.com`    | `DemoOnly!2026` |

These deterministic credentials are fictional and intended only for local
development. Never reuse either account or password for a public deployment.
The guarded production portfolio seed creates only the demo customer needed by
the order/review relationships; it never creates or updates an ADMIN account.

## Phase 6A Fashion demo content

The Phase 6A fashion seed manages the following Phase 6A-owned entity counts:

- **5 Categories**: `T-Shirts & Tops`, `Shirts & Polos`, `Hoodies & Outerwear`, `Pants & Shorts`, `Basics & Accessories`
- **4 Fictional Brands**: `AeroThread`, `Kanso Basics`, `Veloce Active`, `Monolith Studio`
- **26 Active Products** and **72 Active ProductVariants** with realistic integer-VND prices (99,000–789,000 VND)
- **4 deliberately out-of-stock Variants** across different product families
- no ProductImages, Cloudinary calls, Payments, or MoMo calls
- one saved Address (`Phase 6A Demo Address`), a Cart with 2 items, and one Wishlist item
- one DELIVERED historical Order (`Phase 6A Fashion Demo Suite`) with an immutable shipping snapshot
- one visible verified-purchase Product review on `Classic Crewneck Cotton Tee`

## Fresh database vs. Production upgrade behavior

### Fresh isolated database
On a newly provisioned database, the Phase 6A seed establishes:
- Total table counts matching the Phase 6A-owned set: 5 categories, 4 brands, 26 products, 72 variants
- Users: 1 demo customer in production mode (or 2 users including demo admin in development/test mode)
- 1 delivered order, 1 address, 1 review, 2 cart items, 1 wishlist item

### Existing production upgrade (from Phase 3B electronics seed)
On an already-seeded production database upgrading from the legacy electronics dataset:
- **Phase 6A-owned counts**: exactly 5 categories, 4 brands, 26 products, and 72 variants are upserted.
- **Legacy catalog records**: exact legacy products (`demo-novabook-air`, `demo-novabook-pro`, `demo-aster-phone-x`) are retired (`status = 'inactive'`) and legacy variants are deactivated (`isActive = false`) so they no longer appear in the public storefront. They are **not** deleted, preserving referential integrity for historical orders and reviews.
- **Whole-table counts**: total table counts will exceed Phase 6A counts due to preserved legacy records and unrelated operator accounts (e.g. total products = 29, total variants = 79, total categories = 7, total brands = 6, total users ≥ 2).
- **Historical orders & reviews**: the legacy Phase 3B order (`Phase 3B Demo Suite`) and its verified review remain 100% immutable and intact.
- **Operator accounts**: unrelated operator ADMIN accounts are completely preserved and never modified or overwritten.
- **Demo cart & wishlist**: legacy demo items pointing to retired electronics records are cleaned up for the demo customer, replaced by Phase 6A fashion demo items.

Reruns are idempotent and do not duplicate known demo records.
