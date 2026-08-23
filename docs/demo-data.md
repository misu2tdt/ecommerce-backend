# Local demo data

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

## Created demo content

- 2 Categories and 2 fictional Brands
- 3 active Products and 7 active ProductVariants with integer-VND prices
- one deliberately out-of-stock Variant
- no ProductImages, Cloudinary calls, Payments, or MoMo calls
- one saved Address, a Cart with 2 items, and one Wishlist item
- one DELIVERED historical Order with an immutable shipping snapshot
- one visible verified-purchase Product review

Reruns are safe and do not duplicate the known demo records. The seed does not
provide a global reset command; remove demo-owned records manually only when
that is intentionally required.
