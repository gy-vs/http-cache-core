/**
 * 条件请求构造与 304 合并（RFC 9111 4.3）。
 */

import { HeadersLite } from './headers.js';
import type { CacheResponse } from './types.js';
import {
  computeAgeState,
  currentAge,
  type AgeState,
  type StoredVariant,
} from './policy.js';
import { nonNegativeDiff } from './time.js';

/**
 * 生成条件请求头：
 * - 有 ETag -> If-None-Match
 * - （也有 Last-Modified -> 再带 If-Modified-Since）
 * - 只有 Last-Modified -> 仅 If-Modified-Since
 *
 * 两个校验器都存在时同时发送（4.3.1 允许，接收方必须都满足）。
 */
export function conditionalHeaders(variant: StoredVariant): HeadersLite {
  const h = new HeadersLite();
  const etag = variant.response.headers.get('etag');
  const lastModified = variant.response.headers.get('last-modified');
  if (etag !== null) h.set('if-none-match', etag);
  if (lastModified !== null) h.set('if-modified-since', lastModified);
  return h;
}

/** 已存表示是否还有可用校验器，决定再验证是条件请求还是只能整取。 */
export function hasValidator(variant: StoredVariant): boolean {
  return (
    variant.response.headers.has('etag') ||
    variant.response.headers.has('last-modified')
  );
}

/**
 * 把 304 Not Modified 的响应头合并进已存表示（4.3.4）：
 *
 * - 304 里出现的每个头「替换」已存响应里的同名头（不是只补空缺）；
 * - 304 没带的头保持原值；
 * - 状态码保持原响应的，响应体绝不改动；
 * - 合并后按 4.3.4 重新计算校正年龄（新 Age 头、本次往返延迟都计入）。
 *
 * 返回一份全新的 variant，原对象不被修改。
 */
export interface Merge304Input {
  variant: StoredVariant;
  notModified: CacheResponse;
  /** 本次条件请求发出时刻（本地 ms） */
  requestTime: number;
  /** 304 完整收到时刻（本地 ms） */
  responseTime: number;
  now: number;
}

/** 304 允许更新的端到端头之外，hop-by-hop / 路由相关头不在合并范围（4.3.4）。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function merge304(input: Merge304Input): StoredVariant {
  const { variant, notModified, requestTime, responseTime, now } = input;

  // Connection 头里逐字段列出的 hop-by-hop 字段名也要排除。
  const connectionListed = new Set<string>();
  for (const raw of notModified.headers.getSet('connection')) {
    for (const part of raw.split(',')) {
      const name = part.trim().toLowerCase();
      if (name) connectionListed.add(name);
    }
  }

  const mergedHeaders = variant.response.headers.clone();
  for (const [name, values] of notModified.headers.entries()) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || connectionListed.has(key)) continue;
    mergedHeaders.set(name, values);
  }

  const mergedResponse: CacheResponse = {
    status: variant.response.status,
    headers: mergedHeaders,
    body: variant.response.body, // 4.3.4：body 不动
  };

  // 用合并后的响应头重新算「新响应角度」的初始年龄。
  const freshState: AgeState = computeAgeAfter304({
    variant,
    mergedResponse,
    requestTime,
    responseTime,
    now,
  });

  return {
    ...variant,
    response: mergedResponse,
    ageInitial: freshState.initialAge,
    ageBaseTime: freshState.ageBaseTime,
  };
}

interface ComputeAge304Input {
  variant: StoredVariant;
  mergedResponse: CacheResponse;
  requestTime: number;
  responseTime: number;
  now: number;
}

/**
 * 4.3.4 的年龄更新：
 *   new_age = 新 304 算出的 corrected_initial_age
 *   还要与「已存表示按 responseTime 算出的当前年龄」取最大值，
 *   保证再验证不会让年龄倒退。
 */
export function computeAgeAfter304(input: ComputeAge304Input): AgeState {
  const { variant, mergedResponse, requestTime, responseTime, now } = input;

  const recomputed = recomputeInitialAge(mergedResponse, requestTime, responseTime);
  // 已存副本的当前年龄是按 now 算的；折算回 responseTime 基准，
  // 只扣掉本次请求完成后到调用方合并之间的本地处理时间。
  const storedAgeAtResponse =
    currentAge(variant.ageInitial, variant.ageBaseTime, now) -
    nonNegativeDiff(now, responseTime);

  const initialAge = Math.max(recomputed.initialAge, Math.max(0, storedAgeAtResponse));
  return { initialAge, ageBaseTime: responseTime, dateValue: recomputed.dateValue };
}

function recomputeInitialAge(
  response: CacheResponse,
  requestTime: number,
  responseTime: number,
): AgeState {
  return computeAgeState(response, { requestTime, responseTime });
}
