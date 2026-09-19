import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../src/cache.js';
import { FakeClock, flushMicrotasks, httpDate, req, res, tx } from './helpers.js';
import type { RevalidateFn } from '../src/index.js';

function freshResponseHeaders(clock: FakeClock, extra: Record<string, string> = {}) {
  return { date: httpDate(clock.value), 'cache-control': 'max-age=60', ...extra };
}

describe('Vary 选择', () => {
  it('Vary 头不同的请求各自存一份，互不覆盖、各自命中', () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    const url = 'https://x/vary';

    cache.put({
      request: req(url, { 'accept-encoding': 'gzip' }),
      response: res(200, freshResponseHeaders(clock, { vary: 'Accept-Encoding' }), 'GZIP-BODY'),
      times: tx(clock),
    });
    cache.put({
      request: req(url, { 'accept-encoding': 'identity' }),
      response: res(200, freshResponseHeaders(clock, { vary: 'Accept-Encoding' }), 'PLAIN-BODY'),
      times: tx(clock),
    });

    const gz = cache.match(req(url, { 'accept-encoding': 'gzip' }));
    const plain = cache.match(req(url, { 'accept-encoding': 'identity' }));
    assert.equal(gz.kind, 'serve');
    assert.equal(plain.kind, 'serve');
    assert.equal(gz.entry!.response.body, 'GZIP-BODY');
    assert.equal(plain.entry!.response.body, 'PLAIN-BODY');
    assert.equal(cache.storage.size, 2);

    // 未见过的编码：miss（而不是给错内容）。
    assert.equal(cache.match(req(url, { 'accept-encoding': 'br' })).kind, 'miss');
    // 头名大小写不影响选择。
    assert.equal(
      cache.match(req(url, { 'Accept-Encoding': 'gzip' })).entry!.response.body,
      'GZIP-BODY',
    );
  });

  it('Vary: * 的响应永不命中', () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    cache.put({
      request: req('https://x/', { 'accept-encoding': 'gzip' }),
      response: res(200, freshResponseHeaders(clock, { vary: '*' })),
      times: tx(clock),
    });
    assert.equal(cache.match(req('https://x/', { 'accept-encoding': 'gzip' })).kind, 'miss');
    assert.equal(cache.storage.size, 1); // 存得下，只是永不命中
  });

  it('多维 Vary 同时比较', () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    const url = 'https://x/multi';
    cache.put({
      request: req(url, { accept: 'application/json', 'accept-language': 'en' }),
      response: res(200, freshResponseHeaders(clock, { vary: 'Accept, Accept-Language' }), 'en-json'),
      times: tx(clock),
    });
    assert.equal(cache.match(req(url, { accept: 'application/json', 'accept-language': 'en' })).kind, 'serve');
    assert.equal(cache.match(req(url, { accept: 'text/html', 'accept-language': 'en' })).kind, 'miss');
    assert.equal(cache.match(req(url, { accept: 'application/json', 'accept-language': 'zh' })).kind, 'miss');
  });
});

describe('LRU 淘汰', () => {
  it('超过上限按最近最少使用淘汰；touch 命中可续命', () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now, maxEntries: 2 });
    cache.put({ request: req('https://x/a'), response: res(200, freshResponseHeaders(clock)), times: tx(clock) });
    cache.put({ request: req('https://x/b'), response: res(200, freshResponseHeaders(clock)), times: tx(clock) });
    // 访问 a，让 b 成为最久未用。
    assert.equal(cache.match(req('https://x/a')).kind, 'serve');
    cache.put({ request: req('https://x/c'), response: res(200, freshResponseHeaders(clock)), times: tx(clock) });

    assert.equal(cache.match(req('https://x/b')).kind, 'miss');
    assert.equal(cache.match(req('https://x/a')).kind, 'serve');
    assert.equal(cache.match(req('https://x/c')).kind, 'serve');
  });
});

