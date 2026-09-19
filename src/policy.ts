import { HeaderBag, parseVary } from './headers.js';
import { cacheControlOf, parseAge, type CacheControl } from './directives.js';
import { elapsedSeconds, parseHttpDate } from './time.js';
import type {
  CacheMode,
  HeadersLike,
  PolicyOptions,
  RequestLike,
  ResponseLike,
  ServeDecision,
  StorageDecision,
  TransactionTimes,
} from './types.js';

// 避免仅类型导入在 isolatedModules 之外的环境下出问题；parseVary 是值导入。
type VaryInfo = ReturnType<typeof parseVary>;

/**
 * RFC 9111 第 3 节：默认对响应缓存可缓存的状态码。
 * 其余状态码（包括 201/204/302/403/404/410/500 等）默认不可缓存，
 * 只有带显式新鲜度信息（或共享模式下的 public）才放行。
 */
export const DEFAULT_CACHEABLE_STATUSES: ReadonlySet<number> = new Set([
  200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501,
]);

/** 启发式新鲜期默认参数：10% 比例、24 小时上限。 */
const DEFAULT_HEURISTIC_COEFFICIENT = 0.1;
const DEFAULT_HEURISTIC_MAX_LIFETIME_SEC = 24 * 60 * 60;

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/** 存储决策 / 新鲜度计算的输入（脱离 ResponsePolicy 类也可直接调用）。 */
export interface PolicyInput {
  mode?: CacheMode;
  request: Pick<RequestLike, 'method' | 'headers'>;
  response: Pick<ResponseLike, 'status' | 'headers'>;
  times: TransactionTimes;
  options?: PolicyOptions;
}

function normalizeMode(mode: CacheMode | undefined): CacheMode {
  return mode === 'private' ? 'private' : 'shared';
}

/**
 * 单条响应的缓存语义策略。
 *
 * 构造时传入请求、响应和本地记录的事务时刻；之后可以反复用
 * {@link ResponsePolicy.canStore} / {@link ResponsePolicy.evaluate}
 * 做存储决策与命中判定。时间通过 options.now 注入，默认真实时钟。
 */
export class ResponsePolicy {
  readonly mode: CacheMode;
  readonly requestHeaders: HeaderBag;
  readonly responseHeaders: HeaderBag;
  readonly requestMethod: string;
  readonly status: number;
  readonly times: TransactionTimes;
  readonly heuristicCoefficient: number;
  readonly heuristicMaxLifetimeSec: number;
  declare readonly requestCC: CacheControl;
  declare readonly responseCC: CacheControl;
  private readonly clock: () => number;
  readonly vary: VaryInfo;

  constructor(
    request: Pick<RequestLike, 'method' | 'headers'>,
    response: Pick<ResponseLike, 'status' | 'headers'>,
    times: TransactionTimes,
    options: PolicyOptions = {},
  ) {
    this.mode = normalizeMode(options.mode);
    this.requestMethod = (request.method ?? 'GET').toUpperCase();
    this.requestHeaders = HeaderBag.from(request.headers);
    this.responseHeaders = HeaderBag.from(response.headers);
    this.status = response.status;
    this.times = times;
    this.heuristicCoefficient = options.heuristicCoefficient ?? DEFAULT_HEURISTIC_COEFFICIENT;
    this.heuristicMaxLifetimeSec =
      options.heuristicMaxLifetimeSec ?? DEFAULT_HEURISTIC_MAX_LIFETIME_SEC;
    this.clock = options.now ?? (() => Date.now());
    this.requestCC = cacheControlOf(this.requestHeaders);
    this.responseCC = cacheControlOf(this.responseHeaders);
    this.vary = parseVary(this.responseHeaders);
  }

  // --------------------------------------------------------------------------
  // 存储决策（RFC 9111 §3）
  // --------------------------------------------------------------------------

