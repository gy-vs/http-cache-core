import { HeaderBag, parseVary, varyMatches, variantId } from './headers.js';
import { cacheControlOf } from './directives.js';
import { ResponsePolicy } from './policy.js';
import { conditionalHeaders, mergeNotModified } from './revalidate.js';
import { MemoryStore, primaryKey, type CacheStore } from './store.js';
import type {
  CacheEntry,
  Clock,
  PolicyOptions,
  RequestLike,
  ResponseLike,
  ServeDecision,
  StoredRequest,
  StoredResponse,
  StorageDecision,
  TransactionTimes,
} from './types.js';

// ---------------------------------------------------------------------------
// 对外结果类型
// ---------------------------------------------------------------------------

interface MatchBase {
  primary: string;
  variant?: string;
  entry?: CacheEntry;
  decision?: ServeDecision;
}

export type MatchResult =
  | (MatchBase & { kind: 'serve' })
  | (MatchBase & { kind: 'stale' })
  | (MatchBase & { kind: 'revalidate'; conditionalHeaders: [string, string][] })
  | (MatchBase & { kind: 'gateway-timeout' })
  | (MatchBase & { kind: 'miss' });

export interface CacheOptions extends PolicyOptions {
  /** 自定义存储后端；缺省使用容量 maxEntries 的内存 LRU。 */
  store?: CacheStore;
  /** 使用默认内存存储时的 slot 上限，默认 1000。 */
  maxEntries?: number;
}

/** put / 200 替换的输入。 */
export interface PutInput {
  request: RequestLike;
  response: ResponseLike;
  times: TransactionTimes;
}

/** 再验证回调的返回：上游响应（304 或 200）与本地记录的事务时刻。 */
export interface RevalidationResponse {
  response: ResponseLike;
  times: TransactionTimes;
}

/**
 * 由调用方提供的再验证请求函数。
 * 内核不发任何网络请求；调用方拿到条件头后自行请求上游。
 */
export type RevalidateFn = (context: {
  request: RequestLike;
  entry: CacheEntry;
  conditionalHeaders: [string, string][];
}) => Promise<RevalidationResponse>;

export interface HandleResult {
  /**
   * - cached：直接命中（新鲜或过期副本立即返回）；background 存在时
   *   表示后台再验证已被触发（同 slot 并发只触发一次）。
   * - revalidated：条件请求完成；replaced=false 是 304 合并，true 是 200 替换。
   * - miss：没有可用副本，调用方应自行请求上游并调用 put。
   * - gateway-timeout：only-if-cached 且无可用副本，调用方应回 504。
   * - invalidated：304 合并后响应已不可存储，旧条目已被删除。
   * - passthrough：再验证拿回完整响应但它不可缓存；upstream 里是应
   *   直接返回给下游的原始响应（已自行请求，不要再发一次）。
   */
  kind: 'cached' | 'revalidated' | 'miss' | 'gateway-timeout' | 'invalidated' | 'passthrough';
  entry?: CacheEntry;
  decision?: ServeDecision;
  /** kind=revalidated 时：false=304 合并，true=200 完整替换。 */
  replaced?: boolean;
  /** kind=passthrough 时携带源站完整响应。 */
  upstream?: RevalidationResponse;
  background?: Promise<void>;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** revalidate 的结果：replaced=false 为 304 合并，true 为完整响应替换。 */
export interface RevalidateOutcome {
  entry: CacheEntry | null;
  replaced: boolean;
  /**
   * 收到完整响应但它按新规则不可存储（或没有匹配变体）时，把源站响应
   * 原样交回调用方 —— 这种情况下调用方需要直接把它返回给下游。
   */
  upstream?: RevalidationResponse;
}

/** inflight 去重用的 slot 分隔符，与存储层保持一致。 */
const SLOT_SEP = '\u0000';

/**
 * 语义内核的缓存编排器。
 *
 * 职责：存储决策落库、按 Vary 选择变体、命中判定、生成条件请求头、
 * 合并 304、200 替换、stale-while-revalidate 后台再验证（同 slot 去重）。
 * 不包含任何网络/磁盘代码。
 */
export class Cache {
  private readonly store: CacheStore;
  private readonly policyOptions: PolicyOptions;
  private readonly clock: Clock;
  /** slot -> 进行中的再验证（前台 await 与后台 SWR 共用，保证只打一次）。 */
  private readonly inflight = new Map<string, Promise<RevalidateOutcome>>();

