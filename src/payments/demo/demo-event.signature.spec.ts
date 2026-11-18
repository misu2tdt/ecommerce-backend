import { PaymentEventType } from '../entities/payment-event-type.enum';
import {
  buildDemoEventCanonical,
  DEMO_EVENT_WINDOW_MS,
  DemoEventEnvelope,
  deriveDemoEventKey,
  isWithinDemoEventWindow,
  signDemoEvent,
  signDemoProviderEvent,
  toProviderPaymentEvent,
  verifyDemoEventSignature,
} from './demo-event.signature';

const KEY = deriveDemoEventKey('a-test-secret-for-the-api');
const NOW = new Date('2026-11-17T10:00:00.000Z');

function signed(overrides: Partial<DemoEventEnvelope> = {}): DemoEventEnvelope {
  return {
    ...signDemoProviderEvent(
      {
        provider: 'demo',
        providerEventId: 'demo:12:success',
        providerPaymentId: 'demo_payment_12',
        eventType: PaymentEventType.SUCCEEDED,
      },
      KEY,
      NOW,
    ),
    ...overrides,
  };
}

describe('the demo event key', () => {
  it('is derived from the secret, the same way every time', () => {
    expect(deriveDemoEventKey('secret-one')).toEqual(
      deriveDemoEventKey('secret-one'),
    );
    expect(deriveDemoEventKey('secret-one')).not.toEqual(
      deriveDemoEventKey('secret-two'),
    );
  });

  it('is not the secret itself and is 32 bytes', () => {
    const key = deriveDemoEventKey('secret-one');
    expect(key).toHaveLength(32);
    expect(key.toString('utf8')).not.toContain('secret-one');
    expect(key.toString('hex')).not.toContain(
      Buffer.from('secret-one').toString('hex'),
    );
  });

  it('refuses an empty secret instead of deriving a key from nothing', () => {
    expect(() => deriveDemoEventKey('')).toThrow(
      'JWT_SECRET must be configured',
    );
  });
});

