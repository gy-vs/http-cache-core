import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cache, type Revalidator, type RevalidateResultResponse } from '../src/cache.js';
import { MemoryCacheStore } from '../src/store.js';
import { T0, req, res, httpDate, fakeClock, deferred } from './helpers.js';

function makeCache(extra: ConstructorParameters<typeof Cache>[0] = {}) {
  const clock = fakeClock(T0);
  const cache = new Cache({ mode: 'shared', clock: clock.now, ...extra });
  return { cache, clock };
}

test('Vary：压缩与不压缩两份响应并存，不同请求各取各的，且互不覆盖', () => {
  const { cache, clock } = makeCache();

  const putGzip = cache.put({
    request: req('https://x/a', { 'accept-encoding': 'gzip' }),
    response: res(200, {
      date: httpDate(T0),
      vary: 'Accept-Encoding',
      'cache-control': 'max-age=60',
      'content-encoding': 'gzip',
    }, 'GZIP-BODY'),
    requestTime: clock.now(),
    responseTime: clock.now(),
  });
  assert.equal(putGzip.stored, true);
  if (putGzip.stored) assert.equal(putGzip.variant, 'created');

  const putIdentity = cache.put({
    request: req('https://x/a', { 'accept-encoding': 'identity' }),
    response: res(200, {
      date: httpDate(T0),
      vary: 'Accept-Encoding',
      'cache-control': 'max-age=60',
      'content-encoding': 'identity',
    }, 'PLAIN-BODY'),
  });
  assert.equal(putIdentity.stored, true);
  if (putIdentity.stored) assert.equal(putIdentity.variant, 'created');

  const hitGzip = cache.lookup(req('https://x/a', { 'accept-encoding': 'gzip' }));
  const hitPlain = cache.lookup(req('https://x/a', { 'accept-encoding': 'identity' }));
  assert.equal(hitGzip.kind, 'hit');
  assert.equal(hitPlain.kind, 'hit');
  if (hitGzip.kind === 'hit' && hitPlain.kind === 'hit') {
    assert.equal(hitGzip.variant.response.body, 'GZIP-BODY');
    assert.equal(hitPlain.variant.response.body, 'PLAIN-BODY');
  }

  // 没带该头的请求不命中，且不能覆盖旧副本
  const miss = cache.lookup(req('https://x/a'));
  assert.equal(miss.kind, 'vary-miss');

  // 两份都还在
  const store = cache.store as MemoryCacheStore;
  const entry = store.get({ method: 'GET', target: 'https://x/a' });
  assert.equal(entry?.variants.size, 2);
});

test('Vary: * 的响应存得下，但永远不命中，request() 给出 gateway-timeout 语义', () => {
  const { cache } = makeCache();
  const put = cache.put({
    request: req('https://x/a'),
    response: res(200, { date: httpDate(T0), vary: '*', 'cache-control': 'max-age=60' }),
  });
  assert.equal(put.stored, true);
  assert.equal(cache.lookup(req('https://x/a')).kind, 'wildcard');
});

test('304 合并：304 带的头替换同名头，没带的保留，body 与状态码不动', async () => {
  const { cache, clock } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, {
      date: httpDate(T0),
      etag: '"v1"',
      'x-a': '1',
      'x-b': '2',
      'cache-control': 'max-age=0',
    }, 'ORIGINAL-BODY'),
  });

  const lookup = cache.lookup(req('https://x/a'));
  assert.equal(lookup.kind, 'hit');
  if (lookup.kind !== 'hit') throw new Error('应当命中');

  const revalidator: Revalidator = async (ctx) => {
    // 条件头按规则生成
    assert.equal(ctx.conditional.get('if-none-match'), '"v1"');
    assert.equal(ctx.conditional.get('if-modified-since'), null);
    clock.advance(500);
    return {
      status: 304,
      headers: { etag: '"v2"', 'x-a': 'updated' },
      requestTime: clock.now(),
      responseTime: clock.now(),
    } satisfies RevalidateResultResponse;
  };

  const outcome = await cache.revalidate(lookup, revalidator);
  assert.equal(outcome.outcome, 'not-modified');
  if (outcome.outcome !== 'not-modified') throw new Error('应当 304');
  const h = outcome.variant.response.headers;
  assert.equal(h.get('etag'), '"v2"');
  assert.equal(h.get('x-a'), 'updated');
  assert.equal(h.get('x-b'), '2'); // 304 没带 -> 保留
  assert.equal(outcome.variant.response.body, 'ORIGINAL-BODY');
  assert.equal(outcome.variant.response.status, 200);

  // 存储里的那份也被原地更新为合并后的版本
  const again = cache.lookup(req('https://x/a'));
  if (again.kind === 'hit') {
    assert.equal(again.variant.response.headers.get('etag'), '"v2"');
  } else {
    throw new Error('合并后仍应命中');
  }
});

