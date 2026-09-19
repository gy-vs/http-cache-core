/**
 * 消息头容器。
 *
 * 故意不使用全局 {@link Headers}：
 * - 全局 Headers 会把 header 名称规范化、折叠空白，而 Vary 选择器需要逐字节比较
 *   请求头的值（RFC 9111 4.1：按字段值选择表示）；
 * - 304 合并需要知道上游到底带没带某个字段、带了几个值；
 * - 保留原始字段名，回写给 Node http 层时更直观。
 *
 * 键统一用字段名小写存储，值保留为字符串数组（支持 Set-Cookie 等多值字段）。
 */

export type HeaderInput =
  | HeadersLite
  | Record<string, string | string[] | undefined>
  | ReadonlyArray<readonly [string, string | readonly string[]]>;

/** 一个字段名是否合法：token，且不含冒号/空白（RFC 9110 5.1）。 */
function isValidFieldName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

export class HeadersLite {
  readonly #map = new Map<string, { rawName: string; values: string[] }>();

  constructor(input?: HeaderInput) {
    if (input !== undefined) {
      if (input instanceof HeadersLite) {
        for (const [name, values] of input.entries()) {
          for (const v of values) this.append(name, v);
        }
      } else if (Array.isArray(input)) {
        for (const [name, value] of input) {
          if (Array.isArray(value)) {
            for (const v of value) this.append(name, v);
          } else {
            this.append(name, value);
          }
        }
      } else {
        for (const [name, value] of Object.entries(input)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const v of value) this.append(name, v);
          } else {
            this.set(name, value);
          }
        }
      }
    }
  }

  #checkName(name: string): void {
    if (!isValidFieldName(name)) {
      throw new TypeError(`非法的 HTTP 字段名: ${JSON.stringify(name)}`);
    }
  }

  /** 追加一个值（多值字段），空串会被当作合法的空字段值。 */
  append(name: string, value: string): void {
    this.#checkName(name);
    const key = name.toLowerCase();
    const entry = this.#map.get(key);
    if (entry) entry.values.push(value);
    else this.#map.set(key, { rawName: name, values: [value] });
  }

  /** 覆盖为单值（或显式给定的多值）。 */
  set(name: string, value: string | readonly string[]): void {
    this.#checkName(name);
    const key = name.toLowerCase();
    this.#map.set(key, {
      rawName: name,
      values: typeof value === 'string' ? [value] : [...value],
    });
  }

  /** 取单值（多值时按 RFC 9110 规则用 ", " 连接），不存在返回 null。 */
  get(name: string): string | null {
    const entry = this.#map.get(name.toLowerCase());
    return entry ? entry.values.join(', ') : null;
  }

  /** 取该字段的全部值（防御性拷贝），不存在返回空数组。 */
  getSet(name: string): string[] {
    const entry = this.#map.get(name.toLowerCase());
    return entry ? [...entry.values] : [];
  }

  has(name: string): boolean {
    return this.#map.has(name.toLowerCase());
  }

  delete(name: string): boolean {
    return this.#map.delete(name.toLowerCase());
  }

  /** 是否包含至少一个指定字段（大小写不敏感）。 */
  hasAny(...names: readonly string[]): boolean {
    return names.some((n) => this.#map.has(n.toLowerCase()));
  }

  get size(): number {
    return this.#map.size;
  }

  /** [原始字段名, 值数组][]，按插入顺序。 */
  entries(): Array<[string, string[]]> {
    return [...this.#map.values()].map(({ rawName, values }) => [
      rawName,
      [...values],
    ]);
  }

  /** 扁平化为 Node http 层接受的 [name, value][]（每值一项）。 */
  toNodeHeaders(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [name, values] of this.entries()) {
      for (const v of values) out.push([name, v]);
    }
    return out;
  }

  /** 普通对象（多值字段合并为 "a, b"，Set-Cookie 会丢值，仅用于调试）。 */
  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, values] of this.entries()) {
      out[name] = values.join(', ');
    }
    return out;
  }

  clone(): HeadersLite {
    return new HeadersLite(this);
  }

  [Symbol.iterator](): IterableIterator<[string, string[]]> {
    return this.entries()[Symbol.iterator]();
  }
}

/** 宽松地把任意头表示转成 HeadersLite。 */
export function toHeaders(input?: HeaderInput): HeadersLite {
  return input instanceof HeadersLite ? input : new HeadersLite(input);
}
