# GitLite 项目记忆（设计期存档）

> 项目级规则、约束、约定与设计决策。适用于当前项目 GitLite 的所有会话。
> ⚠️ 2026-08-16 起本文转为存档：AI 协作入口见 [AGENTS.md](./AGENTS.md)，进度唯一入口见 [docs/progress.md](./docs/progress.md)；本文与 docs/ 冲突时以 docs/ 为准。

## 项目定位

**GitLite** —— 对标 SQLite，强调「像 SQLite 一样嵌入在本地，但原生连通云端 Git 仓库」。

把任意 Git 仓库（首先 GitHub、Gitee）抽象成嵌入式云端数据库：把远程仓库当成本地工作内存来用（类似 Java 的抽象工作内存）。上层应用通过简单易用的 API 操作仓库，无需公网 IP、无需服务器。

**核心映射规则（不可动摇）：**

- **database = 分支（默认）**：默认仓库名 `gitlite-repo`（用户提议），库 = `gitlite/<库名>` 分支；主因：Gitee 免费私有仓上限 5 个，一仓库存所有库只占 1 个配额。备选仓库模式（整仓即库）给写密集用户分摊 GitHub 按仓库计的 push 限流（6/min/repo）
- URI：`gitlite://<provider>:<auth>@<owner>/<repo>[/<database>]`，带 database = 分支模式，省略 = 仓库模式
- 建库/列库/删库 = 建分支/列分支（过滤 `gitlite/` 前缀）/删分支；`GitLite.databases.create/list/drop` + `gitlite db` CLI
- collection = 目录（表）
- **行分级存储（用户关心文件数问题的解答）**：
  - L0 inline `<collection>.jsonl` 单文件（<50 行，配置表）
  - L1 doc-per-file `<collection>/<id>.json` 一行一文件（<5000 行，默认）
  - L2 sharded `<collection>/shard-NNNN.jsonl` 千行一分片（5k–100k 行）
  - 分片 = `min(1000 行, 512KB)`（必须 <1MB：Gitee 降级走 Contents API 有单文件 1MB 硬限）；ULID 前缀范围分片（时间聚簇）；主键索引定位 id→分片；冲突按行 `_id` diff 后字段级三路合并；超 1500 行自动 split；级别迁移带 1.2× 迟滞记入 `_migrations/`
  - 驱动约束：GitHub Tree API 10 万条目截断、Contents 列表每页 1000 条、blob 逐个 API 开销
  - schema `"storage": "auto|inline|doc-per-file|sharded"`；查询/索引层完全不感知存储级别
- commit = 事务（原子）
- 分支 = 沙箱（长事务，注意与 database 分支命名空间共存：database 用 `gitlite/<name>`，事务用 `gitlite/tx/<txId>`，前缀区分）
- 索引文件 = `/_indexes/*.idx.json`
- schema 文件 = `/_schema/*.schema.jsonc`
- 系统目录约定以 `_` 开头（`_schema`/`_indexes`/`_migrations`/`_meta`），用户 collection 名禁止以 `_` 开头

## 关键设计决策

### 架构（7 层单向依赖）

```
L7 消费层        CLI · SDK(TS) · REST/GraphQL
L6 API Gateway   connect(uri)·连接池·限流·审计
L5 查询引擎      filter AST → 索引或全表扫 → 聚合
L5a 模式层       collection/field 校验·路径映射
L4 事务管理器    begin/commit/rollback·写意图·冲突重试
L3 存储引擎      DB概念↔Git文件映射，读写先打 Mirror
L2 本地内存抽象  In-Memory Mirror + Sync Engine  ← 核心焦点
L1 供应商抽象    GitProvider 接口（GitHub/Gitee/GitLab/Local）
L0 Git 内核      isomorphic-git(默认) / nodegit / git-cli
   远端          GitHub · Gitee
横切  鉴权       OAuth/PAT → 系统凭据库
```

