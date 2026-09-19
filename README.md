# http-cache-kernel

RFC 9111（HTTP Caching）的**缓存语义内核**：只管判定逻辑，不发请求、不起服务、
不做持久化，也没有命令行入口。网络层与存储后端由调用方接入。

适用于接口聚合层 / 反向代理 / SDK 内部缓存这类自己掌控请求链路的场景。

- 语言：TypeScript（strict），运行时 Node.js >= 20
- 零运行时依赖
- 当前时间可注入（默认 `Date.now()`），方便测试所有时间分支
- 内存存储带两级 LRU，存储为接口可整体替换

## 安装与构建

```bash
npm install
npm run build   # 产出 dist/
npm test        # tsc 类型检查 + node --test
```

## 模块划分

| 模块 | 职责 |
| --- | --- |
| `policy.ts` | 存储决策（§3）、年龄（§4.2.3）、新鲜期（§4.2.1/4.2.2）、请求指令（§5.2.1）、命中评估 |
| `vary.ts` | Vary 解析与选择器匹配（§4.1） |
| `revalidate.ts` | 条件请求头生成（§4.3.1）、304 合并与年龄更新（§4.3.4） |
| `store.ts` | `CacheStore` 接口 + 内存 LRU 实现 |
| `cache.ts` | 编排层：`put` / `lookup` / `revalidate` / `request`，single-flight、SWR |
| `headers.ts` / `time.ts` / `types.ts` | 头容器、HTTP 日期与 Cache-Control 解析、公共类型 |

## 快速上手：编排层

```ts
import { Cache } from 'http-cache-kernel';

const cache = new Cache({
  mode: 'shared',          // 'shared'（默认）或 'private'
  clock: () => Date.now(), // 测试时注入假时钟
  storeOptions: { maxEntries: 2000, maxVariantsPerEntry: 64 },
  heuristic: { ratio: 0.1, maxLifetimeMs: 24 * 3600_000 },
});

// 1) 上游响应回来后：决定能不能存、存多久，能存就落库
const put = cache.put({
  request: { method: 'GET', target: url, headers: reqHeaders },
  response: { status, headers: resHeaders, body },
  requestTime,            // 你记录的请求发出时刻
  responseTime,           // 响应完整收到时刻
});
if (!put.stored) console.log(put.decision.reason);

// 2) 请求进来：一条调用拿到全部缓存决策
const result = await cache.request(
  { method: 'GET', target: url, headers: reqHeaders },
  async ({ request, conditional, conditionalPossible }) => {
    // 再验证的 HTTP 请求由你自己发。conditionalPossible=false 时只能整取。
    const upstream = await myHttpFetch(request, {
      headers: Object.fromEntries(conditional.entries()),
    });
    return {
      status: upstream.status,
      headers: upstream.headers,
      body: upstream.body,
      requestTime: upstream.sentAt,
      responseTime: upstream.receivedAt,
    };
  },
);

switch (result.state) {
  case 'hit':                      // 新鲜副本，直接返回
  case 'stale-served':             // max-stale 放行的过期副本
  case 'stale-while-revalidate':   // 立即返回旧副本，再验证已在后台
    respond(result.variant.response);
    break;
  case 'revalidated':
    // 304：result.variant 是合并后的副本；200/其他：用 result.outcome.response
    break;
  case 'miss':
  case 'unusable':                 // 你发完整请求，回来后 cache.put(...)
    break;
  case 'gateway-timeout':          // only-if-cached 无副本 -> 回 504，不要发请求
    respond(504);
    break;
}
```

### stale-while-revalidate 与并发去重

- SWR 窗口内：`request()` 立刻返回过期副本，再验证在后台执行；
- 同一个 `(method, target, Vary 选择器)` 上并发的多个请求只触发**一次**
  后台/同步再验证，其余请求共享同一个在途 Promise（single-flight），
  不会向同一上游打出一串重复条件请求；
- 后台再验证失败不会影响已经返回的副本，失败经 `onBackgroundError` 回调暴露。

## 直接用语义内核（不经过编排层）

存储决策是纯函数，输入请求方法/目标/请求头、状态码/响应头，以及本地记录的
请求发出与响应收到时刻：

```ts
import { decideStorage } from 'http-cache-kernel/policy';

const decision = decideStorage(
  { request, response, requestTime, responseTime },
  { mode: 'shared' },
);
// decision.storable / reason / freshForMs / staleWhileRevalidateMs
```

## 关键语义说明（对照两次事故）

### 年龄与时钟偏差（§4.2.3）

响应年龄**不是**「当前时间 − Date 头」。初始年龄取两个候选的最大值：

```
max( apparent_age,                       // responseTime − Date（钳到 >=0）
     age_value + response_delay )        // Age 头 + 本地往返耗时
```