  canStore(): StorageDecision {
    // 请求侧 no-store：客户端明确表示不愿存任何东西。
    if (this.requestCC.tokens.has('no-store')) {
      return this.notStorable('request-no-store');
    }
    // 响应侧 no-store：任何模式、任何缓存都不得存储。
    if (this.responseCC.tokens.has('no-store')) {
      return this.notStorable('response-no-store');
    }
    // 只有 GET / HEAD 的响应默认可缓存；其他方法的响应不存
    // （POST 等方法虽可通过显式头允许，但语义内核采取保守策略）。
    if (this.requestMethod !== 'GET' && this.requestMethod !== 'HEAD') {
      return this.notStorable('method-not-cacheable');
    }
    // 共享缓存不存 private 响应。
    if (this.mode === 'shared' && this.responseCC.tokens.has('private')) {
      return this.notStorable('shared-cache-response-private');
    }
    // 带 Authorization 的请求，其响应在共享缓存下默认不可存储，
    // 必须出现 must-revalidate / public / s-maxage 三个指令之一。
    if (this.mode === 'shared' && this.requestHeaders.has('authorization')) {
      const allowed =
        this.responseCC.tokens.has('must-revalidate') ||
        this.responseCC.tokens.has('public') ||
        this.responseCC.values.has('s-maxage');
      if (!allowed) return this.notStorable('authorization-without-directive');
    }

    const freshnessLifetimeSec = this.computeFreshnessLifetime();
    const defaultCacheable = DEFAULT_CACHEABLE_STATUSES.has(this.status);
    if (!defaultCacheable && !this.hasExplicitFreshness()) {
      return this.notStorable('status-not-cacheable');
    }

    const mustRevalidateBeforeUse = this.responseCC.tokens.has('no-cache');
    return {
      storable: true,
      freshnessLifetimeSec,
      staleWhileRevalidateSec: this.effectiveSwrWindow(),
      mustRevalidateBeforeUse,
    };
  }

  private notStorable(reason: StorageDecision['reason']): StorageDecision {
    return {
      storable: false,
      reason,
      freshnessLifetimeSec: 0,
      staleWhileRevalidateSec: 0,
      mustRevalidateBeforeUse: false,
    };
  }

  /**
   * 响应是否携带显式新鲜度信息。
   *
   * 优先级：s-maxage（仅共享模式）> max-age > Expires（与响应自身
   * Date 头做差）。Expires 无法解析为 HTTP-date 时视为“无显式信息”，
   * 不落得一个负寿命。
   */
  private hasExplicitFreshness(): boolean {
    if (this.mode === 'shared' && this.responseCC.values.has('s-maxage')) return true;
    if (this.responseCC.values.has('max-age')) return true;
    if (parseHttpDate(this.responseHeaders.get('expires')) != null) return true;
    return false;
  }

  /**
   * 计算新鲜期（秒），RFC 9111 §4.2.1 / §4.2.2。
   *
   * 共享模式 s-maxage 压过 max-age；都没有再看 Expires（与响应 Date
   * 做差，而非与本地当前时间比较，上游时钟快慢由此被吸收掉）。
   * 显式信息全无且状态码默认可缓存时，用 Last-Modified 启发式，
   * 比例 10%，上限 24h（均可配）；其余情况返回 0（出生即过期）。
   */
  computeFreshnessLifetime(): number {
    if (this.mode === 'shared') {
      const sMaxAge = this.responseCC.values.get('s-maxage');
      if (sMaxAge !== undefined) return sMaxAge;
    }
    const maxAge = this.responseCC.values.get('max-age');
    if (maxAge !== undefined) return maxAge;

    const expires = parseHttpDate(this.responseHeaders.get('expires'));
    if (expires !== null) {
      const date = this.responseDateMs();
      const lifetimeSec = Math.floor((expires - date) / 1000);
      // Expires 早于或等于 Date：等价于已经过期，新鲜期 0。
      return Math.max(0, lifetimeSec);
    }

    // 启发式：只对默认可缓存的响应类型生效。
    if (DEFAULT_CACHEABLE_STATUSES.has(this.status)) {
      const lastModified = parseHttpDate(this.responseHeaders.get('last-modified'));
      const date = this.responseDateMs();
      if (lastModified !== null && date > lastModified && this.heuristicCoefficient > 0) {
        const sinceLastModifiedSec = (date - lastModified) / 1000;
        const heuristic = Math.floor(sinceLastModifiedSec * this.heuristicCoefficient);
        return Math.max(0, Math.min(heuristic, this.heuristicMaxLifetimeSec));
      }
    }
    return 0;
  }

  /**
   * 响应自己声明的 Date（毫秒）。缺失时按 RFC 9111 用本地记录的
   * 响应收到时刻补齐 —— 这也是计算 apparent age 的基准。
   */
  responseDateMs(): number {
    return parseHttpDate(this.responseHeaders.get('date')) ?? this.times.responseTimeMs;
  }