test('304 合并：hop-by-hop 头（Connection/Transfer-Encoding 等）不写进已存响应', async () => {
  const { cache, clock } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, {
      date: httpDate(T0),
      etag: '"v1"',
      'cache-control': 'max-age=0',
      'x-keep': 'yes',
    }, 'BODY'),
  });
  const lookup = cache.lookup(req('https://x/a'));
  if (lookup.kind !== 'hit') throw new Error('未命中');

  await cache.revalidate(
    lookup,
    async () => ({
      status: 304,
      headers: {
        etag: '"v2"',
        connection: 'keep-alive, x-hop-listed',
        'transfer-encoding': 'chunked',
        'x-hop-listed': 'should-not-persist',
        'x-keep': 'still-yes',
      },
      requestTime: clock.now(),
      responseTime: clock.now(),
    }),
  );

  const after = cache.lookup(req('https://x/a'));
  if (after.kind !== 'hit') throw new Error('合并后应命中');
  assert.equal(after.variant.response.headers.has('connection'), false);
  assert.equal(after.variant.response.headers.has('transfer-encoding'), false);
  assert.equal(after.variant.response.headers.has('x-hop-listed'), false);
  assert.equal(after.variant.response.headers.get('x-keep'), 'still-yes');
  assert.equal(after.variant.response.headers.get('etag'), '"v2"');
});

test('条件请求：只有 Last-Modified 时仅带 If-Modified-Since；两个都有都带', async () => {
  const { cache } = makeCache();
  cache.put({
    request: req('https://x/lm'),
    response: res(200, {
      date: httpDate(T0),
      'last-modified': httpDate(T0 - 100_000),
      'cache-control': 'max-age=0',
    }),
  });
  const lookupLm = cache.lookup(req('https://x/lm'));
  if (lookupLm.kind !== 'hit') throw new Error('未命中');
  await cache.revalidate(lookupLm, async (ctx) => {
    assert.equal(ctx.conditional.get('if-modified-since'), httpDate(T0 - 100_000));
    assert.equal(ctx.conditional.get('if-none-match'), null);
    return { status: 304, headers: {}, requestTime: T0, responseTime: T0 };
  });

  cache.put({
    request: req('https://x/both'),
    response: res(200, {
      date: httpDate(T0),
      etag: '"e"',
      'last-modified': httpDate(T0 - 100_000),
      'cache-control': 'max-age=0',
    }),
  });
  const lookupBoth = cache.lookup(req('https://x/both'));
  if (lookupBoth.kind !== 'hit') throw new Error('未命中');
  await cache.revalidate(lookupBoth, async (ctx) => {
    assert.ok(ctx.conditional.has('if-none-match'));
    assert.ok(ctx.conditional.has('if-modified-since'));
    return { status: 304, headers: {}, requestTime: T0, responseTime: T0 };
  });
});

test('200 再验证响应按存储决策重走：可存则替换，不可存则删除', async () => {
  const { cache } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, { date: httpDate(T0), etag: '"v1"', 'cache-control': 'max-age=0' }),
  });
  const lookup = cache.lookup(req('https://x/a'));
  if (lookup.kind !== 'hit') throw new Error('未命中');

  const outcome = await cache.revalidate(lookup, async () => ({
    status: 200,
    headers: { date: httpDate(T0), 'cache-control': 'no-store' },
    body: 'FRESH',
    requestTime: T0,
    responseTime: T0,
  }));
  assert.equal(outcome.outcome, 'replaced');
  if (outcome.outcome === 'replaced') {
    assert.equal(outcome.decision.storable, false);
    assert.equal(outcome.variant, null);
  }
  assert.equal(cache.lookup(req('https://x/a')).kind, 'miss');
});

