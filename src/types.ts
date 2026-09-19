/**
 * 库的公共类型定义与消息规范化。
 *
 * 请求/响应都不绑定任何运行时 HTTP 对象（IncomingMessage / Response / undici）：
 * 调用方从自己的网络层把方法、目标、头、状态码搬进来即可，body 是不透明的。
 */

import { HeadersLite, type HeaderInput } from './headers.js';

/** 请求方法统一大写存储。 */
export interface CacheRequest {
  method: string;
  /** 请求目标：完整 URL（scheme/host/path/query），由调用方保证规范化。 */
  target: string;
  headers: HeadersLite;
}

export interface NormalizeRequestInput {
  method?: string;
  target: string;
  headers?: HeaderInput;
}

export interface CacheResponse {
  status: number;
  headers: HeadersLite;
  /**
   * 响应体的不透明表示（Buffer / string / 解析后的对象均可）。
   * 304 合并不动它。
   */
  body?: unknown;
}

export interface NormalizeResponseInput {
  status: number;
  headers?: HeaderInput;
  body?: unknown;
}

export function normalizeRequest(input: NormalizeRequestInput): CacheRequest {
  const method = (input.method ?? 'GET').toUpperCase();
  if (!method) throw new TypeError('请求方法不能为空');
  return {
    method,
    target: input.target,
    headers: new HeadersLite(input.headers),
  };
}

export function normalizeResponse(input: NormalizeResponseInput): CacheResponse {
  return {
    status: input.status,
    headers: new HeadersLite(input.headers),
    body: input.body,
  };
}

/** 时钟：返回毫秒级 Unix 时间戳。默认实现读真实时钟，测试时可注入。 */
export type Clock = () => number;

export const realClock: Clock = () => Date.now();

/**
 * 一次请求/响应往返在本地记录的两个时刻（毫秒时间戳）：
 * - requestTime：请求发出
 * - responseTime：响应完整收到
 */
export interface RequestTiming {
  requestTime: number;
  responseTime: number;
}
