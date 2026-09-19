import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsePolicy } from '../src/policy.js';
import { FakeClock, httpDate, req, res, tx } from './helpers.js';

describe('响应年龄 RFC 9111 §4.2.3', () => {
  it('Age 头计入当前年龄', () => {
    const clock = new FakeClock();
    const p = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value), age: '30' }),
      tx(clock),
      { now: clock.now },
    );
    assert.equal(p.currentAgeSec(), 30);
    clock.advance(10_000);
    assert.equal(p.currentAgeSec(), 40);
  });

  it('往返耗时（requestTime→responseTime）计入年龄', () => {
    const clock = new FakeClock();
    const p = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value) }),
      tx(clock, 2500),
      { now: clock.now },
    );
    // apparent age 为 0，但 corrected = max(0, 0 + 2) = 2。
    assert.equal(p.currentAgeSec(), 2);
  });

  it('上游时钟比本地快 40 秒时，年龄不得为负也不得偏小', () => {
    const clock = new FakeClock();
    // 上游机器时钟快 42 秒：Date 头写的是“未来”的时间。
    const futureDate = httpDate(clock.value + 42_000);
    const p = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: futureDate }),
      tx(clock),
      { now: clock.now },
    );
    // apparent age 被钳为 0，而不是 -42；此刻驻留时间 0。
    assert.equal(p.currentAgeSec(), 0);
    clock.advance(10_000);
    // 10 秒后也只是 10 秒，而不是 -32。
    assert.equal(p.currentAgeSec(), 10);
  });

  it('Date 头缺失时用响应收到时刻兜底', () => {
    const clock = new FakeClock();
    const p = new ResponsePolicy(req('https://x/'), res(200, {}), tx(clock, 0), {
      now: clock.now,
    });
    assert.equal(p.currentAgeSec(), 0);
    clock.advance(5_000);
    assert.equal(p.currentAgeSec(), 5);
  });
});

describe('新鲜期取值优先级 §4.2.1/4.2.2', () => {
  it('共享模式 s-maxage 压过 max-age；私有模式忽略 s-maxage', () => {
    const clock = new FakeClock();
    const headers = { 'cache-control': 's-maxage=10, max-age=60' };
    const shared = new ResponsePolicy(req('https://x/'), res(200, headers), tx(clock), {
      mode: 'shared',
    });
    const priv = new ResponsePolicy(req('https://x/'), res(200, headers), tx(clock), {
      mode: 'private',
    });
    assert.equal(shared.computeFreshnessLifetime(), 10);
    assert.equal(priv.computeFreshnessLifetime(), 60);
  });

  it('Expires 与响应自己的 Date 做差，不与本地当前时间比较', () => {
    const clock = new FakeClock();
    // 上游时钟快 40 秒的场景重现：Date/Expires 都按上游时钟写，
    // max-age 缺失，只能用 Expires。
    const date = httpDate(clock.value + 40_000);
    const expires = httpDate(clock.value + 40_000 + 60_000);
    const p = new ResponsePolicy(
      req('https://x/'),
      res(200, { date, expires }),
      tx(clock),
      { now: clock.now },
    );
    assert.equal(p.computeFreshnessLifetime(), 60);
    // 刚收到时仍新鲜；即使本地时钟比 Date 落后 40 秒，
    // 剩余新鲜度也应是 60 而不是 100，且不会判为已过期。
    const d = p.evaluate(req('https://x/').headers);
    assert.equal(d.state, 'serve');
    assert.equal(d.remainingFreshnessSec, 60);
  });

  it('Expires 非法/缺失时回落到启发式，不会落得负寿命', () => {
    const clock = new FakeClock();
    const p = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value), expires: '0' }),
      tx(clock),
    );
    // "0" 不是合法 HTTP-date：视为无显式信息，走启发式（无 Last-Modified → 0）。
    assert.equal(p.computeFreshnessLifetime(), 0);
  });

  it('启发式：Date - Last-Modified 的 10%，并受 24h 上限兜底', () => {
    const clock = new FakeClock();
    const lastModified = httpDate(clock.value - 1000_000); // 1000 秒前
    const p = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value), 'last-modified': lastModified }),
      tx(clock),
    );
    assert.equal(p.computeFreshnessLifetime(), 100);

    // 远超上限的间隔：被 24h 截断。
    const old = new ResponsePolicy(
      req('https://x/'),
      res(200, {
        date: httpDate(clock.value),
        'last-modified': httpDate(clock.value - 100 * 24 * 3600 * 1000),
      }),
      tx(clock),
    );
    assert.equal(old.computeFreshnessLifetime(), 24 * 3600);
  });

  it('启发式参数可配置', () => {
    const clock = new FakeClock();
    const p = new ResponsePolicy(
      req('https://x/'),
      res(200, {
        date: httpDate(clock.value),
        'last-modified': httpDate(clock.value - 1000_000),
      }),
      tx(clock),
      { heuristicCoefficient: 0.5, heuristicMaxLifetimeSec: 300 },
    );
    assert.equal(p.computeFreshnessLifetime(), 300);
  });
});