describe('signing and verifying a demo event', () => {
  it('accepts an event signed with the same key', () => {
    expect(verifyDemoEventSignature(signed(), KEY)).toBe(true);
  });

  it('signs a 64-character hex HMAC', () => {
    expect(signed().signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each<[string, Partial<DemoEventEnvelope>]>([
    ['the event type', { eventType: PaymentEventType.FAILED }],
    ['the event id', { providerEventId: 'demo:13:success' }],
    ['the payment id', { providerPaymentId: 'demo_payment_13' }],
    ['the provider', { provider: 'momo' }],
    ['the cancelled flag', { cancelled: true }],
    ['the failure code', { failureCode: 'X' }],
    ['the failure message', { failureMessage: 'changed' }],
    ['the time', { responseTime: NOW.getTime() + 1 }],
  ])('rejects an event whose %s was changed after signing', (_name, change) => {
    expect(verifyDemoEventSignature(signed(change), KEY)).toBe(false);
  });

  it('rejects an event signed with another key', () => {
    const other = deriveDemoEventKey('another-secret');
    const forged = signDemoProviderEvent(
      {
        provider: 'demo',
        providerEventId: 'demo:12:success',
        providerPaymentId: 'demo_payment_12',
        eventType: PaymentEventType.SUCCEEDED,
      },
      other,
      NOW,
    );

    expect(verifyDemoEventSignature(forged, KEY)).toBe(false);
  });

  it.each(['', 'abc', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])(
    'rejects a signature that is not 64 hex characters (%j) without throwing',
    (signature) => {
      expect(verifyDemoEventSignature(signed({ signature }), KEY)).toBe(false);
    },
  );

  it('rejects a missing signature without throwing', () => {
    const envelope = signed() as unknown as Record<string, unknown>;
    delete envelope.signature;

    expect(
      verifyDemoEventSignature(envelope as unknown as DemoEventEnvelope, KEY),
    ).toBe(false);
  });

  it('accepts upper-case hex, which is still the same bytes', () => {
    const envelope = signed();

    expect(
      verifyDemoEventSignature(
        { ...envelope, signature: envelope.signature.toUpperCase() },
        KEY,
      ),
    ).toBe(true);
  });

  it('keeps a failed and a cancelled event apart', () => {
    const failed = signDemoProviderEvent(
      {
        provider: 'demo',
        providerEventId: 'demo:12:cancel',
        providerPaymentId: 'demo_payment_12',
        eventType: PaymentEventType.FAILED,
        cancelled: true,
        failureCode: 'DEMO_CANCELLED',
        failureMessage: 'Demo payment was cancelled',
      },
      KEY,
      NOW,
    );

    expect(verifyDemoEventSignature(failed, KEY)).toBe(true);
    expect(verifyDemoEventSignature({ ...failed, cancelled: false }, KEY)).toBe(
      false,
    );
  });
});

describe('the canonical string', () => {
  it('lists every field in alphabetical order, URL-encoded', () => {
    const unsigned: Partial<DemoEventEnvelope> = signed({
      failureMessage: 'a=b&c d',
    });
    delete unsigned.signature;

    expect(
      buildDemoEventCanonical(
        unsigned as Parameters<typeof buildDemoEventCanonical>[0],
      ),
    ).toBe(
      [
        'cancelled=0',
        'eventType=succeeded',
        'failureCode=',
        'failureMessage=a%3Db%26c%20d',
        'provider=demo',
        'providerEventId=demo%3A12%3Asuccess',
        'providerPaymentId=demo_payment_12',
        `responseTime=${NOW.getTime()}`,
      ].join('&'),
    );
  });

  it('does not let one value slide into the next field', () => {
    const base = {
      provider: 'demo',
      providerEventId: 'demo:12:success',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.SUCCEEDED,
      cancelled: false,
      responseTime: NOW.getTime(),
    };
    const one = {
      ...base,
      failureCode: 'A&failureMessage=B',
      failureMessage: '',
    };
    const two = { ...base, failureCode: 'A', failureMessage: 'B' };

    expect(buildDemoEventCanonical(one)).not.toBe(buildDemoEventCanonical(two));
    expect(signDemoEvent(one, KEY)).not.toBe(signDemoEvent(two, KEY));
  });
});

describe('the time window', () => {
  it('accepts a time within 5 minutes of now, either way', () => {
    expect(DEMO_EVENT_WINDOW_MS).toBe(5 * 60_000);
    expect(isWithinDemoEventWindow(NOW.getTime(), NOW)).toBe(true);
    expect(
      isWithinDemoEventWindow(NOW.getTime() - DEMO_EVENT_WINDOW_MS, NOW),
    ).toBe(true);
    expect(
      isWithinDemoEventWindow(NOW.getTime() + DEMO_EVENT_WINDOW_MS, NOW),
    ).toBe(true);
  });

  it('refuses a replay older than 5 minutes and a time too far ahead', () => {
    expect(
      isWithinDemoEventWindow(NOW.getTime() - DEMO_EVENT_WINDOW_MS - 1, NOW),
    ).toBe(false);
    expect(
      isWithinDemoEventWindow(NOW.getTime() + DEMO_EVENT_WINDOW_MS + 1, NOW),
    ).toBe(false);
  });

  it('refuses a time that is not a finite number', () => {
    expect(isWithinDemoEventWindow(NaN, NOW)).toBe(false);
    expect(isWithinDemoEventWindow(Infinity, NOW)).toBe(false);
  });
});

describe('toProviderPaymentEvent', () => {
  it('gives back the event that was signed, without empty fields', () => {
    expect(toProviderPaymentEvent(signed())).toEqual({
      provider: 'demo',
      providerEventId: 'demo:12:success',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.SUCCEEDED,
    });
  });

  it('keeps the cancelled flag and the failure texts', () => {
    expect(
      toProviderPaymentEvent(
        signed({
          eventType: PaymentEventType.FAILED,
          cancelled: true,
          failureCode: 'DEMO_CANCELLED',
          failureMessage: 'Demo payment was cancelled',
        }),
      ),
    ).toEqual({
      provider: 'demo',
      providerEventId: 'demo:12:success',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.FAILED,
      cancelled: true,
      failureCode: 'DEMO_CANCELLED',
      failureMessage: 'Demo payment was cancelled',
    });
  });
});