**依赖规则**：单向无环，上层依赖下层；Provider 是唯一接触 Kernel 的层，故 Kernel 可整体替换；Auth/Transaction 为横切模块。

### 技术栈（锁定）

- **语言**：TypeScript（首选）
- **Git 内核**：isomorphic-git（BYO fs/http，跨 Node/浏览器/Worker）
- **包管理**：pnpm monorepo
- **可选**：本地 SQLite 作为高性能索引后端（大数据量场景）
- **License**：MIT

### Provider 抽象关键不对称

**Gitee 缺少 Git DB（trees/blobs/refs/commits）低层 API**。这决定「批量提交」在 GiteeProvider 上只能：
1. 降级为多次单文件 Contents API 调用（非原子），或
2. 切到 isomorphic-git 内核（推荐，原子且离线可用）。

GitHub 有完整 Git DB API：`blobs → trees → commits → refs` 四步原子批量提交。

### 鉴权流程（锁定）

| 平台 | 流程 | 需要 client_secret |
|---|---|---|
| GitHub | Device Flow（首选，CLI/桌面端） | 否，只需公开 client_id |
| GitHub | Authorization Code + PKCE（浏览器端） | 否 |
| Gitee | Authorization Code + Loopback + PKCE | **是**，必须 |

**OAuth App 预置策略**：GitLite 官方预置一对 OAuth App，client_id 公开编译进 binary；client_secret 通过官方 broker 中转，MVP 阶段可内嵌 binary（带风险告警），v1.0 切 broker。

**Token 存储**：优先 OS 凭据库（macOS Keychain / Windows Credential Manager / Linux libsecret），通过 `keytar` 统一封装；fallback 才用加密本地文件并明确告警。

### 数据模型约定

- **默认 ID 策略**：ULID（26 字符，时间有序、URL 安全、客户端独立生成无中心协调）
- **默认存储格式**：JSON；备选 YAML / Markdown frontmatter（内容编辑场景）
- **document 必带字段**：`_id`、`_rev`（内容 SHA-1 前 12 位，用于 OCC）、`_schema`（版本号）
- **timestamps**：schema 声明 `timestamps: true` 自动维护 `createdAt` / `updatedAt`，统一 UTC ISO 8601
- **加密字段**：`_enc.<name>` 前缀，AES-256-GCM，存 `{ alg, iv, ciphertext, tag, kid }`

### 配额软上限（必须遵守）

| 维度 | 软上限 |
|---|---|
| 单 document 大小 | 1 MB（GitHub/Gitee Contents API 上限） |
| 单 collection 文档数 | 100,000（全量内存查询性能拐点） |
| 仓库总大小 | 1 GB |
| 单 commit 文件改动数 | 100 |
| 索引文件大小 | 10 MB（超过则分片） |

引擎在写入前校验，超限抛 `QuotaExceededError`。

### 同步与一致性

**三层缓存**：L1 Hot Cache（进程内 LRU 1000）→ L2 Working Set（In-Memory Mirror）→ L3 Local Persist（磁盘/IndexedDB）→ Remote Git。

**默认同步策略**：自动同步，batchSize=10、timeWindow=3000ms；写乐观入 Mirror + CommitQueue，读 95%+ 命中本地。

**三级一致性契约**：
- `cache`（默认）：直接读缓存，不等同步
- `synced`：等待本地待提交队列 flush 完再读（读自己刚写的）
- `fresh`：强制拉远端 HEAD 比对（跨端协作强一致读）

**默认冲突解决**：字段级三路合并（`field_merge`）；可选 `last_write_wins` / `local_wins` / `remote_wins` / `manual`。

### 事务模型

- **短事务**：txBuffer 暂存 + 单次 commit；任一失败回滚 txBuffer
- **长事务**：临时分支 `gitlite/tx/<txId>` + checkpoint + merge；rollback = 删分支
- **OCC**：document `_rev` + commit 级 `expectedHeadOid` CAS；冲突自动 rebase 重试最多 3 次
- **隔离级别**：Read Committed + Optimistic（近似）；**不提供 Serializable**，这是明确边界