describe('304 合并', () => {
  it('304 的头按字段合并而非替换，旧头保留、响应体不动', async () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    const url = 'https://x/r';
    cache.put({
      request: req(url),
      response: res(
        200,
        {
          date: httpDate(clock.value),
          'cache-control': 'max-age=60',
          etag: '"v1"',
          'x-a': '1',
          'x-b': '2',
          'content-length': '4',
        },
        'BODY',
      ),
      times: tx(clock),
    });
    clock.advance(90_000); // 已过期
    assert.equal(cache.match(req(url)).kind, 'revalidate');

    let calls = 0;
    const fn: RevalidateFn = async () => {
      calls++;
      // 304 只带新的 cache-control 和 x-a；x-b 必须保留，body 不动。
      return {
        response: res(304, {
          date: httpDate(clock.value),
          'cache-control': 'max-age=120',
          'x-a': 'updated',
        }),
        times: tx(clock),
      };
    };

    const out = await cache.handle(req(url), fn);
    assert.equal(out.kind, 'revalidated');
    assert.equal(out.replaced, false);
    assert.equal(calls, 1);

    const e = out.entry!;
    const h = Object.fromEntries(e.response.headers);
    assert.equal(e.response.status, 200);
    assert.equal(e.response.body, 'BODY');
    assert.equal(h['x-a'], 'updated');       // 被 304 替换
    assert.equal(h['x-b'], '2');             // 304 没带，保留
    assert.equal(h['content-length'], undefined); // 删除
    assert.equal(h['etag'], '"v1"');         // 验证器保留
    assert.equal(h['cache-control'], 'max-age=120');
    // 新鲜度已刷新：立刻命中。
    assert.equal(cache.match(req(url)).kind, 'serve');
  });

  it('条件请求头：有 ETag 用 If-None-Match，仅 Last-Modified 用 If-Modified-Since，两者都有都带', () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    const mk = (validators: Record<string, string>) => {
      cache.clear();
      cache.put({
        request: req('https://x/'),
        // no-cache：响应存得下但每次必须再验证，match 直接给出条件头。
        response: res(200, {
          ...freshResponseHeaders(clock, { 'cache-control': 'no-cache' }),
          ...validators,
        }),
        times: tx(clock),
      });
      const m = cache.match(req('https://x/'));
      assert.equal(m.kind, 'revalidate');
      if (m.kind !== 'revalidate') throw new Error('unreachable');
      return m.conditionalHeaders;
    };
    assert.deepEqual(mk({ etag: '"e"' }), [['if-none-match', '"e"']]);
    assert.deepEqual(mk({ 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }), [
      ['if-modified-since', 'Wed, 21 Oct 2015 07:28:00 GMT'],
    ]);
    assert.deepEqual(
      mk({ etag: '"e"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }),
      [
        ['if-none-match', '"e"'],
        ['if-modified-since', 'Wed, 21 Oct 2015 07:28:00 GMT'],
      ],
    );
  });

  it('200 完整响应按新响应整体替换', async () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    cache.put({
      request: req('https://x/'),
      response: res(200, freshResponseHeaders(clock), 'OLD'),
      times: tx(clock),
    });
    clock.advance(90_000);
    const fn: RevalidateFn = async () => ({
      response: res(200, freshResponseHeaders(clock), 'NEW'),
      times: tx(clock),
    });
    const out = await cache.handle(req('https://x/'), fn);
    assert.equal(out.kind, 'revalidated');
    assert.equal(out.replaced, true);
    assert.equal(out.entry!.response.body, 'NEW');
  });

  it('再验证拿回的完整响应不可缓存时，以 passthrough 把原始响应交回', async () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    cache.put({
      request: req('https://x/'),
      response: res(200, freshResponseHeaders(clock), 'OLD'),
      times: tx(clock),
    });
    clock.advance(90_000);
    const fn: RevalidateFn = async () => ({
      response: res(200, { 'cache-control': 'no-store' }, 'LIVE'),
      times: tx(clock),
    });
    const out = await cache.handle(req('https://x/'), fn);
    assert.equal(out.kind, 'passthrough');
    assert.equal(out.upstream?.response.body, 'LIVE');
    assert.equal(cache.storage.size, 0);
  });

  it('304 合并不会把 Authorization 等非 Vary 请求头写进条目快照', async () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now, mode: 'private' });
    cache.put({
      request: req('https://x/', { authorization: 'Bearer t', 'accept-encoding': 'gzip' }),
      response: res(200, {
        date: httpDate(clock.value),
        'cache-control': 'max-age=60',
        etag: '"v"',
        vary: 'Accept-Encoding',
      }),
      times: tx(clock),
    });
    clock.advance(90_000);
    await cache.handle(
      req('https://x/', { authorization: 'Bearer t', 'accept-encoding': 'gzip' }),
      async () => ({
        response: res(304, { date: httpDate(clock.value), 'cache-control': 'max-age=60' }),
        times: tx(clock),
      }),
    );
    const entry = cache.match(req('https://x/', { 'accept-encoding': 'gzip' })).entry;
    assert.ok(entry);
    const names = entry!.request.headers.map(([n]) => n);
    assert.deepEqual(names, ['accept-encoding']);
    assert.ok(!names.includes('authorization'));
  });
});

