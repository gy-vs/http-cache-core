/**
 * RFC 9111 缓存策略内核（纯函数，无 IO、无存储）。
 *
 * 覆盖：
 * - 第 3 节  存储决策（可存储性、no-store、私有/共享差异、Authorization、状态码）
 * - 第 4 节  新鲜度：4.2.1 新鲜期优先级、4.2.2 启发式、4.2.3 年龄（含时钟偏差修正）
 * - 第 4.1 节 Vary 选择（解析在 vary.ts）
 * - 第 5 节  请求指令对命中的影响（no-cache / max-age / min-fresh / max-stale /
 *            only-if-cached）
 * - 第 4.3 节 304 合并后的年龄更新
 *
 * 本文件所有时间均为毫秒。
 */

import { HeadersLite } from './headers.js';
import {
  parseCacheControl,
  parseHttpDate,
  parseDeltaSeconds,
  secondsToMs,
  nonNegativeDiff,
  type CacheControl,
} from './time.js';
import {
  type CacheRequest,
  type CacheResponse,
  type RequestTiming,
} from './types.js';
import { parseVary, selectorKey, type VarySpec } from './vary.js';
export type CacheMode = 'shared' | 'private';

/* ------------------------------------------------------------------ */
/* 默认可缓存方法 / 状态码（RFC 9111 3.3 / 3.5）                       */
/* ------------------------------------------------------------------ */

/** 默认可缓存的方法：安全方法中的 GET/HEAD（RFC 9111 3.3）。 */
export const DEFAULT_CACHEABLE_METHODS: readonly string[] = ['GET', 'HEAD'];

/** 默认可缓存的状态码（RFC 9111 3.5）。 */
export const DEFAULT_CACHEABLE_STATUSES: readonly number[] = [
  200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501,
];

export interface HeuristicOptions {
  /** Last-Modified 与 Date 间隔的取值比例，默认 10%。 */
  ratio?: number;
  /** 启发式新鲜期上限（毫秒），默认 24 小时。 */
  maxLifetimeMs?: number;
  /** 启发式新鲜期下限（毫秒），默认 0。 */
  minLifetimeMs?: number;
}

export interface PolicyOptions {
  /** 共享缓存（默认）还是私有缓存。影响 s-maxage、private、Authorization 等判定。 */
  mode?: CacheMode;
  heuristic?: HeuristicOptions;
  /** 覆盖默认可缓存方法（大写）。 */
  cacheableMethods?: readonly string[];
  /** 覆盖默认可缓存状态码。 */
  cacheableStatuses?: readonly number[];
  /**
   * 视为「允许缓存」的 Cache-Control 扩展 token（RFC 9111 3.5）。
   * 默认不认识任何扩展。
   */
  cacheableExtensionTokens?: readonly string[];
}

