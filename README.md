# GitLite

<p align="center">
  <b>像 SQLite 一样嵌入在本地，但原生连通云端 Git 仓库。</b><br>
  无需购买服务器、无需配置数据库，把每个人都有的 GitHub / Gitee 私有仓库变成你的免运维云端数据库。
</p>

<p align="center">
  <a href="https://gitee.com/genmers/GitLite"><img src="https://img.shields.io/badge/Gitee-GitLite-red.svg" alt="Gitee"></a>
  <a href="https://github.com/genmers/GitLite"><img src="https://img.shields.io/badge/GitHub-GitLite-black.svg" alt="GitHub"></a>
  <img src="https://img.shields.io/badge/version-v0.3.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-green.svg" alt="Node">
  <img src="https://img.shields.io/badge/Tests-230%20passed-brightgreen.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Coverage-91.18%25-brightgreen.svg" alt="Coverage">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
</p>

<p align="center">
  <a href="./docs/guide.md"><b>📖 用户使用手册与产品介绍</b></a> |
  <a href="https://github.com/Genmer/GitLite-Demo"><b>🌟 官方实战 Demo 演示</b></a> |
  <a href="./docs/index.html"><b>🌐 可视化网页文档</b></a> |
  <a href="./docs/llms.txt"><b>🤖 AI / Agent 接入规范</b></a> |
  <a href="./docs/progress.md"><b>📊 工程开发进度</b></a>
</p>


---

## 💡 为什么需要 GitLite？

### 痛点
你想做一个小工具、独立软件（桌面端 dmg/exe、移动端 apk、个人知识库、配置中心、博客）：
- **不想买云服务器与云数据库**：每年续费几百上千元，维护成本高、容易闲置。
- **纯本地存储（如普通 SQLite / localStorage）无法跨端多设备同步**。
- **第三方 BaaS / 云数据库**：数据存放在服务商手中，存在隐私顾虑与平台锁定风险。

### GitLite 的解法
GitLite 是一段编译进你应用中的 **嵌入式数据库引擎**（零独立进程、零中间服务器）。
- **数据物理上存放在用户自己的 GitHub / Gitee 私有仓库中**，GitLite 项目方不经手、看不到任何用户数据。
- **本地一线毫秒读写**（内存镜像 + 离线队列），后台自动按需打包成 Git Commit 进行增量低频同步。
- **零服务器、零费用、防锁定**：断网照常可用，联网自动同步；直接 `git clone` 即可全量导出数据。

---

## 📱 多设备跨端工作流（同账号自动打通）

你在 **Mac、Windows、Android 手机端** 登录同一个 GitHub 或 Gitee 账号，SDK 自动解析身份并绑定到同一个远端数据库分支，无需手动复制连接串或迁移文件：

```
                     ┌──────────────────────────────────────────────┐
                     │            你的 GitHub / Gitee 账号          │
                     │          github.com/alice/gitlite-repo       │
                     │               分支: gitlite/myapp             │
                     └──────────────────────┬───────────────────────┘
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               ▼                            ▼                            ▼
     【Mac 电脑端 App】            【Windows 电脑端 App】         【Android 手机端 App】
    登录 GitHub 账号: alice        登录 GitHub 账号: alice        登录 GitHub 账号: alice
               │                            │                            │
   自动识别为 alice 的 myapp 库   自动识别为 alice 的 myapp 库   自动识别为 alice 的 myapp 库
               │                            │                            │
     本地毫秒读写 ⇄ 自动同步        本地毫秒读写 ⇄ 自动同步        本地毫秒读写 ⇄ 自动同步
```

- 🔄 **自动拉取与响应式刷新**：任何一端写入数据，远端生成 Commit 后，其他端后台拉取并自动派发 `remoteChange` 事件触发 UI 自动刷新。
- 🛡️ **离线可用与断网抗性**：无网络时读写本地镜像与持久化日志；恢复联网后自动补推并执行**字段级三路合并（Three-way Merge）**。

---

## ⚡ 性能基准与加速对比

GitLite 采用 **L0/L1/L2 行级存储分层** 与 **SQLite 索引后端**，读写延迟与资源消耗指标如下：

### 1. 核心读写延迟基准

