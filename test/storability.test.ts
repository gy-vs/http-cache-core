import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsePolicy, DEFAULT_CACHEABLE_STATUSES } from '../src/policy.js';
import { FakeClock, httpDate, req, res, tx } from './helpers.js';

describe('可存储性 RFC 9111 §3', () => {
  it('no-store 出现在请求或响应上一律不可存', () => {
    const clock = new FakeClock();
    const times = tx(clock);
    let p = new ResponsePolicy(req('https://x/', { 'cache-control': 'no-store' }), res(200, {}), times);
    assert.equal(p.canStore().storable, false);
    assert.equal(p.canStore().reason, 'request-no-store');

    p = new ResponsePolicy(req('https://x/'), res(200, { 'cache-control': 'no-store' }), times);
    assert.equal(p.canStore().storable, false);
    assert.equal(p.canStore().reason, 'response-no-store');
  });

  it('默认状态码集合按 RFC 9111：200/301/404 可存，202/302/403/500 不可存', () => {
    const clock = new FakeClock();
    const times = tx(clock);
    for (const status of DEFAULT_CACHEABLE_STATUSES) {
      const p = new ResponsePolicy(req('https://x/'), res(status, {}), times);
      assert.equal(p.canStore().storable, true, `status ${status} should be cacheable`);
    }
    for (const status of [201, 202, 302, 307, 403, 500, 502]) {
      const p = new ResponsePolicy(req('https://x/'), res(status, {}), times);
      assert.equal(p.canStore().storable, false, `status ${status} should NOT be cacheable`);
      assert.equal(p.canStore().reason, 'status-not-cacheable');
    }
  });

  it('默认不可缓存的状态码，带显式过期信息时允许存', () => {
    const clock = new FakeClock();
    const times = tx(clock);
    const date = httpDate(clock.value);
    for (const headers of [
      { date, 'cache-control': 'max-age=60' },
      { date, expires: httpDate(clock.value + 60_000) },
    ] as Record<string, string>[]) {
      const p = new ResponsePolicy(req('https://x/'), res(302, headers), times);
      const d = p.canStore();
      assert.equal(d.storable, true);
      assert.equal(d.freshnessLifetimeSec, 60);
    }
  });

  it('非 GET/HEAD 方法不缓存', () => {
    const clock = new FakeClock();
    const p = new ResponsePolicy(
      req('https://x/', { 'cache-control': 'max-age=60' }, 'POST'),
      res(200, { 'cache-control': 'max-age=60' }),
      tx(clock),
    );
    assert.equal(p.canStore().reason, 'method-not-cacheable');
  });

  it('共享缓存：Authorization 响应默认不存，public/s-maxage/must-revalidate 放行', () => {
    const clock = new FakeClock();
    const times = tx(clock);
    const authed = () => req('https://x/', { authorization: 'Bearer t' });

    assert.equal(
      new ResponsePolicy(authed(), res(200, {}), times, { mode: 'shared' }).canStore().storable,
      false,
    );
    assert.equal(
      new ResponsePolicy(authed(), res(200, {}), times, { mode: 'shared' }).canStore().reason,
      'authorization-without-directive',
    );
    for (const cc of ['public', 's-maxage=10', 'must-revalidate']) {
      const d = new ResponsePolicy(
        authed(),
        res(200, { 'cache-control': cc }),
        times,
        { mode: 'shared' },
      ).canStore();
      assert.equal(d.storable, true, `cc=${cc} 应放行`);
    }
    // 私有缓存不受此约束。
    assert.equal(
      new ResponsePolicy(authed(), res(200, {}), times, { mode: 'private' }).canStore().storable,
      true,
    );
  });

  it('共享缓存不存 private 响应；私有缓存可以', () => {
    const clock = new FakeClock();
    const times = tx(clock);
    const shared = new ResponsePolicy(
      req('https://x/'),
      res(200, { 'cache-control': 'private' }),
      times,
      { mode: 'shared' },
    );
    assert.equal(shared.canStore().storable, false);
    assert.equal(shared.canStore().reason, 'shared-cache-response-private');
    const priv = new ResponsePolicy(
      req('https://x/'),
      res(200, { 'cache-control': 'private, max-age=10' }),
      times,
      { mode: 'private' },
    );
    assert.equal(priv.canStore().storable, true);
  });
});
