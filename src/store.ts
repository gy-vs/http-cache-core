/**
 * 缓存存储层。
 *
 * 这里只定义「按 key 存、key 内部再按 Vary 选择器存多份」的最小接口，
 * 语义层（src/cache.ts）负责调它。默认提供一个内存 + LRU 实现；
 * 以后要接 Redis / SQLite，实现同一个接口替换进来即可，网络与落盘逻辑
 * 不会渗进策略内核。
 */

import type { StoredVariant } from './policy.js';

/** 条目键：方法 + 目标。 */
export interface EntryKey {
  method: string;
  target: string;
}

export function compositeKey(method: string, target: string): string {
  // 方法是 token（不含空格），空格做分隔符无碰撞风险。
  return `${method} ${target}`;
}

export function parseCompositeKey(key: string): EntryKey {
  const sp = key.indexOf(' ');
  if (sp === -1) return { method: key, target: '' };
  return { method: key.slice(0, sp), target: key.slice(sp + 1) };
}

/**
 * 同一个请求目标下可以并存多份不同 Vary 选择器的表示。
 */
export interface CacheEntry {
  key: EntryKey;
  /** 选择器键 -> variant */
  variants: Map<string, StoredVariant>;
  /** 该条目最近一次命中/写入的时间，供全局 LRU 使用 */
  lastUsedAt: number;
}

export type StoreEventReason = 'set' | 'delete' | 'evict' | 'variant-evict';

export interface StoreEvent {
  reason: StoreEventReason;
  key: EntryKey;
  selector?: string;
}

export interface CacheStore {
  /** 取整条（不存在返回 null）。命中读取会更新 LRU 顺序。 */
  get(key: EntryKey, now?: number): CacheEntry | null;
  /** 写整条（新 key 或已有 key 都会刷新 LRU 顺序）。 */
  set(entry: CacheEntry, now: number): void;
  /** 删整条，返回是否存在。 */
  delete(key: EntryKey): boolean;
  /** 条目数。 */
  size(): number;
  /** 清空。 */
  clear(): void;
  /**
   * 写入一个 Vary 变体。同选择器覆盖（200 全量替换），新选择器并存；
   * 变体数超限时自行淘汰该条目内最久未用的变体。
   */
  putVariant(
    key: EntryKey,
    selector: string,
    variant: StoredVariant,
    now: number,
  ): void;
  /** 按选择器取变体，命中刷新 LRU；不存在返回 null。 */
  getVariant(key: EntryKey, selector: string, now: number): StoredVariant | null;
  /** 删除单个变体；变体清空后整条移除。 */
  deleteVariant(key: EntryKey, selector: string): boolean;
  /** 标记某个变体刚被命中（刷新变体级 LRU 顺序）。 */
  touchVariant(entry: CacheEntry, selector: string, now: number): void;
}

export interface MemoryStoreOptions {
  /** 全局条目（method+target 粒度）上限，默认 1000。 */
  maxEntries?: number;
  /** 单个目标下 Vary 变体数上限，默认 64。 */
  maxVariantsPerEntry?: number;
  /** 淘汰/删除事件回调（打指标用）。 */
  onEvent?: (event: StoreEvent) => void;
}

/**
 * 基于插入/访问顺序 Map 的内存 LRU：
 * - 访问或写入一个条目时把它挪到 Map 末尾；
 * - 超出 maxEntries 时从头部整条淘汰（其下所有 Vary 变体一起走）；
 * - 单条目变体数超 maxVariantsPerEntry 时，淘汰该条目内最久没命中的变体。
 */
export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, CacheEntry>();
  readonly maxEntries: number;
  readonly maxVariantsPerEntry: number;
  readonly #onEvent?: (event: StoreEvent) => void;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.maxVariantsPerEntry = options.maxVariantsPerEntry ?? 64;
    this.#onEvent = options.onEvent;
    if (this.maxEntries < 1) throw new RangeError('maxEntries 必须 >= 1');
    if (this.maxVariantsPerEntry < 1) {
      throw new RangeError('maxVariantsPerEntry 必须 >= 1');
    }
  }

  #emit(reason: StoreEventReason, key: EntryKey, selector?: string): void {
    this.#onEvent?.({ reason, key, selector });
  }

  get(key: EntryKey, now?: number): CacheEntry | null {
    const ck = compositeKey(key.method, key.target);
    const entry = this.#entries.get(ck);
    if (!entry) return null;
    // 刷新 LRU 顺序
    this.#entries.delete(ck);
    if (now !== undefined) entry.lastUsedAt = now;
    this.#entries.set(ck, entry);
    return entry;
  }

  set(entry: CacheEntry, now: number): void {
    const ck = compositeKey(entry.key.method, entry.key.target);
    entry.lastUsedAt = now;
    this.#entries.delete(ck);
    this.#entries.set(ck, entry);
    this.#trim();
  }

  delete(key: EntryKey): boolean {
    const ck = compositeKey(key.method, key.target);
    const existed = this.#entries.delete(ck);
    if (existed) this.#emit('delete', key);
    return existed;
  }

  size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** 单条目变体 LRU：variantMap 的插入顺序即最近使用顺序。 */
  touchVariant(entry: CacheEntry, selector: string, now: number): void {
    const v = entry.variants.get(selector);
    if (!v) return;
    entry.variants.delete(selector);
    entry.variants.set(selector, v);
    entry.lastUsedAt = now;
  }

  /**
   * 写入一个变体。同选择器覆盖（比如 200 全量替换），新选择器并存。
   * 变体超限时淘汰该条目最久没用的另一个变体，而不是覆盖。
   */
  putVariant(
    key: EntryKey,
    selector: string,
    variant: StoredVariant,
    now: number,
  ): void {
    const ck = compositeKey(key.method, key.target);
    let entry = this.#entries.get(ck);
    if (!entry) {
      entry = { key, variants: new Map(), lastUsedAt: now };
    }
    if (entry.variants.has(selector)) {
      entry.variants.set(selector, variant);
    } else {
      entry.variants.set(selector, variant);
      if (entry.variants.size > this.maxVariantsPerEntry) {
        // Map 迭代顺序 = 插入顺序，第一个就是最久没命中的
        const oldest = entry.variants.keys().next().value as string | undefined;
        if (oldest !== undefined && oldest !== selector) {
          entry.variants.delete(oldest);
          this.#emit('variant-evict', key, oldest);
        }
      }
    }
    this.set(entry, now);
  }

  /** 按选择器取变体，命中会刷新变体与条目两级 LRU。 */
  getVariant(
    key: EntryKey,
    selector: string,
    now: number,
  ): StoredVariant | null {
    const entry = this.get(key, now);
    if (!entry) return null;
    const variant = entry.variants.get(selector);
    if (!variant) return null;
    this.touchVariant(entry, selector, now);
    return variant;
  }

  /** 按选择器删除单个变体；变体清空后整条移除。 */
  deleteVariant(key: EntryKey, selector: string): boolean {
    const ck = compositeKey(key.method, key.target);
    const entry = this.#entries.get(ck);
    if (!entry) return false;
    const deleted = entry.variants.delete(selector);
    if (entry.variants.size === 0) {
      this.#entries.delete(ck);
      this.#emit('delete', key);
    } else if (deleted) {
      this.#emit('delete', key, selector);
    }
    return deleted;
  }

  #trim(): void {
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      if (entry) this.#emit('evict', entry.key);
    }
  }
}