### API 风格

MongoDB / Prisma / Firestore 风格，**不是 SQL**：
- `db.users.findOne({ email })` / `db.users.find({...}).sort({...}).limit(20).toArray()`
- filter 对象 + 操作符（`$eq` `$gt` `$in` `$and` `$or` `$regex` `$elemMatch` 等）
- 更新操作符（`$set` `$inc` `$push` `$pull` `$addToSet` 等）
- 聚合管道（`$match` `$group` `$sort` `$limit` `$lookup` 等）

### 打包与嵌入（用户明确要求的核心能力）

GitLite 定位为**可嵌入基座**：作为纯前端库嵌入其他 app，可打包为 dmg（Electron/Tauri）、exe（Electron/Tauri）、apk（Capacitor/RN）、ipa 发行。

**支撑选型**：isomorphic-git 纯 JS 内核（无 native 依赖）+ RuntimeAdapter 注入（fs/http/crypto/credential）。adapter 家族：`node` / `browser` / `bun` / `electron` / `tauri` / `capacitor` / `react-native`。

**三个必须记住的平台差异：**

1. **Gitee CORS**：GitHub API 官方支持浏览器 CORS；Gitee 未承诺。打包壳（Electron/Tauri/Capacitor/RN）HTTP 走原生层不受 CORS 约束可直连；**纯浏览器页面连 Gitee 需 broker 代理**或降级不可用。Provider 层暴露 `requiresCorsProxy` capability 让 SDK 自动路由告警。
2. **OAuth 回调按壳适配**：CLI/桌面用 loopback；**移动端（apk/ipa）用深链 `gitlite://callback`**（移动端无 localhost）；GitHub Device Flow 免回调、打包形态最省事。Gitee redirect_uri 不支持通配端口 → loopback 端口必须固定为预注册端口。
3. **WebView 存储配额**：移动端 L3 不缓存全量，默认 `index-only` 预热按需拉取；`navigator.storage.estimate()` 探测 + `persist()` 申请；L3 可丢（source of truth 是远端），但**离线队列 `pending.json` 不可丢**，移动端双写 AsyncStorage 镜像。

**凭据存储按形态**：Electron→safeStorage（零 native 模块优先于 keytar）；Tauri→stronghold/keyring 插件；移动端→Keystore/Keychain（Capacitor）/ SecureStore（RN）。

### 交付形态与首次初始化

**交付形态**：npm 包（`@gitlite/sdk` 等），构建期被 bundler 内联进宿主 app 的 bundle，非独立进程/服务/压缩包；CLI 可另发单文件可执行程序。对标「SQLite 被链接进程序」的哲学。

**首次初始化**（对标 `sqlite3.open()` 不存在即建）：`connect` 提供 `createIfMissing` + 自动登录，一次调用串起「取/弹登录 token → 探测仓库（404 则建）→ bootstrap 系统目录（gitlite.config.jsonc / _schema / _indexes/_manifest.json / _meta/head.json）→ 预热」。二次 connect 跳过直接就绪。

**仓库归属三模式**：
- A 开发者自己仓库（写死参数，个人工具）
- B **终端用户自己的仓库**（推荐分发 app 用：登录后取 `user.login` + 约定名 `<app名>-data` 自动建仓，app 零后端、数据跟用户走）
- C 组织共享仓库（团队协作）

Gitee 边界：免费个人私有仓上限 5 个，模式 B 应提供「选择已有仓库」复用入口。

### initDB 与多仓库绑定（用户明确要求的使用方式）

**initDB() 幂等语义**：第一次调用弹内置向导 UI（`@gitlite/ui` 包：选平台→OAuth 登录→选仓库名（默认 `gitlite-repo` 可自定义/可选已有）→选 database 名→仓库检查→完成）；之后调用读本地 `~/.gitlite/bindings.json` 静默直连不弹窗。`force: true` 重新走向导。

