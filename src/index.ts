/**
 * HTTP 缓存语义内核（RFC 9111）。
 *
 * 纯判定逻辑：不发请求、不起服务、不落盘、无命令行入口。
 * 网络由调用方通过回调接入，存储默认使用内存 LRU（可替换）。
 *
 * 主要入口：
 * - {@link ResponsePolicy}：单条响应的存储决策、年龄/新鲜期、命中判定；
 * - {@link decideStorage}：无状态的一次性存储决策便捷函数；
 * - {@link Cache}：带 Vary 选择、304 合并、SWR 后台去重的缓存编排器；
 * - {@link conditionalHeaders} / {@link mergeNotModified}：再验证原语；
 * - {@link MemoryStore} / {@link CacheStore}：内存 LRU 与存储接口；
 * - {@link HeaderBag} / {@link parseVary}：头字段与 Vary 工具。
 */

export {
  DEFAULT_CACHEABLE_STATUSES,
  ResponsePolicy,
  decideStorage,
  type PolicyInput,
} from './policy.js';
export { HeaderBag, parseVary, varyMatches, variantId } from './headers.js';
export { parseCacheControl, cacheControlOf, parseAge, type CacheControl } from './directives.js';
export { parseHttpDate, elapsedSeconds } from './time.js';
export {
  conditionalHeaders,
  mergeNotModified,
} from './revalidate.js';
export {
  Cache,
  type CacheOptions,
  type HandleResult,
  type MatchResult,
  type PutInput,
  type RevalidateFn,
  type RevalidationResponse,
  type RevalidateOutcome,
} from './cache.js';
export {
  MemoryStore,
  primaryKey,
  type CacheStore,
  type CacheKey,
  type MemoryStoreOptions,
} from './store.js';
export type {
  CacheEntry,
  CacheMode,
  Clock,
  HeadersLike,
  NonStorableReason,
  PolicyOptions,
  RequestLike,
  ResponseLike,
  ServeDecision,
  ServeState,
  RevalidateReason,
  StoredRequest,
  StoredResponse,
  StorageDecision,
  TransactionTimes,
} from './types.js';
