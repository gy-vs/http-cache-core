/**
 * 语义内核使用的全部类型定义。
 *
 * 本库不绑定任何 HTTP 客户端或服务端框架：请求/响应都用普通结构表示，
 * 头字段既可以用 {@link Headers}（fetch / undici 原生），也可以用
 * [name, value] 数组或普通对象传入。响应体 body 为 unknown，
 * 由网络层和存储层自行决定具体类型。
 */

/** 头字段容器：原生 Headers、键值对数组、或普通对象。 */
export type HeadersLike = Headers | readonly (readonly [string, string])[] | Readonly<Record<string, string>>;

/** 请求的抽象表示。method 缺省时按 GET 处理。 */
export interface RequestLike {
  method?: string;
  /** 目标 URI，通常是完整 URL；本库不做归一化，逐字符参与缓存键计算。 */
  url: string;
  headers: HeadersLike;
}

/** 响应的抽象表示。 */
export interface ResponseLike {
  status: number;
  headers: HeadersLike;
  /** 响应体，语义层只读不写，304 合并且不会触碰。 */
  body?: unknown;
}

/**
 * 一次源站事务在本地记录的时刻（毫秒，Date.now() 同一时间轴）。
 * 请求时间只用于计算往返耗时 apparent age；响应时间是年龄累加的零点。
 */
export interface TransactionTimes {
  /** 请求发出时刻。 */
  requestTimeMs: number;
  /** 响应（最后一个字节）收到时刻。 */
  responseTimeMs: number;
}

/** 共享 / 私有缓存模式。判定差异见 RFC 9111 第 3 节。 */
export type CacheMode = 'shared' | 'private';

/** 可注入时钟：返回当前毫秒时间戳。默认实现调用 Date.now()。 */
export type Clock = () => number;

/** 构造语义策略时的选项。 */
export interface PolicyOptions {
  mode?: CacheMode;
  /**
   * 启发式新鲜期占 (Date - Last-Modified) 的比例，默认 0.1（10%）。
   * 设为 0 表示禁用 Last-Modified 启发式。
   */
  heuristicCoefficient?: number;
  /** 启发式新鲜期上限（秒），默认 24 小时，兜底用。 */
  heuristicMaxLifetimeSec?: number;
  /** 时钟注入点，测试用；默认真实时钟。 */
  now?: Clock;
}

/** 不可存储的具体原因，便于调用方记录日志或加调测头。 */
export type NonStorableReason =
  | 'request-no-store'
  | 'response-no-store'
  | 'method-not-cacheable'
  | 'authorization-without-directive'
  | 'shared-cache-response-private'
  | 'status-not-cacheable';

/** 存储决策结果。 */
export interface StorageDecision {
  storable: boolean;
  reason?: NonStorableReason;
  /**
   * 新鲜期（秒）。不可存储时为 0。
   * 显式指令（s-maxage / max-age / Expires 差值）优先，
   * 否则用 Last-Modified 启发式（仅对默认可缓存状态码），
   * 再没有就是 0。
   */
  freshnessLifetimeSec: number;
  /**
   * 过期后仍可直接返回、同时后台再验证的窗口（秒），
   * 来自 stale-while-revalidate 指令；must-revalidate / proxy-revalidate
   * 生效时强制为 0。
   */
  staleWhileRevalidateSec: number;
  /** 响应是否带 no-cache（可以存，但每次使用前必须再验证）。 */
  mustRevalidateBeforeUse: boolean;
}

/**
 * 命中判定给出的处置。
 * - serve：可以直接返回（新鲜，或在调用方接受的过期容忍度内）
 * - stale-serve：返回过期副本；swr 非零时调用方可后台再验证
 * - revalidate：不能直接返回，需要条件请求（携带原因）
 * - gateway-timeout：only-if-cached 且没有可用副本，调用方应回 504
 */
export type ServeState = 'serve' | 'stale-serve' | 'revalidate' | 'gateway-timeout';

/** 需要再验证的具体原因。 */
export type RevalidateReason =
  | 'request-no-cache'
  | 'response-no-cache'
  | 'expired'
  | 'max-age'
  | 'min-fresh'
  | 'must-revalidate';

/** 对一条新请求评估已存响应的结果。 */
export interface ServeDecision {
  state: ServeState;
  /** 截至 now 的响应年龄（秒，非负）。 */
  ageSec: number;
  /** 该响应的新鲜期（秒）。 */
  freshnessLifetimeSec: number;
  /** now 距离新鲜截止点的剩余秒数；负数表示已过期多久。 */
  remainingFreshnessSec: number;
  /** state 为 revalidate / gateway-timeout 时的原因。 */
  reason?: RevalidateReason;
  /** stale-serve 时剩余的 stale-while-revalidate 窗口（秒，可能为 0）。 */
  staleWhileRevalidateRemainingSec?: number;
}

/** 存储层里的请求快照（Vary 选择与构造条件请求都靠它）。 */
export interface StoredRequest {
  method: string;
  url: string;
  headers: [string, string][];
}

/** 存储层里的响应。头字段保留重复值，body 对语义层透明。 */
export interface StoredResponse {
  status: number;
  headers: [string, string][];
  body?: unknown;
}

/** 一条缓存条目。同主键下每个 Vary 变体各占一条。 */
export interface CacheEntry {
  request: StoredRequest;
  response: StoredResponse;
  requestSentMs: number;
  responseReceivedMs: number;
  /** 落库时刻，便于存储后端自行排查。 */
  storedAtMs: number;
  /** 新鲜期（秒），落库时按策略算定。 */
  freshnessLifetimeSec: number;
  /** stale-while-revalidate 窗口（秒）。 */
  staleWhileRevalidateSec: number;
  /** 每次使用前必须再验证（响应 no-cache）。 */
  mustRevalidateBeforeUse: boolean;
}
