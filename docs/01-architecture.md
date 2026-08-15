# 01 · 整体架构与模块划分

> 把任意 Git 仓库抽象成嵌入式云端数据库——像 SQLite 一样「进程内嵌入、零配置」，但底层持久层是云端 Git 仓库。Git 仓库 = 工作内存的后端存储。

## 一、调研要点速览

| 被调研对象 | 对 GitLite 的启发 |
|---|---|
| **SQLite** | 「无服务器、单文件、零配置、进程内嵌入、ACID、`fopen()` 的替代品」——GitLite 要做「Git 上的 fopen()」：一个连接对象 + 一条连接字符串（仓库 URL），开箱即用。 |
| **isomorphic-git** | 纯 JS Git 内核，BYO `fs` + BYO `http`，同一份代码跑 Node/浏览器/Worker。这是「Provider Abstraction Layer」的雏形：文件系统后端和网络传输后端做成可注入接口。 |
| **Decap CMS / TinaCMS** | TinaCMS 的 **Data Layer = Bridge（读取源）+ Database（索引缓存）** 是关键模板：Markdown 是 source of truth，DB 是临时缓存，靠 webhook 增量重建索引。 |
| **libgit2 / nodegit** | libgit2 证明「Git 内核做成可嵌入库」可行；nodegit 是其 Node 绑定，但**原生编译痛、libgit2 版本锁定、Serverless 不友好**——选型时要规避。 |

## 二、分层架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│  L7  消费层  Consumers                                               │
│      ┌──────────┐   ┌──────────┐   ┌────────────┐   ┌────────────┐ │
│      │  CLI     │   │ SDK (TS) │   │ REST/GraphQL│  │  Web UI    │ │
│      └────┬─────┘   └────┬─────┘   └─────┬──────┘  └─────┬──────┘ │
└───────────┼──────────────┼───────────────┼───────────────┼────────┘
┌───────────▼──────────────▼───────────────▼───────────────▼────────┐
│  L6  SDK / API Gateway  对外统一 API 面                              │
│      connect(uri) -> DB ; db.collection(x).find/insert/update      │
│      事务边界入口、连接池、限流、审计日志                              │
└───────────────────────────────┬────────────────────────────────────┘
┌───────────────────────────────▼────────────────────────────────────┐
│  L5  Query Engine  查询引擎                                          │
│      解析查询 AST → 谓词下推 → 走索引或全表扫 → 结果聚合/排序/分页     │
└───────────────┬───────────────────────────────┬────────────────────┘
┌───────────────▼───────────┐   ┌───────────────▼────────────────────┐
│  L5a Schema Layer 模式层  │   │  L4  Transaction Manager 事务管理器  │
│  collection/field 定义     │   │  begin/commit/rollback；写意图日志    │
│  校验、序列化、路径映射     │   │  冲突检测、重试、隔离级               │
└───────────────┬───────────┘   └───────────────┬────────────────────┘
                └───────────────┬───────────────┘
┌───────────────────────────────▼────────────────────────────────────┐
│  L3  Storage Engine  存储引擎（DB 概念 ↔ Git 文件映射）               │
│      table=目录  row=文件  cell=文件内字段  index=sidecar JSON       │
│      读写都先打 In-Memory Mirror，不直接碰 Git                       │
└───────────────┬───────────────────────────┬────────────────────────┘
┌───────────────▼───────────┐   ┌───────────▼────────────────────────┐
│ L2a In-Memory Mirror 本地 │   │ L2b Sync/Cache Engine 同步缓存引擎  │
│  内存镜像（Bridge+Cache） │<──│  pull/fetch 增量、push 提交、        │
│  文件树影子 + 索引缓存     │   │  webhook 监听、后台同步队列          │
└───────────────┬───────────┘   └───────────────┬────────────────────┘
                └───────────────┬───────────────┘
