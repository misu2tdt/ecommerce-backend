// HTTP helpers: a timed request, the "release everyone together" barrier and a
// bounded-concurrency map for setup work.

import { performance } from 'node:perf_hooks';
import type { Burst, RequestRecord } from './report';

const REQUEST_TIMEOUT_MS = 120_000;

export interface ApiResponse {
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  ms: number;
  body: unknown;
  error?: string;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class Api {
  constructor(private readonly baseUrl: string) {}

  async request(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined)
      headers['Content-Type'] = 'application/json';

    const startedAt = performance.now();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      const ms = performance.now() - startedAt;
      let body: unknown = text;
      try {
        body = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        // Not JSON: keep the text.
      }
      return { status: response.status, ms, body };
    } catch (error) {
      return {
        status: 0,
        ms: performance.now() - startedAt,
        body: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** The error message of a Nest error body (a string or a list), or the text. */
export function messageOf(response: ApiResponse): string {
  const body = response.body;
  if (response.error) return response.error;
  if (typeof body === 'string') return body.slice(0, 200);
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message: unknown }).message;
    if (Array.isArray(message)) return message.map(String).join('; ');
    if (typeof message === 'string') return message;
  }
  return '';
}

export function fieldOf(response: ApiResponse, name: string): unknown {
  const body = response.body;
  if (typeof body === 'object' && body !== null && name in body) {
    return (body as Record<string, unknown>)[name];
  }
  return undefined;
}

export type Classifier = (
  response: ApiResponse,
) => Omit<RequestRecord, 'ms' | 'status'>;

export interface PlannedRequest {
  send: () => Promise<ApiResponse>;
  classify: Classifier;
}

export interface BurstResult {
  burst: Burst;
  responses: ApiResponse[];
}

/** Turns an answer into a record: a throttled answer is never a pass. */
export function recordOf(
  response: ApiResponse,
  classify: Classifier,
): RequestRecord {
  if (response.status === 429) {
    return { kind: 'throttled', status: 429, ms: response.ms, tag: '429' };
  }
  const classified = classify(response);
  const note =
    classified.kind === 'unexpected'
      ? (classified.note ??
        `${response.status || 'no response'} ${messageOf(response)}`.trim())
      : classified.note;
  return { ...classified, status: response.status, ms: response.ms, note };
}

/**
 * Sends every request at the same moment: all of them wait on one gate, which
 * opens once. The wall time runs from opening the gate to the last answer.
 */
export async function runBurst(
  label: string,
  requests: readonly PlannedRequest[],
): Promise<BurstResult> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const pending = requests.map((request) => gate.then(() => request.send()));
  const startedAt = performance.now();
  open();
  const responses = await Promise.all(pending);
  const wallMs = performance.now() - startedAt;
  return {
    burst: {
      label,
      wallMs,
      records: responses.map((response, index) =>
        recordOf(response, requests[index].classify),
      ),
    },
    responses,
  };
}

/** Opens `count` keep-alive connections at once so the burst is not slowed by connecting. */
export async function warmUpConnections(
  api: Api,
  count: number,
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, () => api.request('GET', '/health')),
  );
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-place Fisher-Yates shuffle, so no request type is always sent first. */
export function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}
