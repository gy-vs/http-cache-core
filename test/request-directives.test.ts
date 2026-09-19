import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVariant, evaluate } from '../src/policy.js';
import { T0, req, res, httpDate } from './helpers.js';
import { normalizeRequest, normalizeResponse } from '../src/types.js';

function variantAt(lifetimeSec: number, extraCc = '') {
  const cc = `max-age=${lifetimeSec}${extraCc ? ', ' + extraCc : ''}`;
  return createVariant({
    request: normalizeRequest(req('https://x/a')),
    response: normalizeResponse(res(200, { date: httpDate(T0), 'cache-control': cc })),
    requestTime: T0,
    responseTime: T0,
  });
}

test('请求 no-cache：响应即使新鲜也强制再验证', () => {
  const variant = variantAt(60);
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'no-cache' })),
    now: T0 + 1000,
  });
  assert.equal(ev.status, 'stale-revalidate');
  assert.equal(ev.revalidate, true);
  assert.equal(ev.serve, false);
});

test('Pragma: no-cache 在没有 Cache-Control 时等价于 no-cache', () => {
  const variant = variantAt(60);
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { pragma: 'no-cache' })),
    now: T0 + 1000,
  });
  assert.equal(ev.revalidate, true);

  // 有 Cache-Control 时 Pragma 不再生效
  const ev2 = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', {
      pragma: 'no-cache',
      'cache-control': 'max-age=120',
    })),
    now: T0 + 1000,
  });
  assert.equal(ev2.status, 'fresh');
});

test('请求 max-age 让本来新鲜的响应不可用（年龄超限 -> unusable，直接转发）', () => {
  const variant = variantAt(60);
  // 当前年龄 10s，客户端只接受 age<=0
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'max-age=0' })),
    now: T0 + 10_000,
  });
  assert.equal(ev.status, 'unusable');
  assert.equal(ev.serve, false);
});

test('请求 min-fresh 要求比新鲜期更多的余量', () => {
  const variant = variantAt(60);
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'min-fresh=120' })),
    now: T0 + 10_000, // 还剩 50s 新鲜，不够 120s
  });
  assert.equal(ev.status, 'unusable');
});

test('max-stale 让过期不久的响应仍可直接用（但不触发后台再验证）', () => {
  const variant = variantAt(60);
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'max-stale=30' })),
    now: T0 + 75_000, // 过期 15s，在 30s 容忍内
  });
  assert.equal(ev.status, 'stale-serve');
  assert.equal(ev.serve, true);
  assert.equal(ev.backgroundRevalidate, false);
});

test('裸 max-stale 表示愿意接受任意过期程度', () => {
  const variant = variantAt(60);
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'max-stale' })),
    now: T0 + 3600_000,
  });
  assert.equal(ev.status, 'stale-serve');
  assert.equal(ev.serve, true);
});

test('max-stale 容忍窗口外则仍需再验证', () => {
  const variant = variantAt(60);
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'max-stale=10' })),
    now: T0 + 75_000, // 过期 15s > 10s
  });
  assert.equal(ev.status, 'stale-revalidate');
});

test('only-if-cached：新鲜副本直接给；没有可用副本时给 gateway-timeout（504）', () => {
  const variant = variantAt(60);
  const ok = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'only-if-cached' })),
    now: T0 + 1000,
  });
  assert.equal(ok.status, 'fresh');

  // 过期且没有 max-stale / SWR
  const timeout = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'only-if-cached' })),
    now: T0 + 61_000,
  });
  assert.equal(timeout.status, 'gateway-timeout');
  assert.equal(timeout.gatewayTimeout, true);
  assert.equal(timeout.serve, false);
});

test('only-if-cached + no-cache：不能发请求也不能用未验证副本 -> 504', () => {
  const variant = variantAt(60);
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', {
      'cache-control': 'only-if-cached, no-cache',
    })),
    now: T0 + 1000,
  });
  assert.equal(ev.status, 'gateway-timeout');
});

test('only-if-cached 下 max-stale 窗口内的过期响应仍然可用', () => {
  const variant = variantAt(60);
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', {
      'cache-control': 'only-if-cached, max-stale=60',
    })),
    now: T0 + 90_000,
  });
  assert.equal(ev.status, 'stale-serve');
});

test('响应侧 no-cache：存得下来，但每次使用前必须再验证', () => {
  const variant = createVariant({
    request: normalizeRequest(req('https://x/a')),
    response: normalizeResponse(
      res(200, { date: httpDate(T0), 'cache-control': 'no-cache, max-age=60' }),
    ),
    requestTime: T0,
    responseTime: T0,
  });
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a')),
    now: T0 + 1000,
  });
  assert.equal(ev.status, 'stale-revalidate');
  assert.ok(ev.reasons.includes('response-no-cache'));
});