  constructor(options: CacheOptions = {}) {
    this.store = options.store ?? new MemoryStore({ maxEntries: options.maxEntries });
    this.clock = options.now ?? (() => Date.now());
    const { store: _store, maxEntries: _maxEntries, ...policyOptions } = options;
    this.policyOptions = policyOptions;
  }

  get storage(): CacheStore {
    return this.store;
  }

  // -------------------------------------------------------------------------
  // 落库
  // -------------------------------------------------------------------------

  /**
   * 对一次源站事务跑存储决策；可存则落库（按 Vary 区分变体）。
   * 返回决策结果，调用方可根据 decision.storable / reason 记日志。
   */
  put(input: PutInput): StorageDecision {
    const { request, response, times } = input;
    const policy = new ResponsePolicy(request, response, times, this.policyOptions);
    const decision = policy.canStore();
    if (!decision.storable) return decision;

    const method = (request.method ?? 'GET').toUpperCase();
    const primary = primaryKey({ method, url: request.url });
    const vary = parseVary(HeaderBag.from(response.headers));
    const requestBag = HeaderBag.from(request.headers);

    // 请求侧只留 Vary 选择头；Vary: * 时没有选择头，条目永不命中。
    const snapshotHeaders: [string, string][] = vary.wildcard
      ? []
      : vary.names.flatMap((name) => requestBag.valuesOf(name).map((v) => [name, v] as [string, string]));

    const storedRequest: StoredRequest = { method, url: request.url, headers: snapshotHeaders };
    const storedResponse: StoredResponse = {
      status: response.status,
      headers: ResponsePolicy.hopByHopHeaders(HeaderBag.from(response.headers)),
      body: response.body,
    };
    const entry: CacheEntry = {
      request: storedRequest,
      response: storedResponse,
      requestSentMs: times.requestTimeMs,
      responseReceivedMs: times.responseTimeMs,
      storedAtMs: this.clock(),
      freshnessLifetimeSec: decision.freshnessLifetimeSec,
      staleWhileRevalidateSec: decision.staleWhileRevalidateSec,
      mustRevalidateBeforeUse: decision.mustRevalidateBeforeUse,
    };

    // 新响应的 Vary 集合与该 slot 旧响应不同时，旧主键下的变体全部失效。
    const variant = vary.wildcard ? '*' : variantId(vary.names, requestBag);
    const old = this.store.get(primary, variant);
    if (old !== undefined) {
      const oldVary = parseVary(HeaderBag.from(old.response.headers));
      const sameVary =
        oldVary.wildcard === vary.wildcard &&
        oldVary.names.length === vary.names.length &&
        oldVary.names.every((n, i) => n === vary.names[i]);
      if (!sameVary) this.store.deleteByPrimary(primary);
    }
    this.store.set(primary, variant, entry);
    return decision;
  }

  // -------------------------------------------------------------------------
  // 命中
  // -------------------------------------------------------------------------

