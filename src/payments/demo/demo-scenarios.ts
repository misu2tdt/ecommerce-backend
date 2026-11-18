// The scenarios of the payment simulator (PAYMENT_PROVIDER=demo only) and the
// words that go with them. The explanations are constants here, so the
// storefront shows what the backend means and not its own paraphrase.

export const DEMO_SCENARIOS = [
  'success',
  'declined',
  'cancelled',
  'success_twice',
  'success_after_expiry',
  'delayed_success',
  'invalid_signature',
] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

// "completed": everything happened before the answer. "scheduled": the event
// will be delivered later (delayed_success).
export type DemoScenarioOutcome = 'completed' | 'scheduled';

// What happened to one event or action.
export type DemoStepResult =
  // the event changed the payment (and maybe the order)
  | 'applied'
  // a new event that found the payment already in that state
  | 'already_applied'
  // the same event id was seen before: nothing was done
  | 'duplicate'
  // a late or conflicting event, stored for an admin to look at
  | 'recorded_for_review'
  // the signature did not fit: nothing was read or written
  | 'rejected_invalid_signature'
  // the order's expiry was forced (success_after_expiry)
  | 'expiry_forced'
  // the event will be delivered after a delay
  | 'scheduled';

export interface DemoScenarioStep {
  step: number;
  // What was sent or done, in words.
  sent: string;
  result: DemoStepResult;
  // The status code a real callback would have been answered with.
  httpStatus: number;
  detail: string;
}

// The most a delayed callback is held back. The timer lives in the memory of the
// API: it is lost if the API restarts (or a free instance goes to sleep), and the
// payment then simply stays "processing", with the buttons of the demo payment
// page as the way out.
export const DEMO_DELAYED_CALLBACK_MS = 10_000;

// success_after_expiry only works on a recent payment of an order that is still
// waiting for payment, so that the demo cannot be used to cancel old orders.
export const DEMO_EXPIRY_PAYMENT_MAX_AGE_MINUTES = 15;

// success_after_expiry stores an event for an admin. It is refused while the
// queue already holds this many unresolved events.
export const DEMO_RECONCILIATION_QUEUE_CAP = 12;

export const DEMO_SCENARIO_EXPLANATIONS: Record<DemoScenario, string> = {
  success:
    'A signed "payment succeeded" event reaches the API, the same way a real provider callback does. The payment is marked succeeded and the order is confirmed.',
  declined:
    'A signed "payment failed" event arrives. The payment is marked failed. The order stays unpaid, so you can start a new payment for it.',
  cancelled:
    'A signed "payment cancelled" event arrives, as when a customer closes the payment page. The payment is marked cancelled. The order stays unpaid, so you can start a new payment for it.',
  success_twice:
    'The same signed success event is delivered twice, as a real provider does when it retries. The first one confirms the order. The second carries the same event id, so the API recognises it and does nothing: a payment is never applied twice.',
  success_after_expiry:
    'The order is made to expire right now, using the same code that cancels unpaid orders after their payment window (this was forced, not waited for: a real order expires 30 minutes after it is placed, and a sweep runs every 5 minutes). Its stock goes back on sale and its payment is cancelled. Then a signed success event arrives too late. The API does not confirm a cancelled order: it keeps the event in the reconciliation queue for an admin to look at.',
  delayed_success:
    'A signed success event is held back for about 10 seconds before it is delivered, as when a provider is slow. Until it arrives the payment stays processing and the order stays unpaid. If the API restarts in the meantime the event is lost and the payment stays processing; use the buttons of the demo payment page to finish it.',
  invalid_signature:
    'A success event whose signature does not match it (as if someone had changed it on the way) is sent. The API rejects it with 401 before reading anything: nothing is stored and the payment and the order do not change.',
};