**仓库检查三态（安全关键）**：
1. 空仓库（或仅 autoInit README）→ 直接 bootstrap
2. GitLite 标准（有 `gitlite.config.jsonc` + `_meta/head.json`）→ 校验 formatVersion 后直连
3. 非空非标准 → **强制警告页**三选（继续初始化/换仓库/取消）；承诺只添加 `_` 系统文件不动现有文件；headless 用 `onNonGitLiteRepo: 'confirm'|'abort'|(repo)=>Promise` 回调

**双通道原则**：内置 UI 只是默认皮肤，向导每一步都有等价 API（`probeRepo` 返回 `{state:'empty'|'gitlite'|'foreign'}`、`auth.login`、`repos.list`、`connect`）——用户可完全自建设计页面。

**多仓库绑定 + failover**：
- 绑定角色 primary（唯一写入口）/ mirror（只读备胎，低频异步镜像默认延迟 10min）
- mirror 只读的原因：避免双向同步复杂性；failover 时 mirror 升 primary、原 primary 降级待修复
- 链路：primary 限流（403 + Remaining:0）→ cooldown 到 Reset 时间 → mirror 可用则切换（事件 `binding:failover`）→ 全部限流则 fully-local 模式（读写全本地队列持久化，指数退避探测 1min→5min→15min 封顶）
- 诚实代价：双倍存储、API 消耗 ×1.5、镜像延迟（failover 丢的是「他人写到旧 primary 的变更」待 reconcile，不丢本地数据）
- API：`GitLite.bindings.list/add/setPrimary/remove`、`db.bindings.status`（mode: normal/failover/fully-local）；UI 组件 `BindingManager`/`SyncSettings`

**同步频率（用户明确要求分钟级：1/5/10 分钟档，启动退出各强制一次）**：
- economy（默认）：写 **10 分钟**窗口/100 条批量，读**不轮询**，<8 调用/h
- balanced：5 分钟/50 条，pull 5min（~30 调用/h）
- realtime：1 分钟/20 条，pull 1min（~130 调用/h）；**GitLite 不提供秒级同步**（配额刻意设计），秒级实时走 webhook→broker→WebSocket 事件总线
- **强制同步时机（不可关）**：启动 connect 立即 pull+flush 遗留队列；退出/切后台立即 flush
- 安全性论证：写即时落盘 L3 `pending.json`，窗口拉长只影响「其他端可见性延迟」，崩溃后下次启动强制 flush 补推
- 细粒度 API：`timeWindowMinutes: 1|5|10|30`、`pullIntervalMinutes: 'off'|1|5|10`
- 新增包：`@gitlite/ui`（向导 + BindingManager + SyncSettings，React 组件 + Web Component 封装）

### 格式宪法（Format Constitution，用户明确要求「标准尽快定型、尽量不改、避免数据库重置」）

位置：[03-data-model.md](./docs/03-data-model.md) 第十一节。核心：

