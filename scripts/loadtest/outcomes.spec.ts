import {
  answersMatchEvent,
  classifyCancelAnswer,
  demoEventId,
  distinctOutcomes,
  eventsMatchPayment,
  expectedOrderStatus,
  isTerminalPaymentStatus,
  oneCancelWon,
  outcomeForAttempt,
  type DemoOutcomeName,
  type EventStatus,
} from './outcomes';

const events = (entries: [DemoOutcomeName, EventStatus][]) => new Map(entries);

describe('rotating outcomes', () => {
  it('cycles success, failure, cancel', () => {
    expect(Array.from({ length: 7 }, (_, n) => outcomeForAttempt(n))).toEqual([
      'success',
      'failure',
      'cancel',
      'success',
      'failure',
      'cancel',
      'success',
    ]);
  });

  it('lists the distinct outcomes a number of requests carries', () => {
    expect(distinctOutcomes(0)).toEqual([]);
    expect(distinctOutcomes(1)).toEqual(['success']);
    expect(distinctOutcomes(2)).toEqual(['success', 'failure']);
    expect(distinctOutcomes(3)).toEqual(['success', 'failure', 'cancel']);
    expect(distinctOutcomes(20)).toEqual(['success', 'failure', 'cancel']);
  });

  it('names the event the way the backend does', () => {
    expect(demoEventId(12, 'cancel')).toBe('demo:12:cancel');
  });
});

describe('payment and order status', () => {
  it('knows the terminal payment statuses', () => {
    expect(isTerminalPaymentStatus('succeeded')).toBe(true);
    expect(isTerminalPaymentStatus('failed')).toBe(true);
    expect(isTerminalPaymentStatus('cancelled')).toBe(true);
    expect(isTerminalPaymentStatus('pending')).toBe(false);
    expect(isTerminalPaymentStatus('processing')).toBe(false);
    expect(isTerminalPaymentStatus(undefined)).toBe(false);
  });

  it('confirms the order only after a succeeded payment', () => {
    expect(expectedOrderStatus('succeeded')).toBe('confirmed');
    expect(expectedOrderStatus('failed')).toBe('pending');
    expect(expectedOrderStatus('cancelled')).toBe('pending');
    expect(expectedOrderStatus('processing')).toBeUndefined();
  });
});

describe('answers for one event id', () => {
  it('wants one applied and the rest already_applied for a processed event', () => {
    expect(
      answersMatchEvent(
        ['already_applied', 'applied', 'already_applied'],
        'processed',
      ),
    ).toBe(true);
    expect(answersMatchEvent(['applied'], 'processed')).toBe(true);
  });

  it('rejects two applied, none applied, or a stray review for a processed event', () => {
    expect(answersMatchEvent(['applied', 'applied'], 'processed')).toBe(false);
    expect(
      answersMatchEvent(['already_applied', 'already_applied'], 'processed'),
    ).toBe(false);
    expect(
      answersMatchEvent(['applied', 'recorded_for_review'], 'processed'),
    ).toBe(false);
  });

  it('wants every answer recorded_for_review for a reconciliation event', () => {
    expect(
      answersMatchEvent(
        ['recorded_for_review', 'recorded_for_review'],
        'requires_reconciliation',
      ),
    ).toBe(true);
    expect(
      answersMatchEvent(
        ['recorded_for_review', 'applied'],
        'requires_reconciliation',
      ),
    ).toBe(false);
  });

  it('fails when there are no answers or the event is missing', () => {
    expect(answersMatchEvent([], 'processed')).toBe(false);
    expect(answersMatchEvent(['applied'], undefined)).toBe(false);
  });
});

describe('events against the final payment status', () => {
  it('accepts a success that won, with later failure and cancel reviewed', () => {
    expect(
      eventsMatchPayment(
        'succeeded',
        events([
          ['success', 'processed'],
          ['failure', 'requires_reconciliation'],
          ['cancel', 'requires_reconciliation'],
        ]),
      ),
    ).toBe(true);
  });

  it('accepts a failure or cancel that won, with the late success reviewed', () => {
    expect(
      eventsMatchPayment(
        'cancelled',
        events([
          ['success', 'requires_reconciliation'],
          ['failure', 'processed'],
          ['cancel', 'processed'],
        ]),
      ),
    ).toBe(true);
    expect(
      eventsMatchPayment(
        'failed',
        events([
          ['success', 'requires_reconciliation'],
          ['failure', 'processed'],
        ]),
      ),
    ).toBe(true);
  });

  it('rejects a succeeded payment whose success was not processed', () => {
    expect(
      eventsMatchPayment(
        'succeeded',
        events([
          ['success', 'requires_reconciliation'],
          ['failure', 'processed'],
        ]),
      ),
    ).toBe(false);
    expect(
      eventsMatchPayment('succeeded', events([['failure', 'processed']])),
    ).toBe(false);
  });

  it('rejects a late success that was applied after a failure', () => {
    expect(
      eventsMatchPayment(
        'failed',
        events([
          ['success', 'processed'],
          ['failure', 'processed'],
        ]),
      ),
    ).toBe(false);
  });

  it('rejects a payment that is not terminal or has no events', () => {
    expect(
      eventsMatchPayment('pending', events([['success', 'processed']])),
    ).toBe(false);
    expect(eventsMatchPayment('succeeded', events([]))).toBe(false);
  });
});

describe('cancel answers', () => {
  it('names the documented answers', () => {
    expect(classifyCancelAnswer(201, '')).toBe('cancelled');
    expect(classifyCancelAnswer(200, '')).toBe('cancelled');
    expect(
      classifyCancelAnswer(
        409,
        'Paid Order cannot be cancelled before refund support',
      ),
    ).toBe('refused: paid');
    expect(
      classifyCancelAnswer(
        400,
        'Cannot transition Order from cancelled to cancelled',
      ),
    ).toBe('refused: already cancelled');
  });

  it('calls everything else other, a server error included', () => {
    expect(classifyCancelAnswer(500, '')).toBe('other');
    expect(classifyCancelAnswer(400, 'Something else')).toBe('other');
    expect(classifyCancelAnswer(404, 'Order not found')).toBe('other');
    expect(
      classifyCancelAnswer(
        500,
        'Cannot transition Order from cancelled to cancelled',
      ),
    ).toBe('other');
  });

  it('wants exactly one cancel and the rest refused as already cancelled', () => {
    expect(
      oneCancelWon([
        'refused: already cancelled',
        'cancelled',
        'refused: already cancelled',
      ]),
    ).toBe(true);
    expect(oneCancelWon(['cancelled', 'cancelled'])).toBe(false);
    expect(
      oneCancelWon([
        'refused: already cancelled',
        'refused: already cancelled',
      ]),
    ).toBe(false);
    expect(oneCancelWon(['cancelled', 'other'])).toBe(false);
    expect(oneCancelWon(['cancelled', 'refused: paid'])).toBe(false);
    expect(oneCancelWon([])).toBe(false);
  });
});
