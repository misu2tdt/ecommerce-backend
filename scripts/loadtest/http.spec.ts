import {
  fieldOf,
  mapLimit,
  messageOf,
  recordOf,
  runBurst,
  shuffle,
  type ApiResponse,
} from './http';

function response(status: number, body: unknown = null, ms = 5): ApiResponse {
  return { status, body, ms };
}

describe('response helpers', () => {
  it('reads a Nest error message, string or list', () => {
    expect(
      messageOf(response(400, { message: 'Variant X has insufficient stock' })),
    ).toBe('Variant X has insufficient stock');
    expect(messageOf(response(400, { message: ['a', 'b'] }))).toBe('a; b');
    expect(messageOf(response(500, 'plain text'))).toBe('plain text');
    expect(messageOf({ status: 0, ms: 1, body: null, error: 'timeout' })).toBe(
      'timeout',
    );
    expect(messageOf(response(200, null))).toBe('');
  });

  it('reads a field of a JSON body', () => {
    expect(fieldOf(response(200, { id: 7 }), 'id')).toBe(7);
    expect(fieldOf(response(200, null), 'id')).toBeUndefined();
    expect(fieldOf(response(200, 'text'), 'id')).toBeUndefined();
  });
});

describe('recording an answer', () => {
  it('counts every 429 as throttled, whatever the classifier says', () => {
    expect(recordOf(response(429), () => ({ kind: 'success' }))).toMatchObject({
      kind: 'throttled',
      status: 429,
    });
  });

  it('keeps the classification, status and latency', () => {
    expect(
      recordOf(response(400, null, 12), () => ({
        kind: 'expected_refusal',
        tag: 'x',
      })),
    ).toEqual({
      kind: 'expected_refusal',
      tag: 'x',
      status: 400,
      ms: 12,
      note: undefined,
    });
  });

  it('explains an unexpected answer when the classifier does not', () => {
    const record = recordOf(
      response(500, { message: 'Internal server error' }),
      () => ({ kind: 'unexpected' }),
    );
    expect(record.note).toBe('500 Internal server error');
    expect(
      recordOf({ status: 0, ms: 1, body: null, error: 'fetch failed' }, () => ({
        kind: 'unexpected',
      })).note,
    ).toBe('no response fetch failed');
  });
});

describe('burst', () => {
  it('sends nothing until every request is queued, then everything together', async () => {
    const events: string[] = [];
    const planned = Array.from({ length: 4 }, (_, index) => ({
      send: () => {
        events.push(`send ${index}`);
        return Promise.resolve(response(201));
      },
      classify: () => ({ kind: 'success' as const }),
    }));

    const pending = runBurst('burst', planned);
    expect(events).toEqual([]);
    const { burst, responses } = await pending;

    expect(events).toEqual(['send 0', 'send 1', 'send 2', 'send 3']);
    expect(responses).toHaveLength(4);
    expect(burst.label).toBe('burst');
    expect(burst.records.map((record) => record.kind)).toEqual([
      'success',
      'success',
      'success',
      'success',
    ]);
    expect(burst.wallMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps answers in the order of the requests', async () => {
    const { responses } = await runBurst('order', [
      {
        send: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return response(201, { n: 1 });
        },
        classify: () => ({ kind: 'success' }),
      },
      {
        send: () => Promise.resolve(response(201, { n: 2 })),
        classify: () => ({ kind: 'success' }),
      },
    ]);
    expect(responses.map((item) => fieldOf(item, 'n'))).toEqual([1, 2]);
  });
});

describe('mapLimit', () => {
  it('never runs more than the limit at once and keeps result order', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return item * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 3, () => Promise.resolve(1))).toEqual([]);
  });
});

describe('shuffle', () => {
  it('keeps the same items', () => {
    expect(shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