  /**
   * 评估一条新请求。注意 match 不会触发任何再验证，只给判定；
   * 需要自动再验证/后台刷新用 {@link handle}。
   */
  match(request: RequestLike, nowMs: number = this.clock()): MatchResult {
    const method = (request.method ?? 'GET').toUpperCase();
    const primary = primaryKey({ method, url: request.url });
    const variants = this.store.listVariants(primary);
    // only-if-cached：最终没有任何可返回副本时，要让调用方回 504，
    // 而不是去联系上游（包括一个变体都没有的情况）。
    const onlyIfCached = cacheControlOf(HeaderBag.from(request.headers)).tokens.has(
      'only-if-cached',
    );

    let miss: MatchResult = { kind: 'miss', primary };

    for (const { variant, entry } of variants) {
      const responseBag = HeaderBag.from(entry.response.headers);
      const vary = parseVary(responseBag);
      // Vary: * 永远不命中。
      if (vary.wildcard) continue;
      const storedRequestBag = HeaderBag.from(entry.request.headers);
      const newRequestBag = HeaderBag.from(request.headers);
      if (!varyMatches(vary.names, storedRequestBag, newRequestBag)) continue;

      const policy = this.policyFromEntry(entry);
      const decision = policy.evaluate(request.headers, nowMs);

      if (decision.state === 'serve' || decision.state === 'stale-serve') {
        this.store.touch(primary, variant);
        if (decision.state === 'serve') {
          return { kind: 'serve', primary, variant, entry, decision };
        }
        return { kind: 'stale', primary, variant, entry, decision };
      }
      if (decision.state === 'revalidate') {
        // 找到了匹配变体但不可直接用（正常同一 Vary 集合下只有一份匹配）。
        return {
          kind: 'revalidate',
          primary,
          variant,
          entry,
          decision,
          conditionalHeaders: conditionalHeaders(entry),
        };
      }
      // gateway-timeout：only-if-cached 下这条不能用；继续尝试别的变体。
      miss = { kind: 'gateway-timeout', primary, decision };
    }
    if (miss.kind === 'miss' && onlyIfCached) {
      return { kind: 'gateway-timeout', primary };
    }
    return miss;
  }

  // -------------------------------------------------------------------------
  // 再验证
  // -------------------------------------------------------------------------

  /**
   * 对一个匹配到的变体执行条件再验证。
   * - 304：合并头、沿用响应体、刷新新鲜度；条目被判定为不可存储时删除；
   * - 200（或其他完整响应）：按存储决策整体替换该变体。
   * 同一 slot 并发调用共享同一个 Promise，条件回调只执行一次。
   *
   * 返回 replaced=false 表示 304 合并（或条目被删），true 表示收到完整
   * 响应并替换。并发复用进行中再验证的调用方无法区分这两种来源，
   * 统一以重读后的 entry 内容为准（replaced=false）。
   */
  revalidate(
    request: RequestLike,
    variant: string,
    revalidateFn: RevalidateFn,
  ): Promise<RevalidateOutcome> {
    const method = (request.method ?? 'GET').toUpperCase();
    const primary = primaryKey({ method, url: request.url });
    const slotKey = primary + SLOT_SEP + variant;

    const existing = this.inflight.get(slotKey);
    if (existing !== undefined) {
      // 复用进行中的再验证；完成后重读该 slot（Vary 可能已整体变化）。
      return existing.then(() => ({
        entry: this.store.get(primary, variant) ?? this.matchEntry(request),
        replaced: false,
      }));
    }

    const entry = this.store.get(primary, variant);
    if (entry === undefined) {
      return Promise.resolve({ entry: null, replaced: false });
    }

    const job = (async (): Promise<RevalidateOutcome> => {
      const { response, times } = await revalidateFn({
        request,
        entry,
        conditionalHeaders: conditionalHeaders(entry),
      });

      if (response.status === 304) {
        const merged = mergeNotModified(
          entry,
          { headers: HeaderBag.from(response.headers).toEntries() },
          times,
          { headers: request.headers },
          this.policyOptions,
        );
        if (merged === null) {
          this.store.delete(primary, variant);
          return { entry: null, replaced: false };
        }
        this.store.set(primary, variant, merged);
        return { entry: merged, replaced: false };
      }

      // 完整响应：按新响应重新走存储决策。不可存或 Vary 不匹配时，
      // 旧条目失效（删除），并把原始响应作为 passthrough 交回。
      const storage = this.put({ request, response, times });
      if (!storage.storable) {
        this.store.deleteByPrimary(primary);
        return { entry: null, replaced: true, upstream: { response, times } };
      }
      const rematched = this.matchEntry(request);
      if (rematched === null) {
        return { entry: null, replaced: true, upstream: { response, times } };
      }
      return { entry: rematched, replaced: true };
    })();

    const tracked = job.finally(() => {
      this.inflight.delete(slotKey);
    });
    this.inflight.set(slotKey, tracked);
    return tracked;
  }