describe('请求侧新鲜度指令 §5.2.1', () => {
  function cached(maxAge: number) {
    const clock = new FakeClock();
    const policy = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value), 'cache-control': `max-age=${maxAge}` }),
      tx(clock),
      { now: clock.now },
    );
    return { clock, policy };
  }

  it('max-age 让本来新鲜的响应不可用', () => {
    const { clock, policy } = cached(100);
    clock.advance(50_000);
    assert.equal(policy.evaluate({ 'cache-control': 'max-age=40' }).state, 'revalidate');
    assert.equal(policy.evaluate({ 'cache-control': 'max-age=60' }).state, 'serve');
  });

  it('min-fresh 要求剩余新鲜度至少为给定值', () => {
    const { clock, policy } = cached(100);
    clock.advance(50_000);
    assert.equal(policy.evaluate({ 'cache-control': 'min-fresh=60' }).state, 'revalidate');
    assert.equal(policy.evaluate({ 'cache-control': 'min-fresh=50' }).state, 'serve');
  });

  it('max-stale 让过期响应仍可用；无值表示任意时长', () => {
    const { clock, policy } = cached(100);
    clock.advance(110_000);
    assert.equal(policy.evaluate({}).state, 'revalidate');
    assert.equal(policy.evaluate({ 'cache-control': 'max-stale=5' }).state, 'revalidate');
    assert.equal(policy.evaluate({ 'cache-control': 'max-stale=10' }).state, 'stale-serve');
    assert.equal(policy.evaluate({ 'cache-control': 'max-stale' }).state, 'stale-serve');
  });

  it('no-cache 强制再验证；max-stale 也不能放行', () => {
    const { policy } = cached(100);
    const d = policy.evaluate({ 'cache-control': 'no-cache, max-stale=9999' });
    assert.equal(d.state, 'revalidate');
    assert.equal(d.reason, 'request-no-cache');
  });

  it('only-if-cached：新鲜可给；需要验证时给 gateway-timeout 而不是 miss', () => {
    const { clock, policy } = cached(100);
    assert.equal(policy.evaluate({ 'cache-control': 'only-if-cached' }).state, 'serve');
    clock.advance(200_000);
    assert.equal(policy.evaluate({ 'cache-control': 'only-if-cached' }).state, 'gateway-timeout');
    // 但配合 max-stale 仍可给陈旧副本。
    assert.equal(
      policy.evaluate({ 'cache-control': 'only-if-cached, max-stale=9999' }).state,
      'stale-serve',
    );
  });

  it('only-if-cached：新鲜但不满足 max-age / 响应 no-cache / 仅在 SWR 窗口内，都给 504', () => {
    const { clock, policy } = cached(100);
    clock.advance(50_000);
    assert.equal(
      policy.evaluate({ 'cache-control': 'only-if-cached, max-age=10' }).state,
      'gateway-timeout',
    );

    const noCachePolicy = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value), 'cache-control': 'no-cache, max-age=100' }),
      tx(clock),
      { now: clock.now },
    );
    assert.equal(
      noCachePolicy.evaluate({ 'cache-control': 'only-if-cached' }).state,
      'gateway-timeout',
    );

    // 新鲜度刚过期、无 max-stale：即使内核支持 SWR 也不得联系上游。
    clock.advance(60_000);
    const swrPolicy = new ResponsePolicy(
      req('https://x/'),
      res(200, {
        date: httpDate(clock.value - 110_000),
        'cache-control': 'max-age=100, stale-while-revalidate=60',
      }),
      tx(clock),
      { now: clock.now },
    );
    assert.equal(
      swrPolicy.evaluate({ 'cache-control': 'only-if-cached' }).state,
      'gateway-timeout',
    );
  });

  it('must-revalidate：过期后必须再验证；但请求 max-stale 可覆盖该禁止', () => {
    const clock = new FakeClock();
    const policy = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value), 'cache-control': 'max-age=10, must-revalidate' }),
      tx(clock),
      { now: clock.now },
    );
    clock.advance(20_000);
    const forced = policy.evaluate({});
    assert.equal(forced.state, 'revalidate');
    assert.equal(forced.reason, 'must-revalidate');

    // RFC 9111 §4.2.4：客户端显式 max-stale 时可以接受陈旧副本。
    const tolerated = policy.evaluate({ 'cache-control': 'max-stale=9999' });
    assert.equal(tolerated.state, 'stale-serve');
  });

  it('响应 no-cache：存得下，但每次使用前必须再验证', () => {
    const clock = new FakeClock();
    const decision = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value), 'cache-control': 'no-cache, max-age=60' }),
      tx(clock),
      { now: clock.now },
    ).canStore();
    assert.equal(decision.storable, true);
    assert.equal(decision.mustRevalidateBeforeUse, true);
    const policy = new ResponsePolicy(
      req('https://x/'),
      res(200, { date: httpDate(clock.value), 'cache-control': 'no-cache, max-age=60' }),
      tx(clock),
      { now: clock.now },
    );
    assert.equal(policy.evaluate({}).state, 'revalidate');
    assert.equal(policy.evaluate({}).reason, 'response-no-cache');
  });
});
