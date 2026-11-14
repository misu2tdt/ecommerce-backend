// Pure rules used by the payment and cancellation scenarios when several
// different events or repeated cancels hit the same order. No I/O, so they are
// unit tested; the scenarios feed them what they read from the responses and
// the database.

export type DemoOutcomeName = 'success' | 'failure' | 'cancel';
export type EventStatus = 'processed' | 'requires_reconciliation';

export const DEMO_OUTCOMES: readonly DemoOutcomeName[] = [
  'success',
  'failure',
  'cancel',
];

/** The outcome sent by the n-th parallel request: success, failure, cancel, success, ... */
export function outcomeForAttempt(attempt: number): DemoOutcomeName {
  return DEMO_OUTCOMES[attempt % DEMO_OUTCOMES.length];
}

/** Which different outcomes (and so event ids) `count` parallel requests carry. */
export function distinctOutcomes(count: number): DemoOutcomeName[] {
  return DEMO_OUTCOMES.slice(0, Math.min(Math.max(count, 0), 3));
}

/** The event id the backend gives a demo completion (payment id and outcome). */
export function demoEventId(paymentId: number, outcome: DemoOutcomeName) {
  return `demo:${paymentId}:${outcome}`;
}

/** Payment statuses after which no further provider event can change the order. */
export function isTerminalPaymentStatus(status: string | undefined): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled'
  );
}

/**
 * The order status that goes with a final payment status: only a success
 * confirms the order; a failed or cancelled payment leaves it pending.
 */
export function expectedOrderStatus(
  paymentStatus: string | undefined,
): string | undefined {
  if (paymentStatus === 'succeeded') return 'confirmed';
  if (paymentStatus === 'failed' || paymentStatus === 'cancelled') {
    return 'pending';
  }
  return undefined;
}

/**
 * All answers given for one event id, against how that event was stored. An
 * event that was processed has exactly one request that applied it and the
 * rest "already_applied"; an event that conflicted with the payment's state was
 * recorded for review, and every request carrying it says so.
 */
export function answersMatchEvent(
  answers: readonly unknown[],
  status: EventStatus | undefined,
): boolean {
  if (answers.length === 0 || status === undefined) return false;
  if (status === 'requires_reconciliation') {
    return answers.every((answer) => answer === 'recorded_for_review');
  }
  const applied = answers.filter((answer) => answer === 'applied').length;
  const repeated = answers.filter(
    (answer) => answer === 'already_applied',
  ).length;
  return applied === 1 && repeated === answers.length - 1;
}

/**
 * Whether the stored events agree with the payment's final status. The first
 * event to win the payment lock decides: if it was the success, the payment
 * succeeded and every failure or cancel that came after was recorded for
 * review; otherwise the success came too late and was recorded for review while
 * the failure and cancel events were processed.
 */
export function eventsMatchPayment(
  paymentStatus: string | undefined,
  events: ReadonlyMap<DemoOutcomeName, EventStatus>,
): boolean {
  if (!isTerminalPaymentStatus(paymentStatus) || events.size === 0) {
    return false;
  }
  const succeeded = paymentStatus === 'succeeded';
  if (succeeded && events.get('success') !== 'processed') return false;
  for (const [outcome, status] of events) {
    if (outcome === 'success') {
      if (!succeeded && status !== 'requires_reconciliation') return false;
    } else if (succeeded && status !== 'requires_reconciliation') {
      return false;
    } else if (!succeeded && status !== 'processed') {
      return false;
    }
  }
  return true;
}

export type CancelAnswer =
  | 'cancelled'
  | 'refused: paid'
  | 'refused: already cancelled'
  | 'other';

/** The documented answers to a cancel request; anything else (5xx included) is "other". */
export function classifyCancelAnswer(
  status: number,
  message: string,
): CancelAnswer {
  if (status === 200 || status === 201) return 'cancelled';
  if (status === 409 && /paid order cannot be cancelled/i.test(message)) {
    return 'refused: paid';
  }
  if (
    status === 400 &&
    /cannot transition order from cancelled to cancelled/i.test(message)
  ) {
    return 'refused: already cancelled';
  }
  return 'other';
}

/** Exactly one cancel won and every other one was refused because it was already cancelled. */
export function oneCancelWon(answers: readonly CancelAnswer[]): boolean {
  return (
    answers.length > 0 &&
    answers.filter((answer) => answer === 'cancelled').length === 1 &&
    answers.filter((answer) => answer === 'refused: already cancelled')
      .length ===
      answers.length - 1
  );
}
