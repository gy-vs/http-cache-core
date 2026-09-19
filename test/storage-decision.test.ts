import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStorage, freshnessLifetime } from '../src/policy.js';
import { HeadersLite } from '../src/headers.js';
import { normalizeRequest, normalizeResponse } from '../src/types.js';
import { T0, req, res, httpDate } from './helpers.js';

const baseTiming = { requestTime: T0, responseTime: T0 + 100 };
type StorageInput = Parameters<typeof decideStorage>[0];
const input = (
  request: ReturnType<typeof req>,
  response: ReturnType<typeof res>,
): StorageInput => ({
  request: normalizeRequest(request),
  response: normalizeResponse(response),
  ...baseTiming,
});

test('带 Cache-Control: no-store 的响应一律不可存（共享/私有都拦）', () => {
  for (const mode of ['shared', 'private'] as const) {
    const d = decideStorage(
      input(req('https://x/a'), res(200, { 'cache-control': 'no-store' })),
      { mode },
    );
    assert.equal(d.storable, false);
    assert.equal(d.reason, 'no-store-response');
  }
});

test('请求带 no-store 时不存储', () => {
  const d = decideStorage(
    input(
      req('https://x/a', { 'cache-control': 'no-store' }),
      res(200, { 'cache-control': 'max-age=60' }),
    ),
    { mode: 'shared' },
  );
  assert.equal(d.storable, false);
  assert.equal(d.reason, 'no-store-request');
});

test('private 响应：共享缓存不能存，私有缓存可以', () => {
  const shared = decideStorage(
    input(req('https://x/a'), res(200, { 'cache-control': 'private, max-age=60' })),
    { mode: 'shared' },
  );
  assert.equal(shared.storable, false);
  assert.equal(shared.reason, 'private-response-in-shared-cache');

  const priv = decideStorage(
    input(req('https://x/a'), res(200, { 'cache-control': 'private, max-age=60' })),
    { mode: 'private' },
  );
  assert.equal(priv.storable, true);
});

test('带 Authorization 的请求：共享缓存默认拒绝，public/must-revalidate/s-maxage 放行', () => {
  const denied = decideStorage(
    input(
      req('https://x/a', { authorization: 'Bearer t' }),
      res(200, { 'cache-control': 'max-age=60' }),
    ),
    { mode: 'shared' },
  );
  assert.equal(denied.storable, false);
  assert.equal(denied.reason, 'authorization-requires-directive');

  for (const directive of ['public', 'must-revalidate, max-age=60', 's-maxage=30']) {
    const allowed = decideStorage(
      input(
        req('https://x/a', { authorization: 'Bearer t' }),
        res(200, { 'cache-control': directive }),
      ),
      { mode: 'shared' },
    );
    assert.equal(allowed.storable, true, `指令 ${directive} 应放行`);
  }

  // 私有缓存不受此限制
  const priv = decideStorage(
    input(
      req('https://x/a', { authorization: 'Bearer t' }),
      res(200, { 'cache-control': 'max-age=60' }),
    ),
    { mode: 'private' },
  );
  assert.equal(priv.storable, true);
});

test('默认不可缓存状态码（如 500）无显式过期时拒绝；带 max-age/Expires 时允许', () => {
  const denied = decideStorage(input(req('https://x/a'), res(500)), { mode: 'shared' });
  assert.equal(denied.storable, false);
  assert.equal(denied.reason, 'status-not-cacheable');

  const viaMaxAge = decideStorage(
    input(req('https://x/a'), res(500, { 'cache-control': 'max-age=10' })),
    { mode: 'shared' },
  );
  assert.equal(viaMaxAge.storable, true);
  assert.equal(viaMaxAge.reason, 'cacheable-explicit-expiration');

  const viaExpires = decideStorage(
    input(
      req('https://x/a'),
      res(502, { date: httpDate(T0), expires: httpDate(T0 + 10_000) }),
    ),
    { mode: 'shared' },
  );
  assert.equal(viaExpires.storable, true);
});

test('默认可缓存状态码全部可存：200 203 204 206 300 301 308 404 405 410 414 501', () => {
  for (const status of [200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]) {
    const d = decideStorage(
      input(
        req('https://x/a'),
        res(status, {
          date: httpDate(T0),
          'last-modified': httpDate(T0 - 100_000),
        }),
      ),
      { mode: 'shared' },
    );
    assert.equal(d.storable, true, `状态 ${status} 应默认可缓存`);
  }
});

test('POST 默认不可存；带显式过期且状态码可缓存时才放行', () => {
  const withExpiry = decideStorage(
    input(
      req('https://x/a', undefined, 'POST'),
      res(200, { 'cache-control': 'max-age=60' }),
    ),
    { mode: 'shared' },
  );
  assert.equal(withExpiry.storable, true);
  assert.equal(withExpiry.reason, 'cacheable-explicit-expiration');

  const noExpiry = decideStorage(input(req('https://x/a', undefined, 'POST'), res(200)), {
    mode: 'shared',
  });
  assert.equal(noExpiry.storable, false);
  assert.equal(noExpiry.reason, 'non-safe-method-requires-explicit-expiration');

  const badStatus = decideStorage(
    input(
      req('https://x/a', undefined, 'POST'),
      res(500, { 'cache-control': 'max-age=60' }),
    ),
    { mode: 'shared' },
  );
  assert.equal(badStatus.storable, false);
  assert.equal(badStatus.reason, 'method-not-cacheable');
});

test('HEAD 与 GET 一样默认可缓存', () => {
  const d = decideStorage(input(req('https://x/a', undefined, 'HEAD'), res(200)), {
    mode: 'shared',
  });
  assert.equal(d.storable, true);
});

test('Expires 无法解析时不算显式过期（也不产生新鲜期）', () => {
  const d = decideStorage(
    input(req('https://x/a'), res(500, { expires: '0', date: httpDate(T0) })),
    { mode: 'shared' },
  );
  assert.equal(d.storable, false);

  const fl = freshnessLifetime(
    normalizeResponse(
      res(200, new HeadersLite({ expires: '0', date: httpDate(T0) })),
    ),
    { mode: 'shared' },
    T0,
  );
  assert.equal(fl.source, 'none');
  assert.equal(fl.explicit, false);
});
