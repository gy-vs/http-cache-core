/**
 * 时间与缓存指令解析（RFC 9111）。
 *
 * 时间在本库内部一律使用「毫秒级 Unix 时间戳」（number），由外部时钟注入。
 */

const IMF_DATE_RE =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * 解析 IMF-fixdate（RFC 9110 5.6.7），无效返回 null。
 *
 * 不使用 Date.parse：它接受大量非 HTTP 格式（"0"、ISO 字符串等），
 * 而 RFC 要求无法解析的 Expires 一律视为不存在，宽松解析会造成错误的新鲜度。
 */
export function parseHttpDate(value: string): number | null {
  const m = IMF_DATE_RE.exec(value.trim());
  if (!m) return null;
  const [, day, mon, year, hour, min, sec] = m;
  const d = Number(day);
  const month = MONTHS[mon!];
  const y = Number(year);
  if (y < 1970 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, month!, d, Number(hour), Number(min), Number(sec));
  // 校验真实存在的日期（例如 2 月 31 日）
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
}

/** 把时间戳格式化成 IMF-fixdate（用于生成条件请求时不常用，仅供测试/调试）。 */
export function formatHttpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

/**
 * 解析 delta-seconds（RFC 9110 1.2.2）：1*DIGIT。
 * 非法值返回 null；超过 JS 安全整数的按上限裁剪（毫秒，不按秒累加）。
 */
export function parseDeltaSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return Number.MAX_SAFE_INTEGER;
  return n;
}

/** 秒 -> 毫秒，超大值裁剪到安全整数。 */
export function secondsToMs(seconds: number): number {
  return seconds >= Number.MAX_SAFE_INTEGER / 1000
    ? Number.MAX_SAFE_INTEGER
    : seconds * 1000;
}

/**
 * 解析后的 Cache-Control 指令。
 * 只保留本库需要理解的指令，其余裸 token / 扩展指令记录在 unknownTokens 里。
 */
export interface CacheControl {
  /** request + response */
  noCache: boolean;
  noStore: boolean;
  maxAge: number | null; // 秒
  noTransform: boolean;
  /** response only */
  public: boolean;
  private: boolean;
  mustRevalidate: boolean;
  proxyRevalidate: boolean;
  sMaxage: number | null; // 秒
  staleWhileRevalidate: number | null; // 秒
  staleIfError: number | null; // 秒
  immutable: boolean;
  /** request only */
  maxStale: number | null; // 秒；"max-stale"（不带值）表示无限
  maxStaleInfinite: boolean;
  minFresh: number | null; // 秒
  onlyIfCached: boolean;
  mustUnderstand: boolean;
  /** 未识别的裸指令 */
  unknownTokens: string[];
}

export function emptyCacheControl(): CacheControl {
  return {
    noCache: false,
    noStore: false,
    maxAge: null,
    noTransform: false,
    public: false,
    private: false,
    mustRevalidate: false,
    proxyRevalidate: false,
    sMaxage: null,
    staleWhileRevalidate: null,
    staleIfError: null,
    immutable: false,
    maxStale: null,
    maxStaleInfinite: false,
    minFresh: null,
    onlyIfCached: false,
    mustUnderstand: false,
    unknownTokens: [],
  };
}

const KNOWN_TOKENS = new Set([
  'no-cache',
  'no-store',
  'max-age',
  'no-transform',
  'public',
  'private',
  'must-revalidate',
  'proxy-revalidate',
  's-maxage',
  'stale-while-revalidate',
  'stale-if-error',
  'immutable',
  'max-stale',
  'min-fresh',
  'only-if-cached',
  'must-understand',
]);

/**
 * 解析 Cache-Control 头（可能有多个，按逗号合并语义）。
 * 同一指令重复出现时取「限制更严」的方向（与 RFC 9111 3 一致）：
 * - 裸 token：出现即为真；
 * - 数值：取较小值（max-age=60 与 max-age=10 同时出现按 10 处理）；
 * - max-stale 不带值表示无限。
 */
export function parseCacheControl(raw: string | null | undefined): CacheControl {
  const cc = emptyCacheControl();
  if (!raw) return cc;

  const minValue = (
    field: 'maxAge' | 'sMaxage' | 'staleWhileRevalidate' | 'staleIfError' | 'minFresh',
    v: number | null,
  ): void => {
    if (v === null) return;
    cc[field] = cc[field] === null ? v : Math.min(cc[field]!, v);
  };

  // 多个 Cache-Control 头之间用逗号等价连接
  for (const directive of raw.split(',')) {
    const seg = directive.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    const token = (eq === -1 ? seg : seg.slice(0, eq)).trim().toLowerCase();
    const rawVal = eq === -1 ? undefined : seg.slice(eq + 1).trim();
    // 带引号的值去引号（如 no-cache="set-cookie"）
    const val =
      rawVal !== undefined &&
      rawVal.length >= 2 &&
      rawVal.startsWith('"') &&
      rawVal.endsWith('"')
        ? rawVal.slice(1, -1)
        : rawVal;

    switch (token) {
      case 'no-cache':
        cc.noCache = true;
        break;
      case 'no-store':
        cc.noStore = true;
        break;
      case 'no-transform':
        cc.noTransform = true;
        break;
      case 'public':
        cc.public = true;
        break;
      case 'private':
        cc.private = true;
        break;
      case 'must-revalidate':
        cc.mustRevalidate = true;
        break;
      case 'proxy-revalidate':
        cc.proxyRevalidate = true;
        break;
      case 'immutable':
        cc.immutable = true;
        break;
      case 'only-if-cached':
        cc.onlyIfCached = true;
        break;
      case 'must-understand':
        cc.mustUnderstand = true;
        break;
      case 'max-age':
        minValue('maxAge', parseDeltaSeconds(val));
        break;
      case 's-maxage':
        minValue('sMaxage', parseDeltaSeconds(val));
        break;
      case 'stale-while-revalidate':
        // RFC 5861 的参数也可能带引号
        minValue('staleWhileRevalidate', parseDeltaSeconds(val));
        break;
      case 'stale-if-error':
        minValue('staleIfError', parseDeltaSeconds(val));
        break;
      case 'min-fresh':
        minValue('minFresh', parseDeltaSeconds(val));
        break;
      case 'max-stale': {
        if (val === undefined || val === '') {
          cc.maxStaleInfinite = true;
          cc.maxStale = null;
        } else {
          const parsed = parseDeltaSeconds(val);
          if (parsed !== null && !cc.maxStaleInfinite) {
            cc.maxStale = cc.maxStale === null ? parsed : Math.max(cc.maxStale, parsed);
          }
        }
        break;
      }
      default:
        if (!KNOWN_TOKENS.has(token) && token) cc.unknownTokens.push(token);
        break;
    }
  }
  return cc;
}

/** 计算 (a - b)，结果钳制在 0 以上，避免任何年龄被算成负数。 */
export function nonNegativeDiff(a: number, b: number): number {
  return Math.max(0, a - b);
}