┌───────────────────────────────▼────────────────────────────────────┐
│  L1  Provider Abstraction Layer  Git 供应商抽象                      │
│  interface GitProvider { clone/fetch/push/readBlob/writeBlob/... }  │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────┐ │
│   │ GitHub      │  │ Gitee       │  │ GitLab      │  │ Local FS │ │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └────┬─────┘ │
└──────────┼─────────────────┼───────────────┼───────────────┼───────┘
┌──────────▼─────────────────▼───────────────▼───────────────▼───────┐
│  L0  Kernel  Git 内核（可换实现）                                     │
│   ┌────────────────────┐  ┌────────────────────┐  ┌──────────────┐│
│   │ isomorphic-git     │  │ libgit2/nodegit    │  │ 原生 git CLI ││
│   │ (默认/浏览器/边缘)  │  │ (高性能 Node)      │  │ (兜底)       ││
│   └────────────────────┘  └────────────────────┘  └──────────────┘│
└────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  Auth Module  鉴权（横切，被 L1/L6 共用）                            │
│  PAT / OAuth App / GitHub App / Gitee 私有令牌 / SSH Key            │
│  凭证保险箱、scope 校验、令牌刷新                                    │
└────────────────────────────────────────────────────────────────────┘
```

**主数据流向：**
- 读路径：`Consumer → Gateway → QueryEngine → (Schema校验) → StorageEngine → InMemoryMirror（命中即返回）↕ SyncEngine ↕ Provider → Kernel → 远端 Git`
- 写路径：`Consumer → Gateway → TransactionManager（开事务、记意图）→ StorageEngine（改 Mirror）→ SyncEngine（commit+push，可同步或异步）→ Provider → Kernel → 远端 Git`

## 三、核心模块清单与职责

### 1. Provider Abstraction Layer（L1）
统一不同 Git 托管平台差异（API 限速、分支模型、Webhook、二进制存储、PR/MR）。

```ts
interface GitProvider {
  readonly id: 'github' | 'gitee' | 'gitlab' | 'local';
  clone(opts): Promise<Ref>;
  fetch(ref: string, depth?: number): Promise<FetchResult>;
  push(ref: string, force?: boolean): Promise<PushResult>;
  readBlob(oid: string): Promise<Buffer>;
  writeBlob(content: Buffer): Promise<string>;
  listCommits(ref: string, opts?): Promise<Commit[]>;
  capabilities(): ProviderCapabilities;
  createBranch(name: string, from: string): Promise<void>;
  createPullRequest(opts: PROpts): Promise<PRHandle>;
  getRateLimit(): RateLimitInfo;
}
```

### 2. Storage Engine（L3）
DB 概念映射到 Git 文件系统的核心翻译层。

| DB 概念 | Git 映射 | 说明 |
|---|---|---|
| Database | 一个 Git 仓库 | 单仓多库用根目录隔离 |
| Table / Collection | 仓库内目录 `db/<collection>/` | |
| Row / Document | 目录下文件 `db/<collection>/<id>.json` | id 即文件名 |
| Cell / Field | JSON 文件内 key | |
| Index | `db/_indexes/<collection>_<field>.json` | sidecar，加速查询 |
| Schema | `db/_schema/<collection>.schema.json` | 版本化，受事务保护 |
| Transaction Log | 临时分支 `refs/heads/_tx/<txid>` | commit 链即 WAL |

### 3. Schema Layer（L5a）
```ts
defineCollection({
  name: 'users',
  path: 'db/users',
  primaryKey: 'id',
  fields: {
    id:    { type: 'string', required: true },
    name:  { type: 'string' },
    age:   { type: 'number', index: true },
    tags:  { type: 'array',  items: 'string' },
  },
  indexes: [{ fields: ['age'] }],
});
```

### 4. Query Engine（L5）
```ts
db.collection('users')
  .find({ age: { $gt: 18 }, tags: 'vip' })
  .sort({ name: 1 })
  .skip(20).limit(10)
  .toArray();