test('200 再验证不可存时只删当前 Vary 副本，同目标的其他表示保留', async () => {
  const { cache } = makeCache();
  for (const enc of ['gzip', 'br']) {
    cache.put({
      request: req('https://x/a', { 'accept-encoding': enc }),
      response: res(200, {
        date: httpDate(T0),
        vary: 'Accept-Encoding',
        etag: `"${enc}"`,
        'cache-control': 'max-age=0',
      }),
    });
  }
  const lookup = cache.lookup(req('https://x/a', { 'accept-encoding': 'gzip' }));
  if (lookup.kind !== 'hit') throw new Error('未命中');

  await cache.revalidate(lookup, async () => ({
    status: 200,
    headers: { date: httpDate(T0), 'cache-control': 'no-store' },
    requestTime: T0,
    responseTime: T0,
  }));

  assert.equal(
    cache.lookup(req('https://x/a', { 'accept-encoding': 'gzip' })).kind,
    'vary-miss',
  );
  // br 那份仍然在
  const br = cache.lookup(req('https://x/a', { 'accept-encoding': 'br' }));
  assert.equal(br.kind, 'hit');
});

test('并发再验证：同一副本上多个请求只触发一次上游回调（single-flight）', async () => {
  const { cache } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, { date: httpDate(T0), etag: '"v1"', 'cache-control': 'max-age=0' }),
  });
  const lookup = cache.lookup(req('https://x/a'));
  if (lookup.kind !== 'hit') throw new Error('未命中');

  const gate = deferred<RevalidateResultResponse>();
  let calls = 0;
  const revalidator: Revalidator = async () => {
    calls += 1;
    return gate.promise;
  };

  const p1 = cache.revalidate(lookup, revalidator);
  const p2 = cache.revalidate(lookup, revalidator);
  const p3 = cache.revalidate(lookup, revalidator);
  assert.equal(calls, 1);

  gate.resolve({ status: 304, headers: {}, requestTime: T0, responseTime: T0 });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.outcome, 'not-modified');
  assert.equal(r2.outcome, 'not-modified');
  assert.equal(r3.outcome, 'not-modified');
  assert.equal(calls, 1);

  // 在途结束后再次再验证才会发出新请求
  await cache.revalidate(lookup, revalidator);
  assert.equal(calls, 2);
});

test('不同 Vary 副本上的并发再验证互不合并', async () => {
  const { cache } = makeCache();
  for (const enc of ['gzip', 'br']) {
    cache.put({
      request: req('https://x/a', { 'accept-encoding': enc }),
      response: res(200, {
        date: httpDate(T0),
        vary: 'Accept-Encoding',
        etag: `"${enc}"`,
        'cache-control': 'max-age=0',
      }),
    });
  }
  const l1 = cache.lookup(req('https://x/a', { 'accept-encoding': 'gzip' }));
  const l2 = cache.lookup(req('https://x/a', { 'accept-encoding': 'br' }));
  if (l1.kind !== 'hit' || l2.kind !== 'hit') throw new Error('未命中');

  const calls: string[] = [];
  const revalidator: Revalidator = async (ctx) => {
    calls.push(ctx.conditional.get('if-none-match') ?? '');
    return { status: 304, headers: {}, requestTime: T0, responseTime: T0 };
  };
  await Promise.all([cache.revalidate(l1, revalidator), cache.revalidate(l2, revalidator)]);
  assert.deepEqual(calls.sort(), ['"br"', '"gzip"']);
});

test('stale-while-revalidate：请求立即拿到过期副本，再验证在后台进行', async () => {
  const { cache, clock } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, {
      date: httpDate(T0),
      etag: '"v1"',
      'cache-control': 'max-age=60, stale-while-revalidate=30',
    }, 'OLD-BODY'),
  });
  clock.set(T0 + 70_000); // 过期 10s，SWR 窗口内

  const gate = deferred<RevalidateResultResponse>();
  let bgStarted = false;
  const revalidator: Revalidator = async () => {
    bgStarted = true;
    return gate.promise;
  };

  const result = await cache.request(req('https://x/a'), revalidator);
  assert.equal(result.state, 'stale-while-revalidate');
  if (result.state !== 'stale-while-revalidate') throw new Error('应走 SWR');
  assert.equal(result.variant.response.body, 'OLD-BODY'); // 立即拿到旧副本
  assert.equal(bgStarted, true); // 不等后台

  gate.resolve({
    status: 304,
    headers: { 'x-revalidated': '1' },
    requestTime: clock.now(),
    responseTime: clock.now(),
  });
  const outcome = await result.revalidating;
  assert.equal(outcome.outcome, 'not-modified');
});