  /** match 的轻量变体：只取匹配变体的 entry，不构造判定结果。 */
  private matchEntry(request: RequestLike): CacheEntry | null {
    const method = (request.method ?? 'GET').toUpperCase();
    const primary = primaryKey({ method, url: request.url });
    const newRequestBag = HeaderBag.from(request.headers);
    for (const { entry } of this.store.listVariants(primary)) {
      const vary = parseVary(HeaderBag.from(entry.response.headers));
      if (vary.wildcard) continue;
      if (varyMatches(vary.names, HeaderBag.from(entry.request.headers), newRequestBag)) {
        return entry;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 一站式处理
  // -------------------------------------------------------------------------

  /**
   * 按缓存语义处理一条请求：
   *
   * - 新鲜 / stale-while-revalidate 窗口内：立即返回副本；在窗口内时
   *   顺带触发后台再验证（同 slot 并发去重，调用方不等待）；
   * - 必须再验证（no-cache、过期出窗口、must-revalidate、请求侧指令）：
   *   等待回调返回，304 合并或 200 替换后把结果交回；
   * - only-if-cached 无可用副本：gateway-timeout（回 504）；
   * - 完全没有副本：miss，由调用方自行请求后 {@link put}。
   */
  async handle(request: RequestLike, revalidateFn: RevalidateFn): Promise<HandleResult> {
    const matched = this.match(request);

    if (matched.kind === 'miss') {
      return { kind: 'miss' };
    }
    if (matched.kind === 'gateway-timeout') {
      return { kind: 'gateway-timeout', decision: matched.decision };
    }
    if (matched.kind === 'serve') {
      return { kind: 'cached', entry: matched.entry, decision: matched.decision };
    }
    if (matched.kind === 'stale') {
      const swr = matched.decision?.staleWhileRevalidateRemainingSec ?? 0;
      let background: Promise<void> | undefined;
      if (swr > 0) {
        background = this.revalidate(request, matched.variant!, revalidateFn).then(
          () => undefined,
          () => undefined, // 后台刷新失败不影响已经返回的陈旧副本
        );
      }
      return { kind: 'cached', entry: matched.entry, decision: matched.decision, background };
    }

    const outcome = await this.revalidate(request, matched.variant!, revalidateFn);
    if (outcome.entry === null) {
      if (outcome.upstream) return { kind: 'passthrough', upstream: outcome.upstream };
      return { kind: 'invalidated' };
    }
    const decision = this.policyFromEntry(outcome.entry).evaluate(request.headers);
    return {
      kind: 'revalidated',
      entry: outcome.entry,
      decision,
      replaced: outcome.replaced,
    };
  }

  /** 删除指定主键（全部变体）。 */
  invalidate(url: string, method = 'GET'): void {
    this.store.deleteByPrimary(primaryKey({ method: method.toUpperCase(), url }));
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  /**
   * 用落库条目重建响应策略。构造请求侧只需要方法（落库快照只保留了
   * Vary 选择头）；evaluate 时会用新请求重新解析请求指令。
   */
  private policyFromEntry(entry: CacheEntry): ResponsePolicy {
    return new ResponsePolicy(
      { method: entry.request.method, headers: entry.request.headers },
      { status: entry.response.status, headers: entry.response.headers },
      { requestTimeMs: entry.requestSentMs, responseTimeMs: entry.responseReceivedMs },
      this.policyOptions,
    );
  }
}