```

### 5. Sync / Cache Engine（L2b）
```ts
interface SyncEngine {
  pull(opts: { ref: string; incremental: true }): Promise<SyncReport>;
  push(opts: { ref: string; mode: 'sync'|'async' }): Promise<PushResult>;
  status(): SyncStatus;              // { ahead, behind, dirty }
  onRemoteChange(cb: (e: WebhookEvent) => void): void;
  enqueue(task: WriteTask): Promise<TaskId>;
}
```

### 6. Transaction Manager（L4）
```ts
const tx = await db.beginTransaction();
try {
  await tx.collection('users').insert({...});
  await tx.collection('orders').insert({...});
  await tx.commit();      // fast-forward merge 到主分支 + push
} catch (e) { await tx.rollback(); }
```

### 7. Auth Module（横切）
```ts
interface AuthModule {
  addCredential(provider: ProviderId, cred: Credential): Promise<void>;
  resolve(provider: ProviderId): Promise<ResolvedCredential>;
  validateScopes(provider, scopes: string[]): Promise<ScopeCheck>;
}
```

### 8. SDK / API Gateway（L6）
```ts
const db = await GitLite.connect('gitlite://github:owner/repo?ref=main', {
  auth: { token: process.env.GH_TOKEN },
  sync: { mode: 'auto', interval: 30_000 },
});
```

### 9. CLI
```bash
gitlite connect owner/repo
gitlite query 'users.find({age:{$gt:18}})'
gitlite insert users --data '{"id":1,"name":"a"}'
gitlite sync --push
gitlite migrate add-field users email:string
```

## 四、模块依赖关系

```
CLI ─────► SDK/Gateway ─────► QueryEngine ──► StorageEngine ──► InMemoryMirror
                                  │                │                  │
                                  ▼                │                  │
                              SchemaLayer ◄────────┘                  │
                                  │                                   │
              TransactionManager ◄┘                                   │
                  │   │                                              │
                  │   └────► StorageEngine（写意图落地）                │
                  ▼                                                  ▼
              SyncEngine ◄───────────────────── InMemoryMirror（一致性）─┘
                  │
                  ▼
              Provider Abstraction ──► Kernel(isomorphic-git / libgit2)
                  ▲
                  │
              Auth Module（凭证注入）
```

**依赖规则（单向、无环）：**
- 上层依赖下层，禁止反向。
- 横切模块（Auth、Transaction）可被任意层调用，但自身不反向依赖业务层。
- **Provider Abstraction 是唯一允许接触 Kernel 的层**——Kernel 可整体替换而不影响上层。
- SyncEngine 与 InMemoryMirror 双向协作：Mirror 是 SyncEngine 的缓存载体，SyncEngine 负责 Mirror 与远端的一致性。

## 五、本地内存抽象如何实现

借鉴 **TinaCMS 的 Bridge + Database** 双层模型 + **SQLite 的「内存页缓存」** 思路。

### 5.1 双层结构
```
┌─────────────────────────────────────────────┐
│  In-Memory Mirror（进程内，进程生命周期）     │
│  ┌──────────────┐  ┌────────────────────┐  │
│  │ FileTree 影子 │  │ Index Cache        │  │
│  │ (路径→Buffer) │  │ (field→[ids])      │  │
│  └──────────────┘  └────────────────────┘  │
│         ▲ 读命中             ▲ 写入        │
└─────────┼───────────────────┼─────────────┘
          │                   │
   读未命中│           写提交│
          ▼                   ▼
┌─────────────────────────────────────────────┐
│  Local Working Copy（可选持久层，LightningFS/真实 .git）│
└─────────────────────┬───────────────────────┘
                      │ fetch/push
                      ▼
              远端 Git 仓库（GitHub/Gitee）
```

### 5.2 读写时序（伪代码）

**读（缓存优先）：**
```ts
async read(path) {
  if (mirror.has(path)) return mirror.get(path);     // L1 命中
  const blob = await provider.readBlob(path);        // L2 未命中走 Provider
  mirror.set(path, blob);                            // 回填
  return blob;
}
```

**写（写穿 Mirror，落盘可同步可异步）：**
```ts
async write(path, content) {
  const tx = currentTx();
  mirror.set(path, content);                         // 立即可见（未提交读）
  tx.recordIntent({ op: 'write', path, content });   // 记意图到事务
}