| 操作类型 | 数据规模 | 纯内存镜像 (默认) | 本地 SQLite 索引后端 (可选) | 全表扫描对比 | 加速比 |
|---|---|---|---|---|---|
| **单条主键/等值查询** | 10,000 docs | **< 0.1 ms** | **0.5 ~ 2 ms** | 15 ~ 30 ms | **15x ~ 300x** |
| **范围查询 ($gte / $lt)** | 10,000 docs | **< 1 ms** | **1 ~ 5 ms** | 20 ~ 50 ms | **20x ~ 50x** |
| **聚合统计 ($group / $sum)** | 10,000 docs | **1 ~ 5 ms** | **5 ~ 20 ms** | 50 ~ 200 ms | **10x ~ 40x** |
| **本地写操作 (WAL 即时落盘)** | 单条写入 | **< 1 ms** | **< 2 ms** | — | — |
| **增量 Pull 同步** | 变更 1 个文件 | **仅拉取 1 个 Blob** | 树比对精准定位 | 全量下载 | **节省 >95% 流量** |
| **增量 Commit Diff** | 10 张表修改 1 表 | **仅比对脏集合** | 零扫描干净表 | 全表比对 | **减少 >90% I/O** |

### 2. 读写与同步流水线

```
写操作 (insertOne) ──▶ ① 内存镜像写入 (<0.1ms) ──▶ ② 本地 WAL 日志落盘 (<1ms, 崩溃不丢)
                             │
                             ▼
                 [离线缓冲队列 CommitQueue] ──(每10分钟或满100条)──▶ 打包成 1 次 Git Commit ──▶ 批量 Push 到云端
                             ▲
                             │
读操作 (find/findOne) ───────┴─▶ 本地内存镜像直接返回 (<0.1ms，零网络延迟)
```

### 3. 平台配额安全边际

```
GitHub API 官方限额:  ████████████████████████████████████████ 5000 次/小时
GitLite Economy 档:   ▍ < 8 次/小时 (安全边际 > 99.8%，彻底远离封号与限流风险)
```

---


## ✨ 核心特性

- 🚀 **5 分钟上手**：`npm i @gitlite/sdk`，一行 `initDB()` 自动引导登录、识别身份并创建私有仓库与数据库。
- 🛡️ **数据完全归用户所有**：直连 GitHub / Gitee 官方 API，无中间服务器，支持字段级 AES-256-GCM 加密。
- ⚡ **SQLite 级引擎能力**：
  - Mongo 风格灵活查询（`$eq`, `$gt`, `$in`, `$regex`, 嵌套点路径等）
  - 索引与范围扫描（支持单字段索引、唯一索引、复合索引）
  - 聚合管道（`$match`, `$group`, `$sort`, `$sum`, `$avg` 等）
  - 短事务与长事务（SAVEPOINT 部分回滚与嵌套事务）
  - 本地 SQLite 缓存后端（海量索引秒级加载）
- 🔄 **离线优先与智能同步**：本地操作即时落盘防丢，后台 Economy 经济档批量提交（每小时 < 8 次 API 调用，刻意避开平台限流）。
- 🖥️ **全端适配**：支持 Node.js、Electron、桌面端（Tauri/dmg/exe）、纯前端、移动端 WebView 等。

---

## 📦 Monorepo 体系包结构

GitLite 已发布 7 个官方子包，开发者通常只需安装 `@gitlite/sdk` 即可：

| 包名 | 职责 |
|---|---|
| [`@gitlite/sdk`](./packages/sdk) | **面向开发者的统一门面**：`initDB` 幂等向导、`connect` 连接、CRUD 查询、Node 适配器统一导出 |
| [`@gitlite/core`](./packages/core) | 核心存储引擎：存储模型、增量同步、计划器、索引、事务、AES-256-GCM 加密（零 Node 依赖） |
| [`@gitlite/adapters-node`](./packages/adapters-node) | Node.js 运行时：文件系统、OS 钥匙串凭据库（security/secret-tool）、node:sqlite 工厂、OAuth 回调服务 |
| [`@gitlite/cli`](./packages/cli) | 命令行瑞士军刀：`gitlite setup`（引导配置）、`gitlite repl`（交互式查询）、`db/data/sync` |
| [`@gitlite/codegen`](./packages/codegen) | 代码生成器：将 `.schema.jsonc` 编译为强类型 TypeScript Client |
| [`@gitlite/react`](./packages/react) | React 生态：`useGitLite`、`useFind`、`useDoc`、`useUpdate`（远端变更自动 refetch） |
| [`@gitlite/ui`](./packages/ui) | 可视化组件：`<GitLiteSetup>` 引导配置页面与 `<GitLiteWizard>` 多步向导 |

---

## 🚀 快速上手与使用方式

