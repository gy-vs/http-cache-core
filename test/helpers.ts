import type { Clock, HeadersLike, RequestLike, ResponseLike, TransactionTimes } from '../src/types.js';

/** 可手动推进的假时钟。 */
export class FakeClock {
  private current: number;
  constructor(startMs = Date.parse('Mon, 01 Jan 2024 00:00:00 GMT')) {
    this.current = startMs;
  }
  readonly now: Clock = () => this.current;
  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
  get value(): number {
    return this.current;
  }
}

export function req(
  url: string,
  headers: HeadersLike = {},
  method = 'GET',
): RequestLike {
  return { url, method, headers };
}

export function res(
  status: number,
  headers: HeadersLike = {},
  body?: unknown,
): ResponseLike {
  return body === undefined ? { status, headers } : { status, headers, body };
}

/** 以假时钟当前时刻构造一次“耗时 roundTripMs”的事务。 */
export function tx(clock: FakeClock, roundTripMs = 0): TransactionTimes {
  const responseTimeMs = clock.value;
  return { requestTimeMs: responseTimeMs - roundTripMs, responseTimeMs };
}

/** IMF-fixdate 助手：t 为相对 epoch 的毫秒时间戳。 */
export function httpDate(t: number): string {
  return new Date(t).toUTCString();
}

/** 等待微任务队列排空（让后台 async 回调落定）。 */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
