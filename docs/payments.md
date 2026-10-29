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

## Seed data

The demo seed gives the seeded delivered order one succeeded `demo` payment for
its total, so it reads as paid. See [demo-data.md](./demo-data.md).