### 方式 1：SDK 编程式接入（最简单）

```bash
npm install @gitlite/sdk
```

> [!IMPORTANT]
> **🚨 强烈不推荐在面向用户的产品中使用 Personal Access Token (PAT)**：对终端用户极不友好且易泄露权限。产品与业务代码一律使用 `initDB()` 自动引导登录与建仓。

```ts
import { initDB } from '@gitlite/sdk';

// 首次调用：自动弹窗引导登录（GitHub Device Flow / Gitee OAuth）并建仓建库
// 二次调用：自动读取本地绑定记录，静默直连（幂等）
const db = await initDB({ database: 'myapp' });


// 1. 插入数据（自动分配 ULID 主键与时间戳，写操作即时落盘）
const userId = await db.collection('users').insertOne({
  email: 'alice@example.com',
  name: 'Alice',
  age: 25
});

// 2. 丰富查询（Mongo 风格 Filter）
const adults = await db.collection('users').find({
  age: { $gte: 18 }
}, {
  sort: { createdAt: -1 },
  limit: 20
});

// 3. 事务操作
await db.transaction(async (tx) => {
  await tx.collection('users').updateOne({ _id: userId }, { $inc: { age: 1 } });
});

// 退出前强制推送（已挂载进程退出钩子，通常无需手动调用）
await db.close();
```

> [!TIP]
> **生态统一授权应用规范**：建议在 Gitee / GitHub 登记应用时，统一命名为 **`GitLite 应用授权`**（或 `GitLite`），主页 `http://127.0.0.1:18365`，回调 `http://127.0.0.1:18365/callback`。只需通过 `npx gitlite setup` 或网页向导登记一次，本机开发的所有 GitLite App 均自动通用，便于用户在个人主页授权列表中一目了然统一管理。



---

### 方式 2：CLI 交互式 REPL 与代码生成

全局安装或通过 npx 使用：

```bash
# 1. 引导配置：检测环境并绑定 GitHub / Gitee（一次登记，全机生效）
npx gitlite setup

# 2. 打开交互式数据库 REPL（支持 Tab 自动补全、多行语句与 Proxy 快捷查询）
npx gitlite repl --db gitlite://github:default@me/gitlite-repo/myapp
```

在 REPL 中像操作对象一样查询：
```js
gitlite> await db.users.find({ age: { $gte: 18 } })
[ { _id: '01M0...', name: 'Alice', age: 26 } ]

gitlite> await db.users.insertOne({ name: 'Bob', age: 30 })
"01M0CBMP09..."
```

从 Schema 生成强类型 TS Client：
```bash
npx gitlite codegen --schema ./_schema --out ./src/generated
# 生成强类型 Client：db.users.find() 获得完整的 IDE 自动补全与类型检查
```

---

### 方式 3：React 前端与向导组件

```bash
npm install @gitlite/sdk @gitlite/react @gitlite/ui
```

```tsx
import { useGitLite, useFind } from '@gitlite/react';
import { GitLiteSetup } from '@gitlite/ui';

function App() {
  const [ready, setReady] = useState(false);
  const { db } = useGitLite('gitlite://github:default@me/gitlite-repo/myapp');

  // 未连接时展示引导配置向导
  if (!db) {
    return <GitLiteSetup onReady={() => setReady(true)} />;
  }

  return <UserList db={db} />;
}

function UserList({ db }) {
  // 远端仓库有新 Commit 时自动接收事件并 Refetch
  const { items, loading } = useFind(db, 'users', { age: { $gte: 18 } });

  if (loading) return <div>加载中...</div>;
  return (
    <ul>
      {items.map(u => <li key={u._id}>{u.name} ({u.email})</li>)}
    </ul>
  );
}
```

---

## 🌐 演示与文档导航

无需向协作者发送本地散乱文件，可直接通过以下方式查阅与体验：

