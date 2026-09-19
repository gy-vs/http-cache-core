import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAgeState,
  currentAge,
  freshnessLifetime,
  heuristicLifetime,
  createVariant,
  decideStorage,
  evaluate,
} from '../src/policy.js';
import { T0, req, res, httpDate } from './helpers.js';
import { normalizeRequest, normalizeResponse } from '../src/types.js';

const opts = { mode: 'shared' as const };

test('新鲜期优先级：共享缓存 s-maxage > max-age > Expires > 启发式', () => {
  const both = freshnessLifetime(
    normalizeResponse(
      res(200, {
        'cache-control': 'max-age=100, s-maxage=200',
        expires: httpDate(T0 + 500_000),
        date: httpDate(T0),
      }),
    ),
    opts,
  );
  assert.equal(both.source, 's-maxage');
  assert.equal(both.lifetimeMs, 200_000);

  const onlyMaxAge = freshnessLifetime(
    normalizeResponse(
      res(200, { 'cache-control': 'max-age=100', expires: httpDate(T0 + 500_000), date: httpDate(T0) }),
    ),
    opts,
  );
  assert.equal(onlyMaxAge.source, 'max-age');
  assert.equal(onlyMaxAge.lifetimeMs, 100_000);

  const expires = freshnessLifetime(
    normalizeResponse(res(200, { expires: httpDate(T0 + 300_000), date: httpDate(T0) })),
    opts,
  );
  assert.equal(expires.source, 'expires');
  assert.equal(expires.lifetimeMs, 300_000);
});

test('私有缓存忽略 s-maxage', () => {
  const fl = freshnessLifetime(
    normalizeResponse(res(200, { 'cache-control': 'max-age=100, s-maxage=200' })),
    { mode: 'private' },
  );
  assert.equal(fl.source, 'max-age');
  assert.equal(fl.lifetimeMs, 100_000);
});

test('Expires 与响应自己的 Date 做差，不受本地当前时间影响（时钟偏快 40s 事故场景）', () => {
  // 上游时钟比本地快 45 秒：Date/Expires 都来自上游时钟。
  const upstreamOffset = 45_000;
  const dateValue = T0 + upstreamOffset;
  const response = normalizeResponse(
    res(200, {
      date: httpDate(dateValue),
      expires: httpDate(dateValue + 60_000),
    }),
  );
  const fl = freshnessLifetime(response, opts, T0);
  assert.equal(fl.source, 'expires');
  // 新鲜期必须是 60s，而不是 60-45=15s，也不是 105s
  assert.equal(fl.lifetimeMs, 60_000);

  // 响应在 T0（本地时间）收到。收到 30 秒后，仍然新鲜（60s 新鲜期只走了 30s）。
  const variant = createVariant({
    request: normalizeRequest(req('https://x/a')),
    response,
    requestTime: T0,
    responseTime: T0,
  });
  const ev = evaluate({ variant, request: normalizeRequest(req('https://x/a')), now: T0 + 30_000 });
  assert.equal(ev.status, 'fresh');
});

test('年龄：上游时钟偏快时年龄不会被算成负数或偏小，Age 头计入', () => {
  const response = normalizeResponse(
    res(200, {
      date: httpDate(T0 + 45_000), // 上游快 45 秒
      'cache-control': 'max-age=60',
      age: '10',
    }),
  );
  const state = computeAgeState(response, { requestTime: T0, responseTime: T0 + 200 });
  // apparent_age 被钳为 0；age_value=10s 再补本地 200ms 往返 -> 10200ms
  assert.equal(state.initialAge, 10_200);

  // 30 个「墙钟秒」后：resident 从收到时刻 T0+200 起算，过了 29.8s；
  // 年龄 = 10.2 + 29.8 = 40s。关键是绝不会被算成负数。
  assert.equal(currentAge(state.initialAge, state.ageBaseTime, T0 + 30_000), 40_000);
});

test('年龄：上游时钟偏慢时 apparent age 体现偏差，年龄不会偏小', () => {
  const response = normalizeResponse(
    res(200, {
      date: httpDate(T0 - 30_000), // 上游慢 30 秒
      'cache-control': 'max-age=120',
    }),
  );
  const state = computeAgeState(response, { requestTime: T0, responseTime: T0 });
  assert.equal(state.initialAge, 30_000);
});

test('请求发出到响应收到的往返时间计入年龄', () => {
  const response = normalizeResponse(
    res(200, { date: httpDate(T0), 'cache-control': 'max-age=60' }),
  );
  const state = computeAgeState(response, { requestTime: T0, responseTime: T0 + 800 });
  assert.equal(state.initialAge, 800);
});

test('Date 头缺失时以 responseTime 兜底，年龄仍不为负', () => {
  const response = normalizeResponse(res(200, { 'cache-control': 'max-age=60' }));
  const state = computeAgeState(response, { requestTime: T0, responseTime: T0 + 100 });
  assert.equal(state.initialAge, 100);
});

test('启发式新鲜期：Last-Modified 与 Date 间隔的 10%，默认上限 24h', () => {
  const tenMinutes = 10 * 60_000;
  const r1 = normalizeResponse(
    res(200, { date: httpDate(T0), 'last-modified': httpDate(T0 - tenMinutes) }),
  );
  assert.equal(heuristicLifetime(r1, opts), tenMinutes * 0.1);

  // 间隔一年 -> 被 24h 上限截断
  const r2 = normalizeResponse(
    res(200, { date: httpDate(T0), 'last-modified': httpDate(T0 - 365 * 24 * 3600_000) }),
  );
  assert.equal(heuristicLifetime(r2, opts), 24 * 3600_000);

  // 可配置比例与上下限
  assert.equal(
    heuristicLifetime(r1, {
      mode: 'shared',
      heuristic: { ratio: 0.5, maxLifetimeMs: 1000 },
    }),
    1000,
  );
});

test('启发式：没有 Last-Modified 时新鲜期为 0（立即过期，但仍可存/再验证）', () => {
  const r = normalizeResponse(res(200, { date: httpDate(T0) }));
  assert.equal(heuristicLifetime(r, opts), 0);
  const d = decideStorage(
    {
      request: normalizeRequest(req('https://x/a')),
      response: r,
      requestTime: T0,
      responseTime: T0,
    },
    opts,
  );
  assert.equal(d.storable, true);
  assert.equal(d.freshForMs, 0);
});

test('过期后 evaluate 要求再验证', () => {
  const variant = createVariant({
    request: normalizeRequest(req('https://x/a')),
    response: normalizeResponse(
      res(200, { date: httpDate(T0), 'cache-control': 'max-age=60' }),
    ),
    requestTime: T0,
    responseTime: T0,
  });
  assert.equal(
    evaluate({ variant, request: normalizeRequest(req('https://x/a')), now: T0 + 61_000 }).status,
    'stale-revalidate',
  );
});

test('must-revalidate：过期后即使 max-stale 也必须再验证', () => {
  const variant = createVariant({
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'max-stale=100' })),
    response: normalizeResponse(
      res(200, {
        date: httpDate(T0),
        'cache-control': 'max-age=60, must-revalidate',
      }),
    ),
    requestTime: T0,
    responseTime: T0,
  });
  const ev = evaluate({
    variant,
    request: normalizeRequest(req('https://x/a', { 'cache-control': 'max-stale=100' })),
    now: T0 + 70_000,
  });
  assert.equal(ev.status, 'stale-revalidate');
  assert.equal(ev.serve, false);
});