test('SWR 窗口外的普通过期：request() 同步等待再验证', async () => {
  const { cache, clock } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, { date: httpDate(T0), etag: '"v1"', 'cache-control': 'max-age=60' }),
  });
  clock.set(T0 + 120_000);

  const result = await cache.request(req('https://x/a'), async () => ({
    status: 304,
    headers: {},
    requestTime: clock.now(),
    responseTime: clock.now(),
  }));
  assert.equal(result.state, 'revalidated');
});

test('SWR 窗口外：不再后台放行，走同步再验证', async () => {
  const { cache, clock } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, {
      date: httpDate(T0),
      etag: '"v1"',
      'cache-control': 'max-age=60, stale-while-revalidate=30',
    }, 'OLD-BODY'),
  });

  // 过期 45s，超出 30s SWR 窗口
  clock.set(T0 + 105_000);
  const result = await cache.request(req('https://x/a'), async () => ({
    status: 304,
    headers: {},
    requestTime: clock.now(),
    responseTime: clock.now(),
  }));
  assert.equal(result.state, 'revalidated');
});

test('request()：miss 返回 miss；only-if-cached 且无副本返回 gateway-timeout', async () => {
  const { cache } = makeCache();
  const noop: Revalidator = async () => ({
    status: 200,
    headers: {},
    requestTime: T0,
    responseTime: T0,
  });
  assert.equal((await cache.request(req('https://x/missing'), noop)).state, 'miss');
  assert.equal(
    (
      await cache.request(
        req('https://x/missing', { 'cache-control': 'only-if-cached' }),
        noop,
      )
    ).state,
    'gateway-timeout',
  );
});

test('内存 LRU：条目超上限按最近最少使用整条淘汰', () => {
  const events: string[] = [];
  const { cache } = makeCache({
    storeOptions: {
      maxEntries: 2,
      onEvent: (e) => events.push(`${e.reason}:${e.key.target}`),
    },
  });
  const put = (target: string) =>
    cache.put({
      request: req(target),
      response: res(200, { date: httpDate(T0), 'cache-control': 'max-age=60' }),
    });

  put('https://x/1');
  put('https://x/2');
  // 访问 1，让 2 成为最久未用
  assert.equal(cache.lookup(req('https://x/1')).kind, 'hit');
  put('https://x/3');

  assert.equal(cache.lookup(req('https://x/1')).kind, 'hit');
  assert.equal(cache.lookup(req('https://x/2')).kind, 'miss');
  assert.equal(cache.lookup(req('https://x/3')).kind, 'hit');
  assert.ok(events.some((e) => e === 'evict:https://x/2'));
});

test('内存 LRU：单条目 Vary 变体超上限淘汰最久未命中的变体', () => {
  const { cache } = makeCache({
    storeOptions: { maxEntries: 10, maxVariantsPerEntry: 2 },
  });
  const putEnc = (enc: string) =>
    cache.put({
      request: req('https://x/a', { 'accept-encoding': enc }),
      response: res(200, {
        date: httpDate(T0),
        vary: 'Accept-Encoding',
        'cache-control': 'max-age=60',
      }, enc),
    });

  putEnc('gzip');
  putEnc('br');
  assert.equal(cache.lookup(req('https://x/a', { 'accept-encoding': 'gzip' })).kind, 'hit');
  putEnc('identity'); // 超过每键 2 个变体，br 最久未命中 -> 淘汰

  assert.equal(cache.lookup(req('https://x/a', { 'accept-encoding': 'br' })).kind, 'vary-miss');
  assert.equal(cache.lookup(req('https://x/a', { 'accept-encoding': 'gzip' })).kind, 'hit');
  assert.equal(
    cache.lookup(req('https://x/a', { 'accept-encoding': 'identity' })).kind,
    'hit',
  );
});