export interface ResolvedPolicyOptions {
  mode: CacheMode;
  heuristicRatio: number;
  heuristicMaxMs: number;
  heuristicMinMs: number;
  cacheableMethods: ReadonlySet<string>;
  cacheableStatuses: ReadonlySet<number>;
  cacheableExtensionTokens: ReadonlySet<string>;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function resolveOptions(options: PolicyOptions = {}): ResolvedPolicyOptions {
  const ratio = options.heuristic?.ratio ?? 0.1;
  if (!(ratio >= 0 && ratio <= 1)) {
    throw new RangeError('heuristic.ratio 必须在 [0, 1] 之间');
  }
  const methods = options.cacheableMethods ?? DEFAULT_CACHEABLE_METHODS;
  const statuses = options.cacheableStatuses ?? DEFAULT_CACHEABLE_STATUSES;
  const extensions = options.cacheableExtensionTokens ?? [];
  return {
    mode: options.mode ?? 'shared',
    heuristicRatio: ratio,
    heuristicMaxMs: options.heuristic?.maxLifetimeMs ?? ONE_DAY_MS,
    heuristicMinMs: options.heuristic?.minLifetimeMs ?? 0,
    cacheableMethods: new Set(methods.map((m) => m.toUpperCase())),
    cacheableStatuses: new Set(statuses),
    cacheableExtensionTokens: new Set(extensions),
  };
}

export function responseCacheControl(response: CacheResponse): CacheControl {
  return parseCacheControl(response.headers.get('cache-control'));
}

/* ------------------------------------------------------------------ */
/* 存储决策（第 3 节）                                                  */
/* ------------------------------------------------------------------ */

export interface StorageInput {
  request: CacheRequest;
  response: CacheResponse;
  /** 请求发出时刻（本地毫秒时间戳） */
  requestTime: number;
  /** 响应完整收到时刻（本地毫秒时间戳） */
  responseTime: number;
}

/** 存储被拒绝/接受的原因码，方便调用方打日志与写测试。 */
export type StorageReason =
  | 'cacheable-default'
  | 'cacheable-explicit-expiration'
  | 'cacheable-extension'
  | 'no-store-response'
  | 'no-store-request'
  | 'private-response-in-shared-cache'
  | 'method-not-cacheable'
  | 'status-not-cacheable'
  | 'non-safe-method-requires-explicit-expiration'
  | 'authorization-requires-directive';

export interface StorageDecision {
  storable: boolean;
  reason: StorageReason;
  /**
   * 以 responseTime 为起点的建议新鲜时长（毫秒）。
   * 即使为 0（存进去立即过期）也可能是合法的：no-cache、heuristic=0、
   * Expires==Date 的响应仍然允许存，用于再验证。
   */
  freshForMs: number;
  /** stale-while-revalidate 窗口（毫秒），没有则 0。 */
  staleWhileRevalidateMs: number;
  /** 是否带显式过期信息（max-age / s-maxage / 合法 Expires）。 */
  explicitExpiration: boolean;
}

/** 响应是否带显式过期信息（RFC 9111 4.2.2）。私有缓存不看 s-maxage。 */
export function hasExplicitExpiration(
  mode: CacheMode,
  cc: CacheControl,
  expiresValue: number | null,
): boolean {
  if (mode === 'shared' && cc.sMaxage !== null) return true;
  if (cc.maxAge !== null) return true;
  if (expiresValue !== null) return true;
  return false;
}

export function decideStorage(
  input: StorageInput,
  options: PolicyOptions | ResolvedPolicyOptions = {},
): StorageDecision {
  const opts =
    'heuristicRatio' in options
      ? (options as ResolvedPolicyOptions)
      : resolveOptions(options);
  const { request, response, responseTime } = input;
  const reqCc = parseCacheControl(request.headers.get('cache-control'));
  const resCc = responseCacheControl(response);
  const expiresValue = parseHttpDate(response.headers.get('expires') ?? '');

  const explicit = hasExplicitExpiration(opts.mode, resCc, expiresValue);
  const lifetime = freshnessLifetime(response, opts, responseTime);
  const swrMs =
    resCc.staleWhileRevalidate !== null
      ? secondsToMs(resCc.staleWhileRevalidate)
      : 0;

  const allow = (reason: StorageReason): StorageDecision => ({
    storable: true,
    reason,
    freshForMs: lifetime.lifetimeMs,
    staleWhileRevalidateMs: swrMs,
    explicitExpiration: explicit,
  });
  const deny = (reason: StorageReason): StorageDecision => ({
    storable: false,
    reason,
    freshForMs: 0,
    staleWhileRevalidateMs: 0,
    explicitExpiration: explicit,
  });

  // 3.2 no-store：响应头的 no-store 对所有缓存生效。
  if (resCc.noStore) return deny('no-store-response');

  // 3.2 请求头的 no-store：对该请求的任何响应都不得存储（私有/共享均适用）。
  if (reqCc.noStore) return deny('no-store-request');

  // 3.2 private：共享缓存不得存储。
  if (opts.mode === 'shared' && resCc.private) {
    return deny('private-response-in-shared-cache');
  }

  // 3.2 Authorization：共享缓存默认不能存，除非响应显式放行。
  if (
    opts.mode === 'shared' &&
    request.headers.has('authorization') &&
    !(resCc.mustRevalidate || resCc.public || resCc.sMaxage !== null)
  ) {
    return deny('authorization-requires-directive');
  }

  const methodOk = opts.cacheableMethods.has(request.method);
  const statusOk = opts.cacheableStatuses.has(response.status);
  const hasExtension = resCc.unknownTokens.some((t) =>
    opts.cacheableExtensionTokens.has(t),
  );

  if (!methodOk) {
    // 3.4 对非安全（或未列入）方法的响应：
    // 仅当带显式过期、且状态码本身默认可缓存（或扩展放行）时才允许存。
    if (explicit && (statusOk || hasExtension)) {
      return allow('cacheable-explicit-expiration');
    }
    return deny(
      statusOk
        ? 'non-safe-method-requires-explicit-expiration'
        : 'method-not-cacheable',
    );
  }

  if (statusOk) return allow('cacheable-default');
  // 3.5 默认不可缓存的状态码：显式过期或缓存扩展允许时可存。
  if (explicit) return allow('cacheable-explicit-expiration');
  if (hasExtension) return allow('cacheable-extension');
  return deny('status-not-cacheable');
}

/* ------------------------------------------------------------------ */
/* 年龄（4.2.3）——时钟偏差修正就在这里                                  */
/* ------------------------------------------------------------------ */

/**
 * 计算并保存「校正后初始年龄」。
 *
 * apparent_age   = max(0, responseTime - date_value)
 *   上游时钟偏快（Date 是未来时间）时被钳到 0，不会出现负年龄；
 * age_value      = 上游在 Age 头里自己声明的年龄，参与取最大值，
 *   所以时钟偏快也不会让年龄偏小；
 * response_delay = responseTime - requestTime，本地往返耗时，必加。
 *
 * Date 头缺失时按 RFC 用 responseTime 兜底。
 */
export interface AgeState {
  /**
   * 校正后初始年龄（ms），定义在「响应完整收到」这个时间点上
   * （RFC 9111 4.2.3：max(apparent_age, age_value) + response_delay）。
   */
  initialAge: number;
  /**
   * initialAge 的计时基准（本地 ms 时间戳）= responseTime。
   * 之后 resident_time 从这里按 now - responseTime 推进；
   * response_delay 已包含在 initialAge 里，不能再计入 resident_time，
   * 否则往返耗时会被算两遍。
   */
  ageBaseTime: number;
  dateValue: number | null;
}

export function computeAgeState(
  response: CacheResponse,
  timing: RequestTiming,
): AgeState {
  const dateValue = parseHttpDate(response.headers.get('date') ?? '');
  const dateOrNow = dateValue ?? timing.responseTime;

  const ageHeaderRaw = parseDeltaSeconds(
    (response.headers.get('age') ?? '').trim() || undefined,
  );

  const apparentAge = nonNegativeDiff(timing.responseTime, dateOrNow);
  const responseDelay = nonNegativeDiff(timing.responseTime, timing.requestTime);

  // RFC 9111 4.2.3 的两个年龄候选（都定义在「响应收到」时刻）：
  //   - apparent_age：本地观测，now_local - Date；时钟同步时它天然包含
  //     请求发出到响应收到的传输时间，不能再叠加 response_delay；
  //   - age_value + response_delay：信任上游 Age 头，同时补上本地这段往返。
  // 取二者最大值，既不会让时钟偏快的响应年龄变小/变负，也不会重复计算 RTT。
  const ageValueMs = ageHeaderRaw !== null ? secondsToMs(ageHeaderRaw) : 0;
  const initialAge = Math.max(apparentAge, ageValueMs + responseDelay);
  return { initialAge, ageBaseTime: timing.responseTime, dateValue };
}

/** 当前年龄（ms），永远不为负。 */
export function currentAge(
  initialAge: number,
  ageBaseTime: number,
  now: number,
): number {
  return initialAge + nonNegativeDiff(now, ageBaseTime);
}

/* ------------------------------------------------------------------ */
/* 新鲜期（4.2.1 / 4.2.2）                                              */
/* ------------------------------------------------------------------ */

export type FreshnessSource =
  | 's-maxage'
  | 'max-age'
  | 'expires'
  | 'heuristic'
  | 'none';

export interface FreshnessLifetime {
  lifetimeMs: number;
  source: FreshnessSource;
  explicit: boolean;
}

/**
 * 新鲜期优先级：
 * 共享缓存 s-maxage > max-age > Expires-Date（相对响应自己的 Date 做差，
 * 不碰本地当前时间，避免上游时钟偏差直接打穿命中率）> 启发式。
 * Expires 无法解析时视为该字段不存在（4.2.1）。
 */
export function freshnessLifetime(
  response: CacheResponse,
  options: PolicyOptions | ResolvedPolicyOptions = {},
  responseTime?: number,
): FreshnessLifetime {
  const opts =
    'heuristicRatio' in options
      ? (options as ResolvedPolicyOptions)
      : resolveOptions(options);
  const cc = responseCacheControl(response);

  if (opts.mode === 'shared' && cc.sMaxage !== null) {
    return { lifetimeMs: secondsToMs(cc.sMaxage), source: 's-maxage', explicit: true };
  }
  if (cc.maxAge !== null) {
    return { lifetimeMs: secondsToMs(cc.maxAge), source: 'max-age', explicit: true };
  }

  const expiresValue = parseHttpDate(response.headers.get('expires') ?? '');
  if (expiresValue !== null) {
    const dateValue = parseHttpDate(response.headers.get('date') ?? '');
    if (dateValue !== null) {
      // 关键：和响应自己的 Date 做差，而不是和本地 now 比。
      // 差值钳到 0，过期时间早于 Date 时新鲜期为 0（仍可存储/再验证）。
      return {
        lifetimeMs: nonNegativeDiff(expiresValue, dateValue),
        source: 'expires',
        explicit: true,
      };
    }
    // 有 Expires 但没有可用 Date：退化为相对 responseTime（通常 Date 总存在）。
    const base = responseTime ?? Date.now();
    return {
      lifetimeMs: nonNegativeDiff(expiresValue, base),
      source: 'expires',
      explicit: true,
    };
  }

  const heuristic = heuristicLifetime(response, opts);
  return {
    lifetimeMs: heuristic,
    source: heuristic > 0 ? 'heuristic' : 'none',
    explicit: false,
  };
}

/**
 * 启发式新鲜期（4.2.2）：
 * 有 Last-Modified 与 Date 时取间隔的 ratio 比例，再用上下限钳制；
 * 两者缺失或间隔为 0 时返回 minLifetime（默认 0，即立即过期）。
 */
export function heuristicLifetime(
  response: CacheResponse,
  options: PolicyOptions | ResolvedPolicyOptions = {},
): number {
  const opts =
    'heuristicRatio' in options
      ? (options as ResolvedPolicyOptions)
      : resolveOptions(options);
  const dateValue = parseHttpDate(response.headers.get('date') ?? '');
  const lastModified = parseHttpDate(response.headers.get('last-modified') ?? '');
  if (dateValue === null || lastModified === null) return opts.heuristicMinMs;
  const interval = nonNegativeDiff(dateValue, lastModified);
  if (interval === 0) return opts.heuristicMinMs;
  const scaled = interval * opts.heuristicRatio;
  return Math.min(opts.heuristicMaxMs, Math.max(opts.heuristicMinMs, scaled));
}

/** stale-while-revalidate 窗口（ms），没有返回 0。 */
export function staleWhileRevalidateWindowMs(response: CacheResponse): number {
  const cc = responseCacheControl(response);
  return cc.staleWhileRevalidate !== null
    ? secondsToMs(cc.staleWhileRevalidate)
    : 0;
}

/* ------------------------------------------------------------------ */
/* 已存表示（variant）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 同一个目标下、Vary 不同的每一份响应各自存一条 variant。
 */
export interface StoredVariant {
  /** 缓存键：方法与目标（原样保留，再验证时重建请求要用） */
  method: string;
  target: string;
  /** 由 Vary 字段值生成的选择器键，空串表示响应不带 Vary。 */
  selector: string;
  vary: VarySpec;
  response: CacheResponse;
  /** 校正后初始年龄（4.2.3） */
  ageInitial: number;
  ageBaseTime: number;
  /** 存响应时的请求头（再验证时需要原样带回，例如 Authorization） */
  requestHeaders: HeadersLite;
  /** 存响应时记录的请求发出时刻（304 再验证复用同一条链路语义） */
  requestTime: number;
}

/** 通过存储决策后，用这个函数构造要落进存储的 variant。 */
export function createVariant(input: StorageInput): StoredVariant {
  const vary = parseVary(input.response.headers);
  const age = computeAgeState(input.response, {
    requestTime: input.requestTime,
    responseTime: input.responseTime,
  });
  return {
    method: input.request.method,
    target: input.request.target,
    selector: selectorKey(vary.fields, input.request.headers),
    vary,
    response: {
      status: input.response.status,
      headers: input.response.headers.clone(),
      body: input.response.body,
    },
    ageInitial: age.initialAge,
    ageBaseTime: age.ageBaseTime,
    // 注意：这里存的是「触发这次响应的请求」自己的头。
    // 调用方若把响应头误塞进 request.headers（例如 Cache-Control: max-age=60），
    // 请求指令解析会把它当成请求侧 max-age。为防止这种常见误用，
    // 再验证时实际需要的请求头建议由调用方显式管理。
    requestHeaders: input.request.headers.clone(),
    requestTime: input.requestTime,
  };
}

/* ------------------------------------------------------------------ */
/* 请求侧指令（5.2.1）                                                  */
/* ------------------------------------------------------------------ */

export interface RequestDirectives {
  noCache: boolean;
  noStore: boolean;
  noTransform: boolean;
  /** max-age（秒），未带为 null */
  maxAge: number | null;
  minFresh: number | null;
  maxStale: number | null;
  /** 裸 max-stale：愿意接受任意年龄的过期响应 */
  maxStaleInfinite: boolean;
  onlyIfCached: boolean;
}

/**
 * 解析请求侧缓存指令。同时兼容 HTTP/1.0 的 Pragma: no-cache
 * （仅当请求没有 Cache-Control 时生效，RFC 9111 对 Pragma 的兼容建议）。
 */
export function parseRequestDirectives(headers: HeadersLite): RequestDirectives {
  const ccRaw = headers.get('cache-control');
  const cc = parseCacheControl(ccRaw);
  const pragmaNoCache = /(?:^|,\s*)no-cache(?:\s*,|$)/.test(
    headers.get('pragma') ?? '',
  );
  return {
    noCache: cc.noCache || (ccRaw === null && pragmaNoCache),
    noStore: cc.noStore,
    noTransform: cc.noTransform,
    maxAge: cc.maxAge,
    minFresh: cc.minFresh,
    maxStale: cc.maxStale,
    maxStaleInfinite: cc.maxStaleInfinite,
    onlyIfCached: cc.onlyIfCached,
  };
}

/* ------------------------------------------------------------------ */
/* 命中判定 / 新鲜度评估                                                 */
/* ------------------------------------------------------------------ */

export type CacheUseStatus =
  /** 新鲜，可直接返回 */
  | 'fresh'
  /** 过期但调用方可直接返回（max-stale 或 SWR 窗口内） */
  | 'stale-serve'
  /** 过期且必须先同步再验证（条件请求） */
  | 'stale-revalidate'
  /** 请求的 max-age/min-fresh 不接受这份副本，需向前转发 */
  | 'unusable'
  /** only-if-cached 且没有可服务副本，调用方应回 504 */
  | 'gateway-timeout';

export interface Evaluation {
  status: CacheUseStatus;
  /** 当前年龄 ms */
  age: number;
  /** 新鲜期 ms */
  lifetimeMs: number;
  /** lifetime - age；正数=还新鲜，负数=过期多久 */
  freshnessMs: number;
  /** 已过期 ms（新鲜时 0） */
  staleMs: number;
  /** 变新鲜截止的绝对时间戳 */
  freshUntil: number;
  /** SWR 窗口截止时间戳，无窗口为 null */
  swrUntil: number | null;
  /** 是否必须带条件请求头再验证后才能用 */
  revalidate: boolean;
  /** 是否可先返回过期副本、再验证放后台 */
  backgroundRevalidate: boolean;
  /** 是否可以立刻把这份副本返回调用方 */
  serve: boolean;
  /** only-if-cached 且无可用副本 -> 504 */
  gatewayTimeout: boolean;
  reasons: string[];
}

export interface EvaluateInput {
  variant: StoredVariant;
  request: CacheRequest;
  now: number;
  policy?: PolicyOptions | ResolvedPolicyOptions;
}

export function evaluate(input: EvaluateInput): Evaluation {
  const opts =
    input.policy === undefined
      ? resolveOptions()
      : 'heuristicRatio' in input.policy
        ? (input.policy as ResolvedPolicyOptions)
        : resolveOptions(input.policy);

  const { variant, now } = input;
  const req = parseRequestDirectives(input.request.headers);
  const resCc = responseCacheControl(variant.response);

  const age = currentAge(variant.ageInitial, variant.ageBaseTime, now);
  const lifetime = freshnessLifetime(variant.response, opts, variant.ageBaseTime);
  const swrMs = staleWhileRevalidateWindowMs(variant.response);

  const freshUntil = variant.ageBaseTime + variant.ageInitial + lifetime.lifetimeMs;
  const swrUntil = swrMs > 0 ? freshUntil + swrMs : null;
  const freshnessMs = lifetime.lifetimeMs - age;
  const staleMs = Math.max(0, -freshnessMs);
  const isStale = staleMs > 0;

  const reasons: string[] = [];

  // must-revalidate：一旦过期就不得放行，max-stale 也无效（4.2.4）。
  // proxy-revalidate 只对共享缓存有同样约束。
  const revalidationForcedByResponse =
    resCc.mustRevalidate || (opts.mode === 'shared' && resCc.proxyRevalidate);

  // 请求方对「可接受年龄」的硬约束（5.2.1.1/5.2.1.3）。
  const ageLimitMs = req.maxAge !== null ? secondsToMs(req.maxAge) : null;
  const ageTooLarge = ageLimitMs !== null && age > ageLimitMs;
  const minFreshMs = req.minFresh !== null ? secondsToMs(req.minFresh) : null;
  // 没带 min-fresh 时不施加余量约束；带了 min-fresh=0 时仍要求响应未过期。
  const notFreshEnough = minFreshMs !== null && freshnessMs < minFreshMs;
  const clientRejects = ageTooLarge || notFreshEnough;
  if (ageTooLarge) reasons.push('request-max-age');
  if (notFreshEnough) reasons.push('request-min-fresh');

  // 客户端/服务器要求「不缓存直接再验证」。
  const endToEndReload = req.noCache;
  const serverNoCache = resCc.noCache;
  const mustRevalidateNow =
    endToEndReload || serverNoCache || (isStale && revalidationForcedByResponse);
  if (endToEndReload) reasons.push('request-no-cache');
  if (serverNoCache) reasons.push('response-no-cache');
  if (isStale && revalidationForcedByResponse) {
    reasons.push(resCc.mustRevalidate ? 'must-revalidate' : 'proxy-revalidate');
  }

  // 客户端允许的过期容忍度（max-stale）。
  const maxStaleAllowedMs = req.maxStaleInfinite
    ? Number.POSITIVE_INFINITY
    : req.maxStale !== null
      ? secondsToMs(req.maxStale)
      : null;
  const withinMaxStale =
    isStale &&
    !revalidationForcedByResponse &&
    maxStaleAllowedMs !== null &&
    staleMs <= maxStaleAllowedMs;
  if (withinMaxStale) reasons.push('max-stale');

  // SWR 窗口（RFC 5861）：请求带 no-cache 时不得走捷径。
  const withinSWR =
    isStale &&
    !endToEndReload &&
    !revalidationForcedByResponse &&
    swrUntil !== null &&
    now <= swrUntil;
  if (withinSWR) reasons.push('stale-while-revalidate');

  // only-if-cached：拿不到现成可用副本就必须 504，绝不发请求。
  // 在任何判定前先准备这个短路结果。
  const timeout = (extra: string[]): Evaluation => ({
    status: 'gateway-timeout',
    age,
    lifetimeMs: lifetime.lifetimeMs,
    freshnessMs,
    staleMs,
    freshUntil,
    swrUntil,
    revalidate: false,
    backgroundRevalidate: false,
    serve: false,
    gatewayTimeout: true,
    reasons: [...reasons, ...extra, 'only-if-cached'],
  });

  const base = {
    age,
    lifetimeMs: lifetime.lifetimeMs,
    freshnessMs,
    staleMs,
    freshUntil,
    swrUntil,
  };

  if (clientRejects) {
    if (req.onlyIfCached) return timeout([]);
    return {
      ...base,
      status: 'unusable',
      revalidate: false,
      backgroundRevalidate: false,
      serve: false,
      gatewayTimeout: false,
      reasons,
    };
  }

  if (!isStale) {
    if (mustRevalidateNow) {
      // 响应还新鲜，但 no-cache（请求或响应侧）要求先验证。
      if (req.onlyIfCached) return timeout([]);
      return {
        ...base,
        status: 'stale-revalidate',
        revalidate: true,
        backgroundRevalidate: false,
        serve: false,
        gatewayTimeout: false,
        reasons,
      };
    }
    return {
      ...base,
      status: 'fresh',
      revalidate: false,
      backgroundRevalidate: false,
      serve: true,
      gatewayTimeout: false,
      reasons,
    };
  }

  // 已过期。
  if (mustRevalidateNow) {
    // no-cache / must-revalidate 强制验证时，only-if-cached 拿不到现成副本 -> 504。
    if (req.onlyIfCached) return timeout([]);
    return {
      ...base,
      status: 'stale-revalidate',
      revalidate: true,
      backgroundRevalidate: false,
      serve: false,
      gatewayTimeout: false,
      reasons,
    };
  }

  // 客户端愿意容忍过期（max-stale）或响应声明了 SWR 窗口：
  // only-if-cached 也可以接受这类「仍允许使用」的过期副本。
  if (withinMaxStale || withinSWR) {
    return {
      ...base,
      status: 'stale-serve',
      revalidate: false,
      // max-stale 不要求后台刷新；SWR 窗口内才触发后台再验证。
      backgroundRevalidate: withinSWR,
      serve: true,
      gatewayTimeout: false,
      reasons,
    };
  }

  if (req.onlyIfCached) return timeout(['stale']);

  return {
    ...base,
    status: 'stale-revalidate',
    revalidate: true,
    backgroundRevalidate: false,
    serve: false,
    gatewayTimeout: false,
    reasons: [...reasons, 'expired'],
  };
}