- 上游时钟偏快（Date 是未来时间）：`apparent_age` 被钳为 0，不会出现负年龄，
  也不会因为取了未来 Date 而让年龄偏小；Age 头分支照常生效。
- 上游时钟偏慢：`apparent_age` 自然把偏差计入年龄。
- 请求发出到响应收到的往返时间计入年龄；存储后年龄从响应收到时刻继续推进，
  RTT 不会被重复计算。

### 新鲜期优先级（§4.2.1 / 4.2.2）

```
共享缓存：s-maxage  >  max-age  >  Expires − Date(响应自己的)  >  启发式
私有缓存：            max-age  >  Expires − Date(响应自己的)  >  启发式
```

- 用 `Expires` 时是与**响应自己的 Date 头**做差，绝不与本地当前时间比较——
  上游时钟快 40 秒不会再让响应提前 40 秒被判过期。
- 无法解析的 `Expires`（例如 `0`、ISO 字符串）视为该字段不存在。
- 三样都没有时走启发式：`(Date − Last-Modified) × ratio`，默认 10%，
  默认上限 24 小时，上下限与比例均可配置。

### 可存储性（§3）

- 响应或请求带 `no-store` 一律不存。
- 共享缓存下 `private` 不存；`Authorization` 请求的响应默认不存，
  除非响应显式带 `public`、`must-revalidate` 或 `s-maxage`。
- 默认 GET/HEAD 可缓存；默认可缓存状态码：
  `200 203 204 206 300 301 308 404 405 410 414 501`。
- 默认不可缓存的状态码，在响应带**显式过期信息**
  （`max-age` / `s-maxage` / 合法 `Expires`）时允许存储。
- 非默认可缓存方法（如 POST）的响应，只有显式过期且状态码可缓存时才存。
- 方法、状态码集合与「允许缓存」的扩展指令都可在构造时配置。

### 请求侧指令（§5.2.1）

| 指令 | 行为 |
| --- | --- |
| `no-cache`（及无 Cache-Control 时的 `Pragma: no-cache`） | 强制先再验证，即使副本新鲜 |
| `max-age=N` | 当前年龄超过 N 秒则副本不可用（直接转发，不静默放行） |
| `min-fresh=N` | 剩余新鲜时间不足 N 秒则不可用 |
| `max-stale[=N]` | 过期不超过 N 秒（裸用则任意时长）的副本仍可用；`must-revalidate` 可压过它 |
| `only-if-cached` | 无可用副本时给出明确的 `gateway-timeout`（调用方回 504），绝不发请求 |

### Vary（§4.1）

- 存储时把响应 `Vary` 列出的请求头值编码成选择器一并保存；
- 同一 `(method, target)` 下不同选择器的响应**并存多份**，新选择器不覆盖旧副本；
- `Vary: *` 的响应可以存，但对任何请求都不命中（`lookup` 返回 `wildcard`）；
- 选择器按字段值逐字节比较（头值经过 JSON 编码，分隔符不会造成键碰撞）。

### 再验证（§4.3）

- 有 `ETag` 发 `If-None-Match`；只有 `Last-Modified` 发
  `If-Modified-Since`；两者都有就都带。
- 304：头是**合并**不是替换——304 里带的端到端头覆盖同名头，没带的保留，
  hop-by-hop 固定字段与 `Connection` 里列出的字段不写入，状态码与响应体不动；
  合并后按 §4.3.4 重算年龄，并保证年龄不会比合并前更小。
- 200：视为一份新响应，重新走完整存储决策；不可存时删除旧副本。
- 其他状态（如 5xx）不改动已存副本，交给调用方策略处理。

## 替换存储后端

实现 `CacheStore`（见 `store.ts`）即可接 Redis / SQLite 等：

```ts
import type { CacheStore } from 'http-cache-kernel/store';

class RedisStore implements CacheStore {
  // get / set / delete / size / clear
  // putVariant / getVariant / deleteVariant / touchVariant
}

new Cache({ store: new RedisStore() });
```

存储按「目标条目 + Vary 变体」两级组织；全局 LRU 淘汰粒度是整个目标条目，
单条目内还有变体数上限（默认 64）。

## 测试

```bash
npm test
```

使用 Node 自带的 `node:test`。重点覆盖：上游时钟偏快/偏慢、Age 头、往返耗时、
Vary 各分支（含 `*` 与并存不覆盖）、304 头合并与年龄不倒退、
SWR 窗口与并发 single-flight、请求侧五条指令、LRU 两级淘汰。
所有时间相关用例都通过注入的假时钟驱动，无需真实等待。

## 明确不做的事

- 不内置任何 HTTP 客户端，再验证请求一律走调用方传入的回调；
- 不做磁盘持久化与序列化（body 是不透明值）；
- 不提供服务框架集成与命令行；
- 不依赖也不照搬 `http-cache-semantics` / `make-fetch-happen` /
  `cacheable-request`，所有判定逻辑在本库内可直接修改。