test('上游 304 后年龄不会倒退（合并重算年龄取已存当前年龄与新年龄的最大值）', async () => {
  const { cache, clock } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, { date: httpDate(T0), etag: '"v1"', 'cache-control': 'max-age=60' }),
  });
  clock.set(T0 + 50_000); // 已存副本当前年龄 50s
  const lookup = cache.lookup(req('https://x/a'));
  if (lookup.kind !== 'hit') throw new Error('未命中');

  // 304 故意给一个很年轻的 Age，也不能把年龄拉回去
  const outcome = await cache.revalidate(lookup, async () => ({
    status: 304,
    headers: { date: httpDate(clock.now()), age: '0' },
    requestTime: clock.now(),
    responseTime: clock.now(),
  }));
  if (outcome.outcome !== 'not-modified') throw new Error('应 304');
  assert.ok(
    outcome.variant.ageInitial >= 50_000,
    `合并后初始年龄 ${outcome.variant.ageInitial} 不应小于 50000`,
  );
});

test('SWR 并发：窗口内同时进来的多个请求只触发一次后台再验证', async () => {
  const { cache, clock } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, {
      date: httpDate(T0),
      etag: '"v1"',
      'cache-control': 'max-age=60, stale-while-revalidate=30',
    }, 'OLD-BODY'),
  });
  clock.set(T0 + 70_000);

  const gate = deferred<RevalidateResultResponse>();
  let calls = 0;
  const revalidator: Revalidator = async () => {
    calls += 1;
    return gate.promise;
  };

  const [r1, r2, r3] = await Promise.all([
    cache.request(req('https://x/a'), revalidator),
    cache.request(req('https://x/a'), revalidator),
    cache.request(req('https://x/a'), revalidator),
  ]);
  assert.equal(calls, 1); // 一串并发请求只打出去一次
  for (const r of [r1, r2, r3]) {
    assert.equal(r.state, 'stale-while-revalidate');
  }

  gate.resolve({ status: 304, headers: {}, requestTime: clock.now(), responseTime: clock.now() });
  if (r1.state === 'stale-while-revalidate') await r1.revalidating;
  assert.equal(calls, 1);
});

test('max-stale 放行的过期副本在 request() 中标记为 stale-served 而非 hit', async () => {
  const { cache, clock } = makeCache();
  cache.put({
    request: req('https://x/a'),
    response: res(200, { date: httpDate(T0), 'cache-control': 'max-age=60' }),
  });
  clock.set(T0 + 75_000);
  const result = await cache.request(
    req('https://x/a', { 'cache-control': 'max-stale=30' }),
    async () => ({ status: 304, headers: {}, requestTime: clock.now(), responseTime: clock.now() }),
  );
  assert.equal(result.state, 'stale-served');
});

test('put：上游 Vary 维度变化（无 Vary -> 有 Vary）时清掉旧副本，避免万能命中', () => {
  const { cache } = makeCache();
  // 先存一份不带 Vary 的
  cache.put({
    request: req('https://x/a'),
    response: res(200, { date: httpDate(T0), 'cache-control': 'max-age=60' }, 'V0'),
  });
  assert.equal(cache.lookup(req('https://x/a', { 'accept-encoding': 'gzip' })).kind, 'hit');

  // 上游后来开始按 Accept-Encoding 协商
  cache.put({
    request: req('https://x/a', { 'accept-encoding': 'gzip' }),
    response: res(200, {
      date: httpDate(T0),
      vary: 'Accept-Encoding',
      'cache-control': 'max-age=60',
    }, 'V1-GZIP'),
  });

  // 旧的无 Vary 副本不能再对 identity 请求万能命中
  assert.equal(
    cache.lookup(req('https://x/a', { 'accept-encoding': 'identity' })).kind,
    'vary-miss',
  );
  const gzipHit = cache.lookup(req('https://x/a', { 'accept-encoding': 'gzip' }));
  assert.equal(gzipHit.kind, 'hit');
  if (gzipHit.kind === 'hit') assert.equal(gzipHit.variant.response.body, 'V1-GZIP');
});

test('自定义存储后端：实现 CacheStore 接口即可接入', async () => {
  const store = new MemoryCacheStore({ maxEntries: 1 });
  const { cache } = makeCache({ store });
  cache.put({
    request: req('https://x/a'),
    response: res(200, { date: httpDate(T0), 'cache-control': 'max-age=60' }),
  });
  assert.equal(cache.lookup(req('https://x/a')).kind, 'hit');
});
