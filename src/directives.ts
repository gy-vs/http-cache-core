import { HeaderBag } from './headers.js';

/**
 * Cache-Control 解析结果。
 *
 * - tokens：无参数的指令名（小写）。
 * - values：携带合法 delta-seconds 数值的指令（max-age、s-maxage、
 *   max-stale、min-fresh、stale-while-revalidate 等）。
 *
 * 按 RFC 9111，delta-seconds 是带引号也可的 token，但解析不出非负
 * 整数时该指令视为非法并整体忽略（不按 0 处理）。
 * max-stale 不带 "=" 时表示可接受任意时长的过期响应，
 * 以 Number.POSITIVE_INFINITY 表示。
 */
export interface CacheControl {
  tokens: Set<string>;
  values: Map<string, number>;
}

const KNOWN_NUMERIC = new Set([
  'max-age',
  's-maxage',
  'max-stale',
  'min-fresh',
  'stale-while-revalidate',
  'stale-if-error',
  'no-cache', // 历史上可能带字段名列表，此处不支持列表形式
]);

function parseDeltaSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // 引号包裹的 delta-seconds 不是合法形式，忽略。
  if (raw.startsWith('"')) return undefined;
  if (!/^[0-9]+$/.test(raw)) return undefined;
  return Number(raw);
}

/** 解析单个 Cache-Control 头字段（多个头会被 HeaderBag 用逗号合并）。 */
export function parseCacheControl(raw: string | null): CacheControl {
  const tokens = new Set<string>();
  const values = new Map<string, number>();
  if (raw == null) return { tokens, values };

  // 指令之间以逗号分隔；值里允许引号（RFC 的 quoted-string），
  // 简单起见按引号状态切分，避免拆开 quoted-string。
  for (let part of splitDirectives(raw)) {
    part = part.trim();
    if (part === '') continue;
    const eq = part.indexOf('=');
    let name: string;
    let value: string | undefined;
    if (eq === -1) {
      name = part;
    } else {
      name = part.slice(0, eq).trim();
      value = part.slice(eq + 1).trim();
    }
    name = name.toLowerCase();
    if (name === '') continue;

    if (value === undefined) {
      if (name === 'max-stale') {
        // max-stale 可不带值：调用方愿意接受任意过期响应。
        values.set(name, Number.POSITIVE_INFINITY);
      } else {
        tokens.add(name);
      }
      continue;
    }

    if (KNOWN_NUMERIC.has(name)) {
      const seconds = parseDeltaSeconds(value);
      if (seconds !== undefined) values.set(name, seconds);
      // 非法数值：整条指令忽略。
    } else {
      // 带值的未知扩展指令，记为 token 即可（目前没有消费方）。
      tokens.add(name);
    }
  }
  return { tokens, values };
}

function* splitDirectives(raw: string): Generator<string> {
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) {
      yield raw.slice(start, i);
      start = i + 1;
    }
  }
  yield raw.slice(start);
}

/** 便捷方法：从头容器读取并解析 Cache-Control。 */
export function cacheControlOf(headers: HeaderBag): CacheControl {
  return parseCacheControl(headers.get('cache-control'));
}

/** 解析 Age 头：合法非负整数才采纳，缺失或非法按 0。 */
export function parseAge(headers: HeaderBag): number {
  const raw = headers.get('age');
  if (raw == null) return 0;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) return 0;
  return Number(value);
}
