import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../src/cache.js';
import { FakeClock, httpDate, req, res, tx } from './helpers.js';

/**
 * 事故回归：上游机器时钟比本地快 40 多秒，旧实现拿 Expires 与本地
 * 当前时间直接比较，响应提前 40 秒被判过期，命中率从 70% 掉到 30%。
 * 本库用 Expires - 响应自身 Date 得到新鲜期，时钟偏差被吸收。
 */
describe('事故回归：Expires + 上游时钟超前', () => {
  it('上游时钟快 42 秒时，60 秒新鲜期的响应在收到后 50 秒仍命中', () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });

    // 上游时钟整体超前 42 秒：Date 和 Expires 都写在上游时间轴上，
    // 两者相差正好 60 秒。
    const upstreamBiasMs = 42_000;
    const date = httpDate(clock.value + upstreamBiasMs);
    const expires = httpDate(clock.value + upstreamBiasMs + 60_000);

    cache.put({
      request: req('https://upstream/slow-clock'),
      response: res(200, { date, expires }, 'PAYLOAD'),
      times: tx(clock),
    });

    const hitsAt = (elapsedMs: number) => {
      clock.advance(elapsedMs === 0 ? 0 : elapsedMs - last[0]);
      last[0] = elapsedMs;
      return cache.match(req('https://upstream/slow-clock')).kind === 'serve';
    };
    const last = [0];

    assert.equal(hitsAt(0), true);
    assert.equal(hitsAt(30_000), true);
    assert.equal(hitsAt(50_000), true, '剩余 10 秒时仍应命中（旧实现此刻已过期）');
    assert.equal(hitsAt(59_000), true);
    assert.equal(hitsAt(61_000), false, '超过真实新鲜期后才转为再验证');
  });

  it('用 max-age 时同样不受时钟偏差影响（max-age 是相对秒数）', () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    cache.put({
      request: req('https://x/'),
      response: res(200, {
        date: httpDate(clock.value - 30_000), // 上游时钟慢 30 秒
        'cache-control': 'max-age=60',
      }),
      times: tx(clock),
    });
    // apparent age 把 30 秒偏差吃掉：当前年龄 = max(30, 0) = 30。
    const m = cache.match(req('https://x/'));
    assert.equal(m.kind, 'serve');
    assert.equal(m.decision?.ageSec, 30);
    assert.equal(m.decision?.remainingFreshnessSec, 30);
  });
});