describe('stale-while-revalidate 与并发去重', () => {
  it('SWR 窗口内立即返回过期副本并触发后台再验证', async () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    cache.put({
      request: req('https://x/'),
      response: res(200, {
        date: httpDate(clock.value),
        'cache-control': 'max-age=60, stale-while-revalidate=30',
      }, 'BODY'),
      times: tx(clock),
    });
    clock.advance(70_000); // 过期 10 秒，仍在 SWR 窗口内

    let resolveRev!: (v: { response: ReturnType<typeof res>; times: ReturnType<typeof tx> }) => void;
    const background = new Promise((resolve) => {
      resolveRev = resolve;
    });
    let calls = 0;
    const fn: RevalidateFn = async () => {
      calls++;
      return background as never;
    };

    const out = await cache.handle(req('https://x/'), fn);
    assert.equal(out.kind, 'cached');
    assert.equal(out.entry!.response.body, 'BODY'); // 立即拿到旧副本
    assert.ok(out.background, '应返回后台任务');
    assert.equal(calls, 1, '后台再验证已触发一次');

    resolveRev({
      response: res(200, { date: httpDate(clock.value), 'cache-control': 'max-age=60' }, 'FRESH'),
      times: tx(clock),
    });
    await out.background;
    await flushMicrotasks();
    assert.equal(cache.match(req('https://x/')).entry!.response.body, 'FRESH');
  });

  it('同一 slot 并发的再验证只打一次', async () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    cache.put({
      request: req('https://x/'),
      response: res(200, { date: httpDate(clock.value), 'cache-control': 'max-age=60' }, 'B'),
      times: tx(clock),
    });
    clock.advance(90_000);

    let calls = 0;
    const fn: RevalidateFn = async () => {
      calls++;
      return {
        response: res(304, { date: httpDate(clock.value), 'cache-control': 'max-age=60' }),
        times: tx(clock),
      };
    };

    const match = cache.match(req('https://x/'));
    assert.equal(match.kind, 'revalidate');
    const variant = match.variant!;
    const [a, b, c] = await Promise.all([
      cache.revalidate(req('https://x/'), variant, fn),
      cache.revalidate(req('https://x/'), variant, fn),
      cache.revalidate(req('https://x/'), variant, fn),
    ]);
    assert.equal(calls, 1, '三个并发请求只触发一次回调');
    assert.ok(a.entry && b.entry && c.entry);
  });

  it('超出 SWR 窗口后过期响应必须前台再验证', async () => {
    const clock = new FakeClock();
    const cache = new Cache({ now: clock.now });
    cache.put({
      request: req('https://x/'),
      response: res(200, {
        date: httpDate(clock.value),
        'cache-control': 'max-age=60, stale-while-revalidate=30',
      }),
      times: tx(clock),
    });
    clock.advance(100_000);
    const fn: RevalidateFn = async () => ({
      response: res(304, { date: httpDate(clock.value), 'cache-control': 'max-age=60' }),
      times: tx(clock),
    });
    const out = await cache.handle(req('https://x/'), fn);
    assert.equal(out.kind, 'revalidated');
    assert.equal(out.background, undefined);
  });

  it('only-if-cached 无副本时明确给出 gateway-timeout', async () => {
    const cache = new Cache();
    const out = await cache.handle(
      req('https://x/', { 'cache-control': 'only-if-cached' }),
      async () => {
        throw new Error('不应发起请求');
      },
    );
    assert.equal(out.kind, 'gateway-timeout');
  });
});
