import { HeaderBag, parseVary } from './headers.js';
import { ResponsePolicy } from './policy.js';
import type {
  CacheEntry,
  PolicyOptions,
  RequestLike,
  StoredRequest,
  StoredResponse,
  TransactionTimes,
} from './types.js';

/**
 * 根据已存响应生成条件请求需要携带的验证头（RFC 9111 §13 / RFC 9110）。
 *
 * - 有 ETag：If-None-Match（弱标记 W/ 原样保留）；
 * - 只有 Last-Modified：If-Modified-Since；
 * - 两个都有：两个都带。
 *
 * 注意 If-Modified-Since 只能用源站给的 Last-Modified 值原样回传，
 * 这里不做任何重格式化。
 */
export function conditionalHeaders(entry: CacheEntry): [string, string][] {
  const headers = HeaderBag.from(entry.response.headers);
  const out: [string, string][] = [];
  const etag = headers.get('etag');
  if (etag !== null) out.push(['if-none-match', etag]);
  const lastModified = headers.get('last-modified');
  if (lastModified !== null) out.push(['if-modified-since', lastModified]);
  return out;
}

/**
 * 合并 304 Not Modified 的响应头到已存响应（RFC 9111 §3.2）。
 *
 * 规则：
 * - 304 里出现的头字段整体替换已存响应里的同名字段（是替换，不是追加）；
 * - 304 没带的字段保留原值；
 * - Content-Length 必须删除（表示主体沿用旧值，长度声明不得被改写）；
 * - 响应状态码与响应体完全不动；
 * - Age 头只采用 304 显式给出的值：304 没带 Age 时，驻留时间通过
 *   新事务时刻（304 收到时间）与 §4.2.3 的请求往返校正自然累计，
 *   不把旧 Age 数值再搬一遍（否则会被计算两次）；
 * - 合并后用新的事务时刻（条件请求发出 / 304 收到）重新走一遍存储
 *   决策与新鲜度计算。
 *
 * 合并后若响应变得不可存储（例如新来的 no-store），返回 null，
 * 调用方应当把旧条目删掉。
 */
export function mergeNotModified(
  entry: CacheEntry,
  notModified: { headers: StoredResponse['headers'] },
  times: TransactionTimes,
  newRequest: Pick<RequestLike, 'headers'>,
  options: PolicyOptions = {},
): CacheEntry | null {
  const storedBag = HeaderBag.from(entry.response.headers);
  const freshBag = HeaderBag.from(notModified.headers);

  // 304 中实际出现的字段名（去重、小写）。
  const replacedNames = new Set<string>();
  for (const [name] of freshBag) replacedNames.add(name);

  // 304 不得参与合并、必须忽略/删除的字段。
  replacedNames.delete('content-length');
  const removed = new Set<string>(['content-length']);

  const merged: [string, string][] = [];
  for (const [name, value] of storedBag) {
    if (removed.has(name)) continue;
    if (replacedNames.has(name)) continue; // 旧值被 304 整体替换
    merged.push([name, value]);
  }
  for (const [name, value] of freshBag) {
    if (removed.has(name)) continue;
    merged.push([name, value]);
  }

  // 刷新请求快照：只保留 Vary 选择头（RFC 9111 §4.3.4：选择头集合不能
  // 被 304 改变，因此以已存响应的 Vary 为准，忽略 304 里的 Vary）。
  // 新请求没带某个选择头时沿用旧快照值，避免把 Authorization 之类的
  // 无关请求头写进条目。
  const storedVary = parseVary(storedBag);
  const newRequestBag = HeaderBag.from(newRequest.headers);
  const oldRequestBag = HeaderBag.from(entry.request.headers);
  const mergedRequestHeaders: [string, string][] = [];
  if (!storedVary.wildcard) {
    for (const name of storedVary.names) {
      const values = newRequestBag.valuesOf(name);
      const source = values.length > 0 ? values : oldRequestBag.valuesOf(name);
      for (const value of source) mergedRequestHeaders.push([name, value]);
    }
  }
  const mergedRequest: StoredRequest = {
    method: entry.request.method,
    url: entry.request.url,
    headers: mergedRequestHeaders,
  };

  const mergedResponse: StoredResponse = {
    status: entry.response.status,
    headers: merged,
    body: entry.response.body,
  };

  const policy = new ResponsePolicy(
    { method: entry.request.method, headers: mergedRequestHeaders },
    { status: mergedResponse.status, headers: merged },
    times,
    options,
  );
  const decision = policy.canStore();
  if (!decision.storable) return null;

  return {
    request: mergedRequest,
    response: mergedResponse,
    requestSentMs: times.requestTimeMs,
    responseReceivedMs: times.responseTimeMs,
    storedAtMs: options.now ? options.now() : Date.now(),
    freshnessLifetimeSec: decision.freshnessLifetimeSec,
    staleWhileRevalidateSec: decision.staleWhileRevalidateSec,
    mustRevalidateBeforeUse: decision.mustRevalidateBeforeUse,
  };
}