- **锚定开放标准，绝不自造**：Git 对象模型 / JSON RFC 8259 + JSONL / **JSON Schema Draft 2020-12**（schema 字段校验子集）/ ULID 官方 spec / ISO 8601 UTC / SemVer 2.0.0 / YAML frontmatter；自定义关键字一律 `x-gitlite-*`（仿 OpenAPI x- 惯例）
- **schema 文件已重构为 JSON Schema 对齐**：标准关键字（type/enum/pattern/format/maxLength/minimum/maximum/items/properties/required 数组/default）原样用；GitLite 语义（unique/indexed/encrypted/immutable/ref/relations/indexes）全部进 `x-gitlite-*`；collection 级配置进 `gitliteDescriptor` 块
- **formatVersion 门禁**（gitlite.config.jsonc 头字段，对标 SQLite 文件头哲学）：repo.major > client.major 拒绝打开；minor/patch 差异必须兼容
- **additive-only 演进**：minor 只做加法；禁止改路径/语义/删文件/改 _rev 算法；**未知容忍**（不认识的 `_` 目录/文件/关键字/元字段：读忽略、写原样保留，保证旧客户端不损坏新格式仓库）
- **冻结计划**：v0.1–v0.2 标 `0.x.0` 实验期（允许重置、UI 明示）；**v0.3 冻结 `1.0.0`**；黄金仓库快照测试集 + 双客户端（N-2 起交叉）互操作 CI + 格式变更 RFC 流程
- **已冻结清单**：`gitlite/<db>` 与 `gitlite/tx/<txId>` 分支命名、根级系统目录、L0/L1/L2 collection 布局、文档元字段（_id/_rev/_schema/createdAt/updatedAt）、schema 格式

## 明确边界（必须诚实告知用户）

**GitLite 不能保证：**

1. 跨仓库事务
2. 强一致防超卖（金融/库存场景）
3. Serializable 隔离
4. 实时一致性（默认最终一致，秒级延迟）
5. 跨客户端分布式锁
6. 高并发写入（写配额 ~1500 单文件/hour）
7. 大数据量（>1GB 性能下降，>5GB 触顶）
8. 大二进制存储（用外部对象存储）

**适合**：个人项目 / 知识库、小型应用后端（日活 <1000）、Headless CMS、配置中心、原型 / Demo、低频写高并发读、多端只读同步。

## 项目结构

```
e:\Code\Agent\GitLite\
├── README.md                      项目入口
├── project_memory.md              本文件
└── docs/
    ├── 00-overview.md             总览
    ├── 01-architecture.md         整体架构与模块划分
    ├── 02-provider-abstraction.md Git 供应商抽象层
    ├── 03-data-model.md           数据模型与存储映射（含格式宪法 §十一）
    ├── 04-auth.md                 鉴权与登录流程
    ├── 05-crud-api.md             CRUD 与查询 API
    ├── 06-sync-cache.md           同步与缓存引擎（含频率档位 §四、failover §四a）
    ├── 07-transactions.md         事务与一致性模型
    ├── 08-indexing-performance.md 索引与查询性能
    ├── 09-sdk-cli.md              SDK 与 CLI（含 initDB 向导、打包矩阵）
    ├── 10-security-roadmap.md     安全、配额与路线图
    └── decisions.md               技术决策记录（ADR）
```

### ADR 索引（重大决策必须先写 ADR 再改设计文档）