  /**
   * 截至给定时刻（默认注入时钟的 now）响应的当前年龄，单位秒。
   * RFC 9111 §4.2.3：
   *   age_value   = 响应里 Age 头的值（非法按 0）
   *   apparent    = responseTime - responseDate （钳为非负）
   *   corrected   = max(age_value + 往返耗时, apparent)
   *                 其中往返耗时 = responseTime - requestTime
   *   current_age = corrected + (now - responseTime)
   *
   * 上游时钟再快，apparent 也被钳到 0，年龄不会算成负数；
   * 响应里带过来的 Age（上一跳缓存的驻留时间）和请求往返时间都计入。
   */
  currentAgeSec(nowMs: number = this.clock()): number {
    const ageValue = parseAge(this.responseHeaders);
    const dateMs = this.responseDateMs();

    const apparentAge = elapsedSeconds(dateMs, this.times.responseTimeMs);
    const requestDelay = elapsedSeconds(this.times.requestTimeMs, this.times.responseTimeMs);

    const correctedAge = Math.max(apparentAge, ageValue + requestDelay);
    const residentTime = elapsedSeconds(this.times.responseTimeMs, nowMs);
    return correctedAge + residentTime;
  }

  // --------------------------------------------------------------------------
  // 命中判定（RFC 9111 §4 / §5.2.1 请求指令）
  // --------------------------------------------------------------------------

  /**
   * 用一条新请求评估这份已存响应现在能不能直接用。
   * 传入新请求的头字段（或只含 headers 的请求对象）；
   * 新鲜度全部基于构造本策略时的那份响应。
   */
  evaluate(
    requestHeadersOrRequest: HeadersLike | Pick<RequestLike, 'headers'>,
    nowMs: number = this.clock(),
  ): ServeDecision {
    const requestHeaders =
      'headers' in requestHeadersOrRequest
        ? (requestHeadersOrRequest as Pick<RequestLike, 'headers'>).headers
        : (requestHeadersOrRequest as HeadersLike);
    const reqCC = cacheControlOf(HeaderBag.from(requestHeaders));
    const ageSec = this.currentAgeSec(nowMs);
    const lifetimeSec = this.computeFreshnessLifetime();
    const remaining = lifetimeSec - ageSec;
    const fresh = remaining > 0;

    const mustRevalidateBeforeUse =
      this.responseCC.tokens.has('no-cache') || reqCC.tokens.has('no-cache');
    const forbidsStale = this.staleForbidden();
    const reqNoCache = reqCC.tokens.has('no-cache');

    const gateway = (): ServeDecision => ({
      state: 'gateway-timeout',
      ageSec,
      freshnessLifetimeSec: lifetimeSec,
      remainingFreshnessSec: remaining,
    });

    // 1) only-if-cached（RFC 9111 §4.2.4）：不允许联系上游。只有新鲜且
    //    满足请求约束、或请求显式允许用陈旧副本（max-stale）时才返回；
    //    其余一切需要再验证的情形一律 gateway-timeout（调用方回 504）。
    if (reqCC.tokens.has('only-if-cached')) {
      if (mustRevalidateBeforeUse) return gateway();
      if (fresh) {
        if (this.freshnessRequestConstraint(reqCC, ageSec, remaining) === undefined) {
          return this.serve(ageSec, lifetimeSec, remaining);
        }
        return gateway();
      }
      if (this.withinMaxStale(reqCC, ageSec, lifetimeSec)) {
        return this.staleServe(ageSec, lifetimeSec, remaining);
      }
      // SWR 的后台刷新也要联系上游，only-if-cached 下不允许。
      return gateway();
    }

    // 2) no-cache（请求或响应）：强制再验证，max-stale 也不能放行。
    if (reqNoCache) return this.revalidate('request-no-cache', ageSec, lifetimeSec, remaining);
    if (this.responseCC.tokens.has('no-cache')) {
      return this.revalidate('response-no-cache', ageSec, lifetimeSec, remaining);
    }

    // 3) 新鲜：还要过请求侧的 max-age / min-fresh 硬门槛。
    if (fresh) {
      const failed = this.freshnessRequestConstraint(reqCC, ageSec, remaining);
      if (failed === undefined) return this.serve(ageSec, lifetimeSec, remaining);
      return this.revalidate(failed, ageSec, lifetimeSec, remaining);
    }

    // 4) 已过期。
    //    4a) 客户端明确愿意接受陈旧响应（max-stale）：RFC 9111 §4.2.4
    //        规定该请求指令覆盖服务端“禁止用陈旧副本”的要求，直接给。
    if (this.withinMaxStale(reqCC, ageSec, lifetimeSec)) {
      return this.staleServe(ageSec, lifetimeSec, remaining);
    }
    //    4b) must-revalidate / proxy-revalidate：过期后必须先再验证。
    if (forbidsStale) {
      return this.revalidate('must-revalidate', ageSec, lifetimeSec, remaining);
    }
    //    4c) max-age / min-fresh 是更具体的失败原因。
    const failed = this.freshnessRequestConstraint(reqCC, ageSec, remaining);
    if (failed !== undefined) {
      return this.revalidate(failed, ageSec, lifetimeSec, remaining);
    }
    //    4d) 普通过期：落在 stale-while-revalidate 窗口内也返回
    //        stale-serve（调用方据此决定是否后台刷新），窗口外再验证。
    if (this.swrRemaining(ageSec, lifetimeSec) > 0) {
      return this.staleServe(ageSec, lifetimeSec, remaining);
    }
    return this.revalidate('expired', ageSec, lifetimeSec, remaining);
  }

