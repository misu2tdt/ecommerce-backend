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
- The outcome is signed and verified like a callback (next section) before it
  is applied; a repeated outcome keeps the same event id as before, so the
  answers above did not change.

`cancel` is stored as a `failed` event flagged as cancelled, so the existing
`payment_events` constraint is unchanged and no migration is needed.

### The demo event pipeline: signed, then verified

The demo does not skip the front half of a real callback. Every demo event, from
`/demo/complete` and from the simulator below, is **signed by the API and sent
through `DemoEventIngressService`**, the counterpart of `MomoIpnService.process`,
before it reaches `PaymentsService.processEvent`, the function a MoMo callback
ends in. There is no public webhook route for demo events.

1. The ingress checks that demo mode is on (otherwise `404`).
2. It verifies the signature: HMAC-SHA256 over a canonical string (every field,
   alphabetical, URL-encoded, including `responseTime`), compared in constant
   time. A wrong signature is `401` and **nothing is read or written**.
3. It checks the time: `responseTime` must be within 5 minutes of the API's
   clock, either way, so an old signed event cannot be replayed later.
4. It loads the payment and requires provider `demo`, a matching provider
   payment id and an event id that starts with `demo:<paymentId>:`. Any mismatch
   is the same `404` as a payment that does not exist.
5. `processEvent` does the rest, exactly as for MoMo: event idempotency by
   `(provider, providerEventId)`, the lock order, order confirmation, and a late
   or conflicting event kept for an admin (`requires_reconciliation`).

The signing key is derived from `JWT_SECRET` with a fixed label
(`demo-payment-event-signing-v1`), so there is no new environment variable. It
never leaves the API: it is not returned, logged or put in an error message.

### Payment simulator: `POST /payments/:paymentId/demo/simulate`

For the demo payment page: the visitor picks what happens, and the API plays it
through the pipeline above. **No real money. `PAYMENT_PROVIDER=demo` only.**

```http
POST /payments/{paymentId}/demo/simulate
Authorization: Bearer <customer JWT>
Content-Type: application/json

{ "scenario": "success_twice" }
```

`scenario` is one of `success`, `declined`, `cancelled`, `success_twice`,
`success_after_expiry`, `delayed_success`, `invalid_signature`. Any other value
or extra field is `400`. The route is behind the same guard and authentication as
`/demo/complete`: `404` when `PAYMENT_PROVIDER` is not `demo` (before the token is
even looked at), and one `404` for a payment that is not of the caller's own
order, a MoMo payment or a payment that does not exist.

The payment must still be open (`pending` or `processing`); a finished payment is
`409` ("already finished"). Start a new payment for the order to try another
scenario. The route is limited to **20 a minute per signed-in user**.

Response, `200`, the same shape for every scenario:

| Field         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `scenario`    | The scenario that ran.                                                                       |
| `outcome`     | `completed`, or `scheduled` when the event will be delivered later (`delayed_success`).     |
| `explanation` | A short plain-English text, a constant in `demo-scenarios.ts`, for the storefront to show.   |
| `steps[]`     | `step` (1, 2, ...), `sent` (what was sent or done), `result`, `httpStatus` (what a real callback would have got) and `detail`. |
| `payment`     | The payment as it is when the answer is sent (same view as everywhere else).                 |
| `order`       | `{ id, status }` of its order, as it is when the answer is sent.                             |

`steps[].result` is one of:

- `applied`: the event changed the payment;
- `already_applied`: a new event, but the payment was already in that state;
- `duplicate`: the same event id was seen before, nothing was done;
- `recorded_for_review`: the order could no longer take the payment, so the event
  went to the reconciliation queue;
- `rejected_invalid_signature`: `401`, nothing read or written;
- `expiry_forced`: the order was made to expire now (`success_after_expiry`);
- `scheduled`: the event will be delivered after a delay (`delayed_success`).

The `explanation` strings are abbreviated below as `"…"`; the `payment` view is
abbreviated to `id`, `status` and `succeededAt` (it also has `provider`, `amount`,
`currency`, `createdAt`, `updatedAt`).

**`success`** (`declined` and `cancelled` look the same, with `"failed"` and
`"cancelled"`, an order that stays `"pending"`, and `sent` of
`a signed "payment failed" event` and `a signed "payment cancelled" event`):

