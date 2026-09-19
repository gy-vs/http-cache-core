import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVary, selectorKey, varyMatches } from '../src/vary.js';
import { HeadersLite } from '../src/headers.js';

test('parseVary：大小写不敏感、去空白、去重', () => {
  const spec = parseVary(new HeadersLite({ vary: 'Accept-Encoding , accept-encoding, accept-language' }));
  assert.deepEqual(spec.fields, ['accept-encoding', 'accept-language']);
  assert.equal(spec.wildcard, false);
});

test('Vary: * 被单独标记', () => {
  const spec = parseVary(new HeadersLite({ vary: '*' }));
  assert.equal(spec.wildcard, true);
  assert.deepEqual(spec.fields, []);
});

test('选择器：同值命中，不同值不命中；缺头与空值等价', () => {
  const spec = parseVary(new HeadersLite({ vary: 'Accept-Encoding' }));
  const gzip = new HeadersLite({ 'accept-encoding': 'gzip' });
  const gzip2 = new HeadersLite({ 'accept-encoding': 'gzip' });
  const br = new HeadersLite({ 'accept-encoding': 'br' });
  const none = new HeadersLite();
  const empty = new HeadersLite({ 'accept-encoding': '' });

  const key = selectorKey(spec.fields, gzip);
  assert.equal(varyMatches(spec, key, gzip2), true);
  assert.equal(varyMatches(spec, key, br), false);
  assert.equal(varyMatches(spec, key, none), false);
  assert.equal(varyMatches(spec, key, empty), false);
  // 缺头与「值为空串的头」是不同的字段值（RFC 9111 4.1 按字段值选择），
  // 二者互不命中；同样是缺头的请求可以命中。
  const noneKey = selectorKey(spec.fields, none);
  assert.equal(varyMatches(spec, noneKey, none), true);
  assert.equal(varyMatches(spec, noneKey, empty), false);
  assert.notEqual(noneKey, selectorKey(spec.fields, empty));
});

test('多值头按值集合逐字节比较，值中分隔符不会造成键碰撞', () => {
  const spec = parseVary(new HeadersLite({ vary: 'x-a, x-b' }));
  const k1 = selectorKey(spec.fields, new HeadersLite({ 'x-a': 'a', 'x-b': 'b' }));
  const k2 = selectorKey(spec.fields, new HeadersLite({ 'x-a': 'a",x-b="b' }));
  assert.notEqual(k1, k2);
});

test('Vary: * 对任何请求都不命中', () => {
  const spec = parseVary(new HeadersLite({ vary: '*' }));
  assert.equal(varyMatches(spec, '', new HeadersLite({ 'accept-encoding': 'gzip' })), false);
  assert.equal(varyMatches(spec, '', new HeadersLite()), false);
});