  private serve(
    ageSec: number,
    lifetimeSec: number,
    remaining: number,
  ): ServeDecision {
    return {
      state: 'serve',
      ageSec,
      freshnessLifetimeSec: lifetimeSec,
      remainingFreshnessSec: remaining,
    };
  }

  private staleServe(
    ageSec: number,
    lifetimeSec: number,
    remaining: number,
  ): ServeDecision {
    return {
      state: 'stale-serve',
      ageSec,
      freshnessLifetimeSec: lifetimeSec,
      remainingFreshnessSec: remaining,
      staleWhileRevalidateRemainingSec: this.swrRemaining(ageSec, lifetimeSec),
    };
  }

  private revalidate(
    reason: ServeDecision['reason'],
    ageSec: number,
    lifetimeSec: number,
    remaining: number,
  ): ServeDecision {
    return {
      state: 'revalidate',
      reason,
      ageSec,
      freshnessLifetimeSec: lifetimeSec,
      remainingFreshnessSec: remaining,
    };
  }

  /** 响应是否禁止在过期后不加验证地使用陈旧副本。 */
  private staleForbidden(): boolean {
    if (this.responseCC.tokens.has('must-revalidate')) return true;
    if (this.mode === 'shared' && this.responseCC.tokens.has('proxy-revalidate')) return true;
    return false;
  }

  /**
   * 检查请求侧的新鲜度硬约束 max-age / min-fresh。
   * 返回未通过的指令名；全部满足返回 undefined。
   */
  private freshnessRequestConstraint(
    reqCC: ReturnType<typeof cacheControlOf>,
    ageSec: number,
    remaining: number,
  ): 'max-age' | 'min-fresh' | undefined {
    const maxAge = reqCC.values.get('max-age');
    if (maxAge !== undefined && ageSec > maxAge) return 'max-age';
    const minFresh = reqCC.values.get('min-fresh');
    if (minFresh !== undefined && remaining < minFresh) return 'min-fresh';
    return undefined;
  }

  /** 陈旧响应是否在请求方 max-stale 的容忍范围内。 */
  private withinMaxStale(
    reqCC: ReturnType<typeof cacheControlOf>,
    ageSec: number,
    lifetimeSec: number,
  ): boolean {
    const maxStale = reqCC.values.get('max-stale');
    if (maxStale === undefined) return false;
    if (!Number.isFinite(maxStale)) return true;
    return ageSec - lifetimeSec <= maxStale;
  }

  /**
   * stale-while-revalidate 窗口（秒），受以下规则约束：
   * - must-revalidate / proxy-revalidate（共享模式）使窗口归零；
   * - 响应 no-cache 同样不允许后台异步刷新（每次必须先验证）。
   */
  private effectiveSwrWindow(): number {
    if (this.staleForbidden()) return 0;
    if (this.responseCC.tokens.has('no-cache')) return 0;
    return this.responseCC.values.get('stale-while-revalidate') ?? 0;
  }

  private swrRemaining(ageSec: number, lifetimeSec: number): number {
    const windowSec = this.effectiveSwrWindow();
    if (windowSec <= 0) return 0;
    const staleFor = ageSec - lifetimeSec; // 已过期秒数（正数）
    return Math.max(0, windowSec - staleFor);
  }

  /** 用于落库时剥离逐跳头（这些头不得跨连接复用）。 */
  static hopByHopHeaders(responseHeaders: HeaderBag): [string, string][] {
    const connectionTokens = (responseHeaders.get('connection') ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    const stripped = responseHeaders.without([...HOP_BY_HOP_HEADERS, ...connectionTokens]);
    return stripped;
  }
}

/** 一次性完成存储决策的便捷函数（无状态）。 */
export function decideStorage(input: PolicyInput): StorageDecision {
  const policy = new ResponsePolicy(
    input.request,
    input.response,
    input.times,
    input.options ?? { mode: input.mode },
  );
  return policy.canStore();
}