- **ADR-001 同步频率**（[decisions.md](./docs/decisions.md)）：4 方案对比（秒级实时/固定 60s/**分钟级三档**✓/纯手动），采纳分钟级三档 + 启动/退出强制同步。核心论证：写即时落盘 L3，窗口只影响他人可见性 → 3s→10min 配额降 150 倍
- **ADR-002 格式宪法**：4 方案对比（自由演进/迁移工具/**开放标准锚定+additive-only+门禁**✓/复用 Decap 布局），锚定 JSON Schema 2020-12 + ULID + SemVer，未知容忍规则，v0.3 冻结 1.0.0。与 ADR-001 共同构成「配额不踩雷、数据不丢失」产品底线

## 当前状态

**实施阶段（2026-08-15）**：P0–P2 完成；P3 M1–M8 完成，M9 关键项（真实 E2E）**用户实测通过**。

- **真实 E2E 记录**：用户 @Genmer 用自建 OAuth App（env `GITLITE_DEVICE_CLIENT_ID`）跑通 `examples/demo-real.ts`：Device Flow 登录 → 自动识别账号 → 自动建私有仓 `Genmer/gitlite-repo` → 建分支 `gitlite/demo-db` → bootstrap → 真实 push。**这验证了全自动模式 B（终端用户零配置）成立。**
- **对外发布文档已落地**：`docs/index.html`（人读单文件 HTML：原理/数据安全模型/上手/API/格式契约/AI 接入/FAQ，浏览器实测通过）+ `docs/llms.txt`（AI 接入标准：心智模型/安全事实口径/Agent 六条硬规则）。**对外数据安全口径以此两文件为准**：无服务器、token 仅本地 0600、数据只在用户设备↔用户私有仓库、OAuth 最小 scope。
- **代码**：`packages/{core,adapters-node,sdk,cli}`，npm workspaces（环境无 pnpm，工具层偏差已登记）
- **质量门禁实测**：65 测试全绿 / core 覆盖率 lines 85.1%（门禁 80%）/ 4 包 tsc strict 0 错误 / 黄金仓库快照基线已建（`packages/core/test-fixtures/golden-v0.1.json`）
- **关键实现事实**：
  - core 零依赖、零 node 内置 import；MemoryProvider 承载全部单测/集成测试（GitHubProvider 用 mock fetch 单测）
  - 离线队列 = append-only JSONL（写返回前落盘，NFR-4）；队列 hash 文件名禁 `:`（Windows）
  - `await f()!` 的 `!` 绑在 Promise 上是无效断言——必须 `(await f())!`（TS 陷阱，已全仓修正）
  - TS 参数属性赋值晚于字段初始化器：字段里 new 依赖构造参数会拿到 undefined（TxCollection 踩过）
  - ULID encodeTime 曾把高低位拼反（对拍规范向量 01ARYZ6S41 发现）
  - diff 删除仅限 GitLite 自有文件（foreign 仓库「不动用户文件」承诺的落地保证）
- **v0.1 收尾遗留**（见 progress.md §六）：真仓库 E2E（需 PAT）、provider.deleteBranch、CLI REPL（移 v0.2）、OAuth client_id 注册（现为占位）、L1→L2 在线分裂（现为 flush 重排）

**实施流程（用户定下的工作方式）**：`P0 需求 → P1 架构设计 → P2 需求-架构复核 → P3 实现循环`，缺陷回溯 P0。不赶进度。

- 唯一进度入口：[docs/progress.md](./docs/progress.md)（每次会话结束必须更新）
- P0：requirements.md（FR A~K）；P1：11-implementation-design.md；P2：12-review-checklist.md
- 约定：重大决策先补 ADR 再改代码；测试先行（红）→ 实现（绿）→ review → 集成验证

## 协作约定

- **语言**：中文为主（用户为中文用户，Gitee 一等支持服务国内用户），代码与 API 英文
- **文档风格**：每篇文档开头用 `>` 引用块点明本篇主旨；用表格对比关键维度；TypeScript 代码块标 `ts`；JSONC 用 `jsonc`
- **代码引用**：在对话中提到项目文件时，用 markdown 链接 `[文件名](file:///e:/Code/Agent/GitLite/...)` 形式
- **不过度设计**：MVP 阶段聚焦核心路径，避免提前实现 v1.0 才需要的特性
- **诚实声明边界**：所有设计文档明确写出「不能做什么」，不夸大能力

## 调研基础

设计参考了开源界 Top5「Git-as-Backend」项目：

| 项目 | 启发 |
|---|---|
| Decap CMS | SPA + OAuth + 直读写 Git 文件；UI 完善但查询弱 |
| TinaCMS | GraphQL 数据层 + 索引服务；Bridge+Cache 双层是关键模板 |
| Gitbase | libgit2 + SQL 接口；偏代码分析，读多写少 |
| Contentlayer | 编译期类型安全 JSON；零运行时开销但运行时动态写弱 |
| Isomorphic-git | 纯 JS Git 内核；BYO fs/http，跨环境可嵌入 |

**GitLite 的差异化**：补「数据存储」这一层（非内容编辑），把配额合规与字段级安全作为一等公民，Gitee 一等支持服务国内用户。
