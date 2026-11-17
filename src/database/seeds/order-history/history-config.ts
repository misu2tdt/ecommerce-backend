// What the order history is made of. The numbers are the contract of the seed:
// they are asserted by unit and integration tests and quoted in docs/demo-data.md.

// Changing the seed changes the history a fresh database gets.
export const HISTORY_SEED = 20_261_117;

export const HISTORY_CUSTOMER_COUNT = 40;
export const HISTORY_ORDER_COUNT = 400;
export const HISTORY_DAYS = 90;

// Orders left pending, created in the last 28 minutes: inside the payment window
// (30 minutes), so they look live. The expiry job cancels them later and gives
// their reserved stock back, exactly as it does for a real unpaid order.
export const HISTORY_PENDING_COUNT = 6;
export const HISTORY_PENDING_MAX_AGE_MINUTES = 28;

// Share of all orders that end cancelled (32 of 400).
export const HISTORY_CANCELLED_SHARE = 0.08;

export const HISTORY_REVIEW_TARGET = 80;

export const HISTORY_UNRESOLVED_EVENTS = 4;
export const HISTORY_RESOLVED_EVENTS = 2;

// Weekend and time-of-day shaping use Vietnam time (UTC+7, no daylight saving),
// the store's market and the default time zone of the analytics API.
export const HISTORY_LOCAL_OFFSET_MINUTES = 7 * 60;

// Payments written by the seed carry this prefix in their idempotency key.
export const HISTORY_PAYMENT_KEY_PREFIX = 'history-seed-';

// The payment provider of the public demo (PAYMENT_PROVIDER=demo).
export const HISTORY_PAYMENT_PROVIDER = 'demo';