async commit() {
  const staged = tx.collectIntents();
  for (const w of staged) await workingCopy.write(w.path, w.content);
  const commitSha = await kernel.commit({ message: tx.id, ... });
  if (config.sync.mode === 'sync') await provider.push(ref);
  else syncEngine.enqueue({ type: 'push', ref, commitSha });
  mirror.advance(commitSha);
}
```

### 5.3 一致性策略
- **读已提交**：事务内写对其它事务不可见，直到 commit。
- **快照隔离**：每个读会话绑定一个 `commitSha`，整段读都基于该快照——Git 内容寻址免费提供。
- **冲突处理**：push 失败 → fetch → rebase 临时分支 commit → 重试；无法自动解决则回滚抛 `ConflictError`。
- **后台同步**：`syncEngine` 周期性 fetch 增量、按 webhook 重建 Index Cache。

## 六、技术栈建议

| 维度 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（严格模式） | 类型安全 + 生态广；isomorphic-git 原生 TS |
| 运行时（主） | Node.js 20+ LTS | 异步 I/O 适合 Git 网络操作 |
| 运行时（边缘/浏览器） | 同一份 TS，跑 Workers / 浏览器 | isomorphic-git 纯 JS 无原生依赖，BYO fs/http |
| Git 内核（默认） | isomorphic-git + LightningFS | 纯 JS、零原生编译、跨环境 |
| Git 内核（高性能可选） | nodegit / spawn git | 大仓库、批量迁移；通过 Provider 接口可选注入 |
| HTTP 客户端 | undici / fetch | 现代、流式、原生 fetch 兼容 |
| 鉴权存储 | keytar（桌面）/ 环境变量（服务端）/ 内存（边缘） | |
| 查询解析 | 自研轻量 AST（仿 MongoDB query） | 避免引入完整 SQL 引擎 |
| CLI 框架 | citty / clipanion | 轻量、TS 友好 |
| 测试 | vitest + 真实 fixture 仓库 | 单测用内存 Mirror，集成测用沙盒仓库 |
| 打包 | tsup（库）/ unbuild（CLI） | ESM+CJS 双产物 |

## 七、三大架构风险与应对

### 风险 1：性能——Git 不是数据库，频繁小写 + 网络往返极慢
- 写**默认异步批量化**：多次 `insert` 合并到一次 commit，后台队列按时窗/数量 flush。
- 强制走**本地内存镜像**：读永远先命中 Mirror，热数据零网络。
- Index sidecar + 增量 fetch（按 commit oid 差量）避免全量重拉；webhook 触发后台预热索引。
- 限速熔断：SyncEngine 内置 token bucket，接近阈值时排队降级。

### 风险 2：并发写冲突——Git 单分支线性历史 vs 多客户端并发写
- **事务分支化**：每个写事务开临时分支 `_tx/<id>`，commit 在隔离分支完成，最后 fast-forward 合并。
- **乐观并发 + 自动 rebase**：push 失败 → fetch → rebase → 重试，指数退避。
- **冲突粒度收敛到文件**：改不同文件视为无冲突自动合并；改同文件才触发 `ConflictError`。

### 风险 3：Kernel 依赖锁定与可移植性
- **Provider Abstraction 是唯一接触 Kernel 的层**：所有上层只依赖 `GitProvider` 接口。
- **能力探测而非版本假设**：`provider.capabilities()` 运行时探测。
- **三内核适配器并存**：isomorphic-git（默认）、nodegit（高性能）、git-cli（兜底）。

## 八、总结

GitLite 的架构本质是 **「SQLite 的嵌入式哲学 + TinaCMS 的 Bridge/Cache 双层 + isomorphic-git 的可注入内核」**：

1. **嵌入式体验**（SQLite）：`connect(uri)` 即用，零配置、进程内、ACID。
2. **本地内存抽象**（TinaCMS Data Layer）：In-Memory Mirror 作缓存、Git 文件作 source of truth、webhook 增量同步。
3. **供应商无关 + 内核可换**（libgit2 + isomorphic-git）：Provider Abstraction 隔离平台差异，Kernel 适配器隔离 Git 实现差异。
