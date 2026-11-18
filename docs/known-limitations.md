# Known limitations

Things the API does not do, or does less well than it could, with the reason and
the fix that is not done yet. Short and factual; none of them loses money.

## A lost provider response leaves the order unpayable until it expires

**What happens.** Paying with MoMo asks MoMo for a checkout link, and the link is
in that one response only: it is not stored. If the response is lost (a timeout
between the storefront and the API, a closed tab) the customer has a payment in
state `processing` and no link. Retrying with the same `Idempotency-Key` returns
that payment again, still without a link. A new key is refused with "Order already
has an active payment", because an order may have only one payment that is
pending, processing or succeeded (a unique index enforces it, so that two
checkout links can never lead to a double charge).

**Until when.** Until the order passes its payment window
(`ORDER_PAYMENT_WINDOW_MINUTES`, 30 by default) and the expiry sweep, which runs
every 5 minutes, cancels it and its payment. Then the customer has to place the
order again. No money moves in the meantime and the stock is released.

**Fix, not done.** Store the checkout link on the payment (a column and a
migration) and return it when the same key is sent again while the payment is
`processing`. Or ask MoMo for the status of the payment before refusing. The demo
provider has no link and is not affected.

## The admin role comes from the token for up to 15 minutes

**What happens.** `AuthGuard` and `RolesGuard` trust the `role` in the signed JWT;
nothing reads the user's row on an admin request. An admin who is demoted or
deleted keeps admin access until their token expires (`JWT_EXPIRES_IN`, 15
minutes in `render.yaml`).

**Why it is small.** There is no endpoint that demotes or deletes a user, so it
takes a manual change in the database, and the window is 15 minutes.

**Fix, not done.** On `@Roles(ADMIN)` routes, read the role from the database
(one primary-key lookup), or keep a token version per user and refuse older
tokens.

## Time columns are `timestamp without time zone`

**What happens.** Nearly every time column is `timestamp without time zone`. The
database clock writes all of them (`now()`), and the Node.js driver reads and
writes them as UTC (see [local-development.md](./local-development.md#time-stamps-and-time-zones)),
so the API is right whatever the time zone of the Node.js process. It is only
right while the database session runs on UTC, which is the default of the Docker
image and of Neon. The API logs a warning at startup when it does not. The order
expiry job and the analytics SQL convert in the database and do not depend on this.

**Fix, not done.** Move the columns to `timestamp with time zone` in a migration
(converting each value with `AT TIME ZONE 'UTC'`), then drop the convention. It
rewrites every table that has such a column, so it is a separate decision. The
coupon windows (`startsAt`, `endsAt`) are already `timestamp with time zone`.

## The order expiry sweep can fall behind under load

**What happens.** Each sweep takes the 50 oldest overdue orders (lowest ids first),
every 5 minutes. That releases at most about 600 orders an hour. After a Render
Free instance has slept, the overdue orders are released 50 at a time, so a large
backlog takes several sweeps. An order whose cancellation fails every time (for
example a variant that was deleted) stays at the head of the list and is retried
on every sweep, ahead of newer overdue orders.

**Why it is small.** A portfolio store has few unpaid orders, and the payment
window is not a promise to the second: a late order only holds its stock a little
longer. A payment that arrives for an order that was already cancelled is parked
for an admin, not lost.

**Fix, not done.** Repeat the batch within one sweep until a batch comes back
short, with a time limit; and skip the ids that failed in this sweep so one bad
order can not starve the others.

## The payment simulator of the demo

The simulator (`POST /payments/:id/demo/simulate`, `PAYMENT_PROVIDER=demo` only,
see [payments.md](./payments.md)) is for the portfolio demo. It has these limits:

**The demo account is shared.** The credentials of the demo customer are public,
so "the caller's own payment" is not a separation between visitors: anyone signed
in as the demo customer can run a scenario on the open payment of any other
visitor using the same account, and `success_after_expiry` cancels that order.
It is accepted because the demo has no real money and no real customers. What
limits the damage: the scenario only works on a payment started in the last 15
minutes, on an order that is still pending, 20 times a minute per user.
Registering an account of one's own makes every scenario private.

**Expiry is forced, not waited for.** A real order expires 30 minutes after it
is placed and the sweep runs every 5 minutes, so a visitor cannot wait for it.
`success_after_expiry` makes one order expire immediately through the same code
(`cancelLockedOrder`), then sends a late success. It shows the same result a
real late callback would have; it does not show the timing. The answer says so.

**A delayed callback is lost on restart.** The 10-second wait is a timer in the
memory of the API, with no table behind it. If the API restarts (a deployment,
or a free Render instance going to sleep) before it fires, the event is never
delivered and the payment stays `processing`. The buttons of the demo payment
page (`/demo/complete`) finish it. A table with scheduled events and the order
expiry scheduler to deliver them would fix it; it was left out on purpose.

**The reconciliation queue can fill.** `success_after_expiry` stores an event for
an admin. It is refused while 12 or more unresolved events wait, so the queue
cannot grow without bound, but the count is read before the order is expired and
not under a lock: several requests at the very same moment can pass a little
beyond 12. An admin must resolve the demo events for the scenario to work again.

## Accounts and the email index

Emails are compared ignoring case and spaces when registering and signing in, and
new accounts are stored in lowercase. The database still has only the old unique
index on the exact text, so a duplicate that differs by case is stopped by the
application check and, for two requests at the same moment, by the exact-text
index (after lowercasing, a repeat is an exact repeat). Accounts created before
this change may still contain two that differ by case. Check for them with the
query in [free-deployment.md](./free-deployment.md#duplicate-email-check) before
adding a unique index on `lower("email")`, which is the planned next step.
