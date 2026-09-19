import type { CacheEntry } from './types.js';

/**
 * 缓存主键。
 *
 * 由请求方法与目标 URI 构成；同一主键下的 Vary 变体由 Cache 层
 * 自行选择，存储后端不感知 Vary 语义。
 */
export interface CacheKey {
  method: string;
  url: string;
}

export function primaryKey(key: CacheKey): string {
  return `${key.method.toUpperCase()} ${key.url}`;
}

/**
 * 存储后端接口。
 *
 * 语义内核自带一个内存 LRU 实现；要换成 Redis / SQLite / 共享内存等
 * 后端时实现这个接口即可。所有方法都是同步的 —— 如果后端是异步的，
 * 在适配层里做缓存/预取，或者把内核整体包一层 Promise。
 *
 * 一个“位置”（slot）对应一个主键下的一个 Vary 变体；
 * LRU 按 slot 计数与淘汰。
 */
export interface CacheStore {
  /** 取一个具体变体。 */
  get(primary: string, variant: string): CacheEntry | undefined;
  /**
   * 写入/覆盖一个变体。写入即视为“最近使用”。
   * 超出容量时由实现负责淘汰最久未用的 slot。
   */
  set(primary: string, variant: string, entry: CacheEntry): void;
  /** 删除一个变体；返回是否曾存在。 */
  delete(primary: string, variant: string): boolean;
  /** 删除一个主键下的全部变体（例如响应的 Vary 集合发生变化时）。 */
  deleteByPrimary(primary: string): void;
  /**
   * 列出一个主键下的全部变体；顺序不做要求（内核会自行挑选匹配项）。
   * 读取不改变 LRU 顺序；命中后内核会显式调用 touch。
   */
  listVariants(primary: string): { variant: string; entry: CacheEntry }[];
  /** 标记某个变体刚被使用（命中、写入都会调用）。 */
  touch(primary: string, variant: string): void;
  /** 清空整个缓存。 */
  clear(): void;
  /** 当前 slot 总数。 */
  readonly size: number;
}

export interface MemoryStoreOptions {
  /**
   * slot 数量上限，默认 1000；设为 0 表示不限制。
   * 超限时按最近最少使用淘汰（Map 的插入顺序即 LRU 顺序）。
   */
  maxEntries?: number;
}

/**
 * 基于 Map 的进程内 LRU 存储。
 *
 * 复合键用 NUL 字符分隔 `primary <NUL> variant`：合法 HTTP 方法/URL
 * 与变体标识里都不会出现 NUL，因此不会撞键。Map 的迭代顺序是插入
 * 顺序，set/touch 命中时删掉重建即可把条目提到最新，队首即最久未用。
 */
export class MemoryStore implements CacheStore {
  private static readonly SEP = '\u0000';
  private readonly slots = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
  }

  get size(): number {
    return this.slots.size;
  }

  private static slotKey(primary: string, variant: string): string {
    return primary + MemoryStore.SEP + variant;
  }

  private static primaryPrefix(primary: string): string {
    return primary + MemoryStore.SEP;
  }

  get(primary: string, variant: string): CacheEntry | undefined {
    return this.slots.get(MemoryStore.slotKey(primary, variant));
  }

  set(primary: string, variant: string, entry: CacheEntry): void {
    const key = MemoryStore.slotKey(primary, variant);
    // 已存在先删除，保证落到 LRU 队尾（最新）。
    this.slots.delete(key);
    this.slots.set(key, entry);
    this.evictIfNeeded();
  }

  delete(primary: string, variant: string): boolean {
    return this.slots.delete(MemoryStore.slotKey(primary, variant));
  }

  deleteByPrimary(primary: string): void {
    const prefix = MemoryStore.primaryPrefix(primary);
    for (const key of [...this.slots.keys()]) {
      if (key.startsWith(prefix)) this.slots.delete(key);
    }
  }

  listVariants(primary: string): { variant: string; entry: CacheEntry }[] {
    const prefix = MemoryStore.primaryPrefix(primary);
    const out: { variant: string; entry: CacheEntry }[] = [];
    for (const [key, entry] of this.slots) {
      if (!key.startsWith(prefix)) continue;
      out.push({ variant: key.slice(prefix.length), entry });
    }
    return out;
  }

  touch(primary: string, variant: string): void {
    const key = MemoryStore.slotKey(primary, variant);
    const entry = this.slots.get(key);
    if (entry !== undefined) {
      this.slots.delete(key);
      this.slots.set(key, entry);
    }
  }

  clear(): void {
    this.slots.clear();
  }

  private evictIfNeeded(): void {
    if (this.maxEntries <= 0) return;
    // Map 最早插入的条目就是 LRU 队首。
    while (this.slots.size > this.maxEntries) {
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) break;
      this.slots.delete(oldest);
    }
  }
}
