/**
 * Vary 处理（RFC 9111 4.1）。
 *
 * 存储时：解析响应 Vary 头里列出的请求头名，把当时请求中这些头的原始值
 * 一起存为「选择器」。
 * 命中时：用新请求的同名头重新生成选择器，与存下来的逐字节比较。
 * Vary: * 表示缓存不能用任何请求命中该表示。
 */

import type { HeadersLite } from './headers.js';

/** 解析 Vary 头，返回去重后的小写字段名列表；"*" 单独以星号标记。 */
export interface VarySpec {
  wildcard: boolean;
  fields: string[]; // 小写、去重、保持出现顺序
}

export function parseVary(headers: HeadersLite): VarySpec {
  const raw = headers.get('vary');
  const fields: string[] = [];
  let wildcard = false;
  if (raw !== null) {
    for (const part of raw.split(',')) {
      const name = part.trim().toLowerCase();
      if (!name) continue;
      if (name === '*') {
        wildcard = true;
        continue;
      }
      if (!fields.includes(name)) fields.push(name);
    }
  }
  return { wildcard, fields };
}

/**
 * 生成选择器键。缺失的头编码为 []，空值头编码为 [""]，两者在选择器里
 * 可区分（RFC 9111 4.1 按字段值选择表示）。字段值数组用 JSON 转义，
 * 避免值里混入分隔符造成碰撞。
 */
export function selectorKey(fields: readonly string[], requestHeaders: HeadersLite): string {
  if (fields.length === 0) return '';
  return fields
    .map((f) => `${f}=${JSON.stringify(requestHeaders.getSet(f))}`)
    .join('&');
}

/**
 * 判断某个已存表示是否可以服务当前请求。
 * 返回 true 表示命中；false 表示 Vary 不匹配（调用方应把新响应存为另一份，
 * 而不是覆盖旧的）。
 */
export function varyMatches(
  spec: VarySpec,
  storedSelector: string,
  newRequestHeaders: HeadersLite,
): boolean {
  if (spec.wildcard) return false;
  return selectorKey(spec.fields, newRequestHeaders) === storedSelector;
}