```json
{
  "scenario": "success",
  "outcome": "completed",
  "explanation": "…",
  "steps": [
    {
      "step": 1,
      "sent": "a signed success event",
      "result": "applied",
      "httpStatus": 200,
      "detail": "The API accepted the event and the payment changed."
    }
  ],
  "payment": { "id": 42, "status": "succeeded", "succeededAt": "2026-11-18T08:00:05.000Z" },
  "order": { "id": 12, "status": "confirmed" }
}
```

**`success_twice`**: one signed message delivered twice, inside the time window,
with the same event id. One effect, one stored event:

```json
{
  "scenario": "success_twice",
  "outcome": "completed",
  "explanation": "…",
  "steps": [
    { "step": 1, "sent": "a signed success event", "result": "applied", "httpStatus": 200, "detail": "The API accepted the event and the payment changed." },
    { "step": 2, "sent": "the same signed success event again (a retry)", "result": "duplicate", "httpStatus": 200, "detail": "The API had already seen this event id, so it did nothing (idempotency)." }
  ],
  "payment": { "id": 42, "status": "succeeded", "succeededAt": "2026-11-18T08:00:05.000Z" },
  "order": { "id": 12, "status": "confirmed" }
}
```

**`success_after_expiry`**: the order's expiry is **forced, not waited for**. A
real order expires 30 minutes after it is placed and the sweep runs every 5
minutes, so the scenario calls the same cancellation (`cancelLockedOrder`) for this
one order only (`OrderExpiryService.expireOrderNow`; the sweep itself is
unchanged), then sends a signed success. The order is cancelled, its payment is
cancelled, its stock goes back on sale, and the late success is kept for an admin:

```json
{
  "scenario": "success_after_expiry",
  "outcome": "completed",
  "explanation": "…",
  "steps": [
    { "step": 1, "sent": "the order was made to expire now (forced, not waited for)", "result": "expiry_forced", "httpStatus": 200, "detail": "The order was cancelled by the same code as the real expiry, its payment was cancelled and its stock went back on sale." },
    { "step": 2, "sent": "a signed success event, too late", "result": "recorded_for_review", "httpStatus": 200, "detail": "The order could no longer take this payment, so the event was stored in the reconciliation queue for an admin." }
  ],
  "payment": { "id": 42, "status": "cancelled", "succeededAt": null },
  "order": { "id": 12, "status": "cancelled" }
}
```

It is allowed only for a payment started **in the last 15 minutes** (the database
clock decides) whose order is **still pending**, and it is refused with `409`
before anything changes when the reconciliation queue already holds **12 or more
unresolved events** (so anonymous visitors cannot fill the admin queue). Those
events are real queue items, an admin resolves them as usual
(`POST /admin/payments/reconciliation/:eventId/resolve`).

**`delayed_success`**: the answer comes at once, and the event is delivered after
10 seconds (`DEMO_DELAYED_CALLBACK_MS`). Until then the payment is `processing`:

```json
{
  "scenario": "delayed_success",
  "outcome": "scheduled",
  "explanation": "…",
  "steps": [
    { "step": 1, "sent": "a signed success event, to be delivered in 10 seconds", "result": "scheduled", "httpStatus": 202, "detail": "Nothing has changed yet. The payment stays processing until the event arrives." }
  ],
  "payment": { "id": 42, "status": "processing", "succeededAt": null },
  "order": { "id": 12, "status": "pending" }
}
```

The wait is a timer in the API's memory, with no table behind it. If the API
restarts (or a free instance goes to sleep) before it fires, the event is lost and
the payment stays `processing`; the buttons of the demo payment page
(`/demo/complete`) are the way out. See [known-limitations.md](./known-limitations.md).

**`invalid_signature`**: a success event that was changed after it was signed.
The ingress rejects it before reading anything, so no `payment_events` row is
written and nothing changes. The rejection is part of the `200` answer:

```json
{
  "scenario": "invalid_signature",
  "outcome": "completed",
  "explanation": "…",
  "steps": [
    { "step": 1, "sent": "a success event that was changed after it was signed", "result": "rejected_invalid_signature", "httpStatus": 401, "detail": "The signature did not match the event. The API rejected it with 401 and stored nothing." }
  ],
  "payment": { "id": 42, "status": "processing", "succeededAt": null },
  "order": { "id": 12, "status": "pending" }
}
```

Guarded in three layers: the route guard (`404` before authentication unless
demo mode is on), a mode check inside the simulator service, and the ingress,
which refuses any payment whose provider is not `demo`. A MoMo payment can never
be reached, and in momo mode every simulator route is `404`.

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
