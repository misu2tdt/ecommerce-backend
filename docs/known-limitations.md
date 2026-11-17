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

## Accounts and the email index

Emails are compared ignoring case and spaces when registering and signing in, and
new accounts are stored in lowercase. The database still has only the old unique
index on the exact text, so a duplicate that differs by case is stopped by the
application check and, for two requests at the same moment, by the exact-text
index (after lowercasing, a repeat is an exact repeat). Accounts created before
this change may still contain two that differ by case. Check for them with the
query in [free-deployment.md](./free-deployment.md#duplicate-email-check) before
adding a unique index on `lower("email")`, which is the planned next step.
