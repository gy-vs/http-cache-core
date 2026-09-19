# http-cache-semantics-kernel

按 [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111) 实现的 HTTP 缓存**语义内核**。
只做判定，不发请求、不起服务、不落盘、没有命令行入口：

- 网络层由调用方通过回调接入（条件再验证）；
- 存储默认是进程内 LRU，实现 `CacheStore` 接口即可换成任意后端；
- 当前时间可从外部注入，方便测试所有与时间有关的分支。

无第三方运行时依赖，不基于 `http-cache-semantics` / `make-fetch-happen` /
`cacheable-request`，判定逻辑全部在本仓库内，出问题可直接改。

## 安装与构建

```bash
npm install
npm run build   # tsc，产物在 dist/，类型声明随包导出
npm test        # node:test，编译到 dist-test/ 后运行
```

要求 Node >= 20，TypeScript 源码即 npm 包内容。

## 三层 API

### 1. 单条响应策略 `ResponsePolicy`

存储决策、年龄/新鲜期、命中判定，全部是纯计算：

```ts
import { ResponsePolicy } from 'http-cache-semantics-kernel';

const policy = new ResponsePolicy(
  { method: 'GET', headers: requestHeaders },
  { status: 200, headers: responseHeaders },
  { requestTimeMs: t0, responseTimeMs: t1 },
  { mode: 'shared', now: () => Date.now() }, // mode: 'shared' | 'private'
);

const storage = policy.canStore();
// { storable, reason?, freshnessLifetimeSec,
//   staleWhileRevalidateSec, mustRevalidateBeforeUse }

const decision = policy.evaluate(newRequestHeaders);
// { state: 'serve' | 'stale-serve' | 'revalidate' | 'gateway-timeout',
//   ageSec, freshnessLifetimeSec, remainingFreshnessSec, reason?, ... }
```

`mode` 在构造时选择，私有缓存与共享缓存的差异（`private`、`s-maxage`、
`proxy-revalidate`、`Authorization` 放行条件）都在内部处理。

### 2. 再验证原语

```ts
import { conditionalHeaders, mergeNotModified } from 'http-cache-semantics-kernel';

// 有 ETag 给 If-None-Match；只有 Last-Modified 给 If-Modified-Since；都有都带
const headers = conditionalHeaders(storedEntry);

// 304 回来后：304 携带的头按字段整体替换、未携带的保留原值，
// Content-Length 删除，状态码与响应体不动；再用新事务时刻重算新鲜度。
const merged = mergeNotModified(storedEntry, { headers: notModifiedHeaders }, times, request);
if (merged === null) /* 合并后已不可存储，删除旧条目 */;
```

### 3. 编排器 `Cache`

Vary 选择、LRU 落库、304 合并/200 替换、stale-while-revalidate 后台刷新
（同一变体并发去重）：

```ts
const cache = new Cache({ mode: 'shared', maxEntries: 1000, now: myClock });

// 源站响应回来后落库（内部先跑 canStore）
cache.put({ request, response, times: { requestTimeMs, responseTimeMs } });

// 一站式：新鲜直接返回；SWR 窗口内返回旧副本并后台刷新；过期则等待回调
const result = await cache.handle(request, async ({ entry, conditionalHeaders }) => {
  const upstream = await myFetch(request.url, { headers: conditionalHeaders });
  return { response: upstreamResponse(upstream), times: measure(upstream) };
});
// result.kind:
//   cached         直接命中（带 background 时后台再验证已触发）
//   revalidated    条件请求完成（replaced=false 是 304，true 是 200）
//   passthrough    再验证拿到完整响应但不可缓存：result.upstream 是要直接
//                  返回给下游的原始响应（请求已经发出，不要再发一次）
//   miss           没有副本，调用方自行请求后 put
//   gateway-timeout only-if-cached 无副本，回 504
//   invalidated    304 合并后变得不可存储（如新 no-store），旧条目已删除
```

只想要判定、不触发任何动作时用 `cache.match(request)`。

## 语义约定（与两次事故对应的几条）

- **年龄（§4.2.3）**：`corrected_age = max(apparent, Age + 请求往返)`，
  `apparent = 响应收到时刻 - Date` 并钳为非负。上游时钟再快，年龄也不会
  算成负数或偏小；响应里的 `Age` 头与本地请求往返耗时都计入。
- **新鲜期优先级（§4.2.1/4.2.2）**：共享模式 `s-maxage` > `max-age` >
  `Expires` > 启发式；私有模式忽略 `s-maxage`。用 `Expires` 时与**响应
  自己的 Date 头**做差，不与本地当前时间比较 —— 上游时钟快慢被吸收。
- **启发式**：`(Date - Last-Modified) × 10%`，默认上限 24h；
  比例与上限均可在构造选项里配置。
- **可存储性（§3）**：请求或响应 `no-store` 拦截；非 GET/HEAD 不存；
  默认可缓存状态码为 200/203/204/206/300/301/308/404/405/410/414/501，
  其余状态码只有携带显式新鲜度信息才放行；共享缓存下带 `Authorization`
  的响应默认不存，除非响应带 `must-revalidate`、`public` 或 `s-maxage`。
- **Vary（§4.1）**：按响应列出的请求头选择变体，同一目标下多份共存；
  值不一致是未命中，不覆盖旧副本；`Vary: *` 永不命中。
- **请求指令（§5.2.1）**：`no-cache` 强制再验证；`max-age` / `min-fresh`
  可让新鲜响应不可用；`max-stale` 可让过期响应可用（无值=任意时长）；
  `only-if-cached` 无副本时明确给出 `gateway-timeout`。
- **SWR**：窗口内过期副本立即返回，后台再验证通过回调发出，调用方不
  等待；同一变体的并发再验证共享同一个 Promise，只发一次条件请求。

## 换存储后端

实现 `CacheStore`（见 `src/store.ts`）并在构造时传入即可。一个 slot
对应一个主键下的一个 Vary 变体；容量上限只约束默认的 `MemoryStore`。

## 时间注入

所有时间都是毫秒时间戳。构造选项 `now?: () => number` 默认用
`Date.now()`；测试时传入可手动推进的假时钟即可，见 `test/helpers.ts`。

## 目录

```
src/
  types.ts       对外类型
  headers.ts     头容器 HeaderBag、Vary 解析与选择
  directives.ts  Cache-Control / Age 解析
  time.ts        HTTP-date 解析与时间工具
  policy.ts      存储决策、年龄、新鲜期、命中判定（语义内核）
  revalidate.ts  条件请求头生成、304 合并
  store.ts       CacheStore 接口与内存 LRU
  cache.ts       编排器：落库、匹配、再验证、SWR 去重
  index.ts       统一导出
test/            node:test 测试（时钟偏移、Vary、304、并发再验证等）
```
