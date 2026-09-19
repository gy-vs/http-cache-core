import type { HeadersLike } from './types.js';

/**
 * 头字段的内部表示。
 *
 * HTTP 头字段名不区分大小写，字段值按 RFC 9110 用逗号即可合并
 * （多值头之间的 OWS 在语义判定里无所谓，所以这里合并时不额外加空格，
 * Vary 解析时会自行做 trim）。
 * 内部始终以小写名保留每一个 [name, value]，重复字段不丢值。
 */
export class HeaderBag {
  private readonly entries: [string, string][] = [];

  private constructor(entries: [string, string][]) {
    this.entries = entries;
  }

  static from(input: HeadersLike | undefined | null): HeaderBag {
    const out: [string, string][] = [];
    if (input == null) return new HeaderBag(out);

    if (typeof Headers !== 'undefined' && input instanceof Headers) {
      input.forEach((value, key) => {
        out.push([key.toLowerCase(), value]);
      });
      return new HeaderBag(out);
    }

    if (Array.isArray(input)) {
      for (const pair of input) {
        out.push([pair[0].toLowerCase(), pair[1]]);
      }
      return new HeaderBag(out);
    }

    // Record<string, string>。原生 Headers 已在上面分支处理。
    for (const [key, value] of Object.entries(input)) {
      out.push([key.toLowerCase(), String(value)]);
    }
    return new HeaderBag(out);
  }

  /** 返回该字段名的所有值（按出现顺序，名字大小写不敏感）。 */
  valuesOf(name: string): string[] {
    const lower = name.toLowerCase();
    const out: string[] = [];
    for (const [n, v] of this.entries) {
      if (n === lower) out.push(v);
    }
    return out;
  }

  /** 取单个字段值；同名出现多次时按 RFC 9110 规则用逗号合并，不存在返回 null。 */
  get(name: string): string | null {
    const values = this.valuesOf(name);
    return values.length === 0 ? null : values.join(',');
  }

  has(name: string): boolean {
    const lower = name.toLowerCase();
    return this.entries.some(([n]) => n === lower);
  }

  /** 转成 [name, value] 数组；默认输出小写名，可指定保留原始大小写的形态。 */
  toEntries(preserveCase?: [string, string][]): [string, string][] {
    if (!preserveCase) return this.entries.map(([n, v]) => [n, v] as [string, string]);
    // 用一份原始大小写的映射还原名字（目前仅用于回灌给调用方的场景）。
    const caseByLower = new Map<string, string>();
    for (const [n] of preserveCase) caseByLower.set(n.toLowerCase(), n);
    return this.entries.map(([n, v]) => [caseByLower.get(n) ?? n, v] as [string, string]);
  }

  /**
   * 输出新的 [name, value] 数组，删除指定字段（名字大小写不敏感）。
   * 本对象不可变视角，不做就地修改。
   */
  without(names: readonly string[]): [string, string][] {
    const blocked = new Set(names.map((n) => n.toLowerCase()));
    return this.entries.filter(([n]) => !blocked.has(n));
  }

  /** 遍历入口。 */
  *[Symbol.iterator](): IterableIterator<[string, string]> {
    for (const entry of this.entries) yield entry;
  }
}

/**
 * 解析 Vary 头，返回去重、小写化后的头字段名列表。
 * 任何一个字段名是 "*" 则直接返回 { wildcard: true }。
 */
export function parseVary(headers: HeaderBag): { wildcard: boolean; names: string[] } {
  const raw = headers.get('vary');
  if (raw == null) return { wildcard: false, names: [] };
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (name === '*') return { wildcard: true, names: [] };
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return { wildcard: false, names };
}

/**
 * 判断一份新请求的 Vary 选择头是否与落库时记录的选择头一致。
 * selected 是落库响应对应请求里 Vary 所列头的值；按 RFC 9111 的
 * 语义用字节级比较（比较前做 trim），不做 ABNF 级别的白空格归一化。
 */
export function varyMatches(
  names: string[],
  storedRequestHeaders: HeaderBag,
  newRequestHeaders: HeaderBag,
): boolean {
  for (const name of names) {
    const oldValue = storedRequestHeaders.get(name);
    const newValue = newRequestHeaders.get(name);
    const oldNorm = oldValue == null ? null : oldValue.trim();
    const newNorm = newValue == null ? null : newValue.trim();
    if (oldNorm !== newNorm) return false;
  }
  return true;
}

/**
 * 从一组请求头里取出 Vary 选择头，生成稳定标识；
 * 用于同一主键下区分多个变体。wildcard 条目用随机标识，永不命中。
 */
export function variantId(names: string[], requestHeaders: HeaderBag): string {
  return names
    .map((name) => {
      const value = requestHeaders.get(name);
      return `${name}= ${value == null ? '' : value.trim()}`;
    })
    .join('');
}