### 1. 官方实战 Demo 与生态案例
- **[`GitLite-Demo 官方示例仓库`](https://github.com/Genmer/GitLite-Demo)**：包含极简、开箱即用的完整应用接入示例（CRUD、React 状态管理与自动同步）。
- **[Memex（大模型记忆与技能管理中枢）](https://github.com/Genmer/Memex)**：Tauri v2 + Vue 3 桌面端真实应用，全面基于 GitLite 作为主存储与多端同步基座（7+ 集合多表关联、状态胶囊、一键 Gitee OAuth 网页授权、主动双向秒级同步）。

### 2. 交互式可视化向导（本地演示页）

仓库内置了开箱即用的可视化演示页，集成了环境检测、OAuth 登记引导、私人令牌校验与真实建仓：
```bash
npx tsx examples/setup-page/server.ts
# 浏览器打开 http://127.0.0.1:4173 即可体验完整配置向导
```

### 3. 移动端 PWA 安装与多端实战
- 查看 [**《PWA 移动端安装指南》**](./docs/pwa.md)：免 App Store 审核与年费，将前端应用 2 分钟直接安装至 iPhone / iPad / Android 主屏幕，全离线可用与自动云漫游。

### 4. 离线精美单文件文档（人读推荐）
- 打开 [`docs/index.html`](./docs/index.html)：纯前端单文件零依赖，内置现代排版与明暗主题自适应，包含架构原理、安全模型、API 速查与 FAQ。

### 5. 大模型与 AI Agent 接入规范
- 查看 [`docs/llms.txt`](./docs/llms.txt)：专为 Cursor、Windsurf、Claude 等 Agent 设计的接入规则与心智模型。

### 6. 深度设计与架构文档（16 篇技术专题）



| 编号 | 专题文档 | 核心内容 |
|---|---|---|
| 00 | [总览定位](./docs/00-overview.md) | 可行性论证、分层架构、诚实定位与路线图 |
| 01 | [整体架构](./docs/01-architecture.md) | 7 层架构模型、本地内存抽象、技术选型 |
| 02 | [供应商抽象](./docs/02-provider-abstraction.md) | GitHub / Gitee Git DB API 差异适配与降级策略 |
| 03 | [数据模型](./docs/03-data-model.md) | DB→Git 映射、L0/L1/L2 行存储分级、格式宪法（ADR-002） |
| 04 | [鉴权与登录](./docs/04-auth.md) | Device Flow / PKCE 流程、OS 钥匙串凭据库、OAuth 错误防御 |
| 05 | [CRUD 与查询 API](./docs/05-crud-api.md) | Mongo 风格操作符、更新管道、游标分页 |
| 06 | [同步与缓存引擎](./docs/06-sync-cache.md) | 内存镜像、离线队列、冲突合并策略、配额预算治理 |
| 07 | [事务一致性](./docs/07-transactions.md) | 短事务原子 Commit、SAVEPOINT 长事务、OCC 乐观并发控制 |
| 08 | [索引与性能](./docs/08-indexing-performance.md) | 倒排索引、计划器代价预估、SQLite 本地索引后端 |
| 09 | [SDK 与 CLI](./docs/09-sdk-cli.md) | SDK 门面契约、REPL 实现、Codegen 强类型 Client、React Hooks |
| 10 | [安全与加密](./docs/10-security-roadmap.md) | AES-256-GCM 字段级加密（ADR-003）、密钥派生与脱敏 |
| 11 | [实施设计基线](./docs/11-implementation-design.md) | 模块时序、数据流、错误模型映射 |
| 12 | [需求复核清单](./docs/12-review-checklist.md) | 架构覆盖度复核与设计准则验证 |
| 13 | [物理天花板与红线](./docs/13-limits-and-ceiling.md) | 容量/延迟/吞吐/并发四维极限分析 |
| 14 | [SQLite 引擎对标](./docs/14-engine-parity-sqlite.md) | SQLite 12 项能力对标与补齐序列判定 |
| 15 | [NPM 发布指南](./docs/15-npm-publish.md) | Monorepo 拓扑依赖发布与版本自动化管理 |
| 16 | [PWA 移动端指南](./docs/pwa.md) | iOS / Android 免 App Store 极速安装与离线 Local-First 实战 |


---

## 🎯 适用与不适用场景

| ✅ 强烈推荐适用 | ❌ 不适合适用 |
|---|---|
| 个人工具 / 知识库 / 笔记软件 | 高并发高频写入（超出 Git API 配额） |
| 独立开发者软件（桌面应用 / 小型移动应用） | 大数据量仓库（仓库体积推荐 < 1GB） |
| 静态博客 / Headless CMS 内容存储 | 金融级强一致（如秒杀、跨行转账） |
| 配置中心（天然享有 Git 版本历史与回滚） | 大尺寸二进制多媒体文件存储 |
| 原型开发 / Demo 验证 / 课程设计 | 多用户高频协同冲突编辑 |

---

## 🛠️ 项目质量与门禁状态

当前版本：**`v0.3.0`**（7 个子包全量同步发布）。

- **测试门禁**：`39` 个测试文件，`230` 个用例全绿（`npx vitest run`）
- **代码覆盖率**：核心引擎 Lines **91.18%**（远超 ≥80% 门禁）
- **类型检查**：7 包严格模式 TypeScript 检查 **0 错误**
- **格式稳定**：`formatVersion 1.0.0` 黄金冻结基线保证

### 📥 最新版本拉取与安装

#### 1. 源码仓库拉取
```bash
git pull origin main
```

#### 2. NPM 包极速安装 / 升级至 v0.3.0
```bash
npm install @gitlite/sdk@latest
# 或全家桶引入：
npm install @gitlite/sdk@0.3.0 @gitlite/react@0.3.0 @gitlite/ui@0.3.0
```

> **协作者与 AI 贡献指南**：请阅读 [`AGENTS.md`](./AGENTS.md) 了解工作流协议，开发进度与实时状态以 [`docs/progress.md`](./docs/progress.md) 为准。

---

## 📝 变更记录 (Changelog)

### v0.3.0 (2026-08-21) — 生产落地增强与浏览器运行时生态
- 🚀 **连接与同步状态机标准（`SyncState`）**：
  - 引入规范的 6 态生命周期状态机：`'connecting' | 'ready' | 'syncing' | 'synced' | 'offline' | 'error'`；
  - 触发统一的 `client.on('status:change')` 事件流，极简驱动各前端 UI 状态栏或指示灯；
  - 新增 `client.syncNow()` 主动双向同步（拉取最新变更 + 立即推送本地增量，对标 Memex 生产范式）；
  - `ConnectOptions` 增强 `autoPullOnInit?: boolean`（默认开启，彻底杜绝初始化数据为空的困惑）。
- 🌐 **大容量浏览器运行时 `@gitlite/core` 浏览器适配器**：
  - 新增 `IndexedDbFsAdapter`（基于原生 `IndexedDB`，零外部依赖，突破 localStorage 5MB 限制，支持几百 MB 级知识库与离线队列）；
  - 新增 `IndexedDbCredentialStore` 与 `createBrowserRuntime()` 组装工厂函数，跨 Web / PWA / 移动端开箱即用。
- 🔄 **Provider 原生代理支持（CORS 终结者）**：
  - `GitHubProvider` 与 `GiteeProvider` 新增 `baseUrl` 选项，一行代码对接 Cloudflare Worker / Vite Proxy / 本地网关，彻底根除浏览器端 CORS 跨域痛点。
- 🎨 **UI 与 React 状态生态扩展**：
  - `@gitlite/ui` 新增 `<GitLiteCapsule />` 状态胶囊组件：自适应呼吸灯、当前库分支标识、一键立即同步按钮、全响应式移动端样式；
  - `@gitlite/react` 新增 `useSyncStatus(db)` Hook：毫秒级响应 `status:change`、`sync:push` 与 `sync:pull`。

### v0.2.0 (2026-08-19)
- 🐛 **修复 OAuth Client ID 占位符导致授权崩溃**：在发起云端网络请求前防御性检查 `clientId`，若未配置或仍为占位符，直接抛出结构化错误 `OAuthAppNotConfiguredError` 并引导通过 `gitlite setup` / 环境变量完成登记，避免底层裸 HTTP 404 / 400 报错。
- 🐛 **修复 initDB 静默直连机制错误复用 MemoryProvider 缓存**：
  - `MemoryProvider` 临时模式初始化成功后严禁落盘 `~/.gitlite/bindings.json`，彻底实现内存模式隔离。
  - `initDB` 幂等重连时严格校验请求 `provider` 与缓存中的一致性；若请求传入新平台（如由 memory/gitee 切至 github），强制跳过旧缓存并触发对应平台初始化与 bindings 覆盖。
  - `initDB` 增加对 Gitee 无 token 时的交互式 OAuth 登录支持。
- 🚀 **增强 @gitlite/sdk 统一门面导出**：
  - 完整 re-export Node 运行时适配器函数与常量：`createNodeRuntime`、`createNodeSqlite`、`waitForRedirect`、`GITLITE_LOOPBACK_PORT`、`createOsCredentialStore`、`FileCredentialStore`。
  - 完整 re-export 核心异常与错误体系（`OAuthAppNotConfiguredError`、`GitLiteError`、`AuthError` 等）以及适配器类型（`Runner`、`ExecResult`、`SqliteAdapterFactory` 等），业务层无需单独安装/查找 `@gitlite/adapters-node`。

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。


