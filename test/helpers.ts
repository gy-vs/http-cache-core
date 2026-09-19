import { HeadersLite } from '../src/headers.js';
import type { HeaderInput } from '../src/headers.js';
import type { NormalizeRequestInput, NormalizeResponseInput } from '../src/types.js';

export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

export function req(
  target: string,
  headers?: HeaderInput,
  method = 'GET',
): NormalizeRequestInput {
  return { target, method, headers: headers ? new HeadersLite(headers) : undefined };
}

export function res(
  status: number,
  headers?: HeaderInput,
  body?: unknown,
): NormalizeResponseInput {
  return { status, headers: headers ? new HeadersLite(headers) : undefined, body };
}

export function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

/** 固定 tick 的假时钟，测试时间分支用。 */
export function fakeClock(start: number): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

/** 立即 resolve 的 deferred，测试里用它手动控制回调完成时机。 */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
