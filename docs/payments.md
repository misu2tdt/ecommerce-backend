# Payments

An order is paid through a **payment attempt**. The backend creates the attempt
(amount and currency always come from the stored order, never from the client),
a **provider** carries the customer through paying, and the provider reports the
result back as an event. Every result, from any provider, is applied by one
function: `PaymentsService.processEvent`.

`processEvent` does the following, in one transaction:

- locks the payment, then the order (always in that order);
- records the event once (`payment_events` is unique per provider and event id),
  so a repeated event is harmless;
- on success confirms the order, or, if the order is no longer pending, records
  the event as `requires_reconciliation` for an admin (for example a success
  that arrives after the order expired);
- on failure marks the payment failed (or cancelled), leaves the order pending
  and lets the customer try again.

## Providers: `PAYMENT_PROVIDER`

| Value  | Meaning                                                                           |
| ------ | --------------------------------------------------------------------------------- |
| `momo` | The default. Real MoMo checkout; results arrive as signed IPN callbacks.          |
| `demo` | A stand-in for the public portfolio demo. **No real money.** See below.           |

Any other value stops the application at startup with
`PAYMENT_PROVIDER must be "momo" or "demo"`. The setting is read once at boot.

## Demo payments (`PAYMENT_PROVIDER=demo`)

For visitors of the portfolio demo, who cannot pay with MoMo. At boot the API
logs `DEMO PAYMENTS ENABLED, no real money`.

1. The frontend creates an attempt exactly as before:
   `POST /orders/:orderId/payments` with an `Idempotency-Key` header. The
   idempotency rules and the one-active-payment-per-order rule are unchanged.
   The response has the same shape, with `provider: "demo"` and no `checkoutUrl`.
2. The frontend sends the visitor to its own demo page, which calls:

```http
POST /payments/{paymentId}/demo/complete
Authorization: Bearer <customer JWT>
Content-Type: application/json

{ "outcome": "success" }        // or "failure" or "cancel"
```

Response, `200` (the same shape for every outcome):

```json
{
  "outcome": "success",
  "result": "applied",
  "payment": {
    "id": 42,
    "provider": "demo",
    "amount": 400000,
    "currency": "VND",
    "status": "succeeded",
    "createdAt": "2026-08-15T08:00:00.000Z",
    "updatedAt": "2026-08-15T08:00:05.000Z",
    "succeededAt": "2026-08-15T08:00:05.000Z"
  },
  "order": { "id": 12, "status": "confirmed" }
}
```

`result` tells what happened to this request:

- `applied`: this outcome was applied now;
- `already_applied`: the same outcome was sent before (a double click or a
  retry); nothing changed;
- `recorded_for_review`: the order could no longer take this outcome (it
  expired, or another outcome won first), so the event was kept for an admin on
  the reconciliation list and the payment and order were not changed.

| Outcome   | Payment     | Order                         | Next                |
| --------- | ----------- | ----------------------------- | ------------------- |
| `success` | `succeeded` | `confirmed`                   | done                |
| `failure` | `failed`    | stays `pending`               | a new attempt works |
| `cancel`  | `cancelled` | stays `pending`               | a new attempt works |

Rules:

- A JWT is required. The payment must belong to the caller's order and have
  provider `demo`; otherwise the answer is the same `404` as for a payment that
  does not exist.
- When `PAYMENT_PROVIDER` is not `demo` the route answers `404` to everyone,
  even without a token.
- The body holds only `outcome`; any other field is rejected with `400`.
  Amount and currency come from the stored payment.
- The event id is fixed by payment and outcome (`demo:<paymentId>:<outcome>`),
  so repeating a request, or two concurrent identical requests, record one event.
- The route is rate limited like the other routes.

`cancel` is stored as a `failed` event flagged as cancelled, so the existing
`payment_events` constraint is unchanged and no migration is needed.

## For admins

Both endpoints need the ADMIN role (`401` without a token, `403` for anyone
else).

### Payments of an order: `GET /admin/orders/:id`

The order exactly as before (every existing field is unchanged), plus
`payments`: the order's payment attempts, **newest first** (by creation time,
then id). It is the same safe view a customer gets from
`GET /orders/:orderId/payments`, so it never holds the idempotency key, the
provider's payment id, raw provider data or any secret. An order that was never
paid for has `"payments": []`. An unknown order is `404`, an id that is not a
number is `400`. Only this endpoint has `payments`; the order lists, the
customer's order and the status change answer as before.

```json
{
  "id": 7,
  "userId": 3,
  "status": "cancelled",
  "totalPrice": 24990000,
  "items": ["..."],
  "payments": [
    {
      "id": 42,
      "provider": "momo",
      "amount": 24990000,
      "currency": "VND",
      "status": "cancelled",
      "createdAt": "2026-10-28T09:00:00.000Z",
      "updatedAt": "2026-10-28T09:20:00.000Z",
      "succeededAt": null
    }
  ]
}
```

The view has no failure code or message, because the customer's view has none.

### Reconciliation queue: `GET /admin/payments/reconciliation`

Payment events the system could not apply cleanly (a success after the order was
cancelled, a failure after a success), newest first. The body is
`{ items, page, limit, total }`.

| Query | Meaning |
| --- | --- |
| `status` | `unresolved` (default), `resolved` or `all` |
| `page`, `limit` | From 1; `limit` 20 by default, at most 100 (more is `400`, not clamped) |
| `orderId` | Only the events of this order (all its payment attempts). A whole number from 1 to 2147483647; anything else is `400`. An order that does not exist, or has no events, gives `{ "items": [], "total": 0, ... }`, not an error. Works together with `status`, `page` and `limit`, and `total` counts only the filtered events. |

`POST /admin/payments/reconciliation/:eventId/resolve` with `{ "note": "..." }`
(3 to 500 characters after trimming) records who handled an event, when, and the
note. It changes no order, payment or stock.

## Seed data

The demo seed gives the seeded delivered order one succeeded `demo` payment for
its total, so it reads as paid. See [demo-data.md](./demo-data.md).
