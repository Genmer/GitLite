# GitLite

> 像 SQLite 一样嵌入在本地，但原生连通云端 Git 仓库。

GitLite 把任意 Git 仓库（首先支持 GitHub 和 Gitee）抽象成一个**嵌入式云端数据库**——把远程仓库当成本地工作内存来用（类似 Java 的抽象工作内存）。它提供简单易用的 API 给上层应用，让开发者像用 SQLite / MongoDB 一样操作 Git 仓库，无需公网 IP、无需服务器。

## 🤖 协作与进度控制（入口）

- **AI / 新协作者必读**：[AGENTS.md](./AGENTS.md) —— 协作规矩（开工先读、收工必更新）、硬原则、验证命令、已知坑。
- **进度唯一入口**：[docs/progress.md](./docs/progress.md) —— 流程模型、阶段状态、里程碑、变更日志；**开工先读它，收工必更新它**。
- **需求与红线**：[docs/requirements.md](./docs/requirements.md)（FR/NFR/MVP 边界）、[docs/13-limits-and-ceiling.md](./docs/13-limits-and-ceiling.md)（平台配额物理天花板与立项红线）。

## 里程碑总览（全部落地，实测门禁见状态）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **v0.1 MVP**（2026-08-15） | 工程骨架 / GitHub Provider+Device Flow / 分级存储引擎 / 同步引擎（economy 调度+CAS）/ 查询+索引 / 短事务 / SDK connect·initDB / CLI；**真实 GitHub E2E 用户实测通过** | ✅ |
| **v0.2 能力轨 · P1 性能三优化** | P1a 索引范围扫描（B-Tree 对位）· P1b 脏集合增量 diff（WAL 对位）· P1c pull 增量化（按需取 blob） | ✅ |
| **v0.2 能力轨 · P2 优化器第一步** | 最小计划器 + explain（与执行严格一致）· 复合索引 · 聚合管道（$match/$group/$sort/…） | ✅ |
| **v0.2 能力轨 · P3 事务与加密** | 长事务 SAVEPOINT（部分回滚/嵌套）· 字段级加密（AES-256-GCM，ADR-003，commit/pull 边界加密） | ✅ |
| **v0.2 能力轨 · P4 分页缓存** | 本地 SQLite 索引后端（内圈唯一「换部件」项）：条目落盘不占 JS 堆 + XOR 文档指纹跳重建 + 渲染缓存零写入快路径 | ✅ |
| **v0.2 功能轨** | Gitee Provider（Contents 降级提交）· Gitee OAuth 授权码+loopback 登录 · OS 凭据库（security/secret-tool，零原生依赖）· CLI REPL · 限流响应头精确解析 | ✅ |
| **v0.3 · 格式冻结** | **formatVersion 1.0.0**（ADR-002 执行）：0.x 仓库可读、2.x 拒读；golden-v1.0 冻结基线 | ✅ |
| **v0.3 · 工具链** | Codegen 强类型 Client（`gitlite codegen`）· `@gitlite/react` hooks · `@gitlite/ui` 内置向导 | ✅ |

> 能力轨逐项对标 SQLite 引擎能力（docs/14 判定法则），至此「内圈」补齐序列收官；外圈物理天花板（容量/延迟/吞吐/并发）见 docs/13。

## 包结构（npm workspaces，7 包）

| 包 | 职责 |
|---|---|
| `@gitlite/core` | 引擎本体：存储/同步/查询/索引/事务/加密/Provider 抽象（零 node 依赖，RuntimeAdapter 注入一切） |
| `@gitlite/adapters-node` | Node 运行时：fs/crypto/凭据（文件或 OS 钥匙串）/loopback OAuth 回调/SQLite 工厂（node:sqlite） |
| `@gitlite/sdk` | connect（URI/对象）· initDB 幂等向导 · databases 管理 · GitHub Device Flow / Gitee OAuth 登录 |
| `@gitlite/cli` | `gitlite auth|db|data|sync|repl|codegen`（REPL 支持 `db.users.find({...})` 表达式求值 + 点命令 + 补全） |
| `@gitlite/codegen` | schema(.schema.jsonc) → 强类型 TS Client（Doc/Input 接口 + TypedGitLiteClient） |
| `@gitlite/react` | hooks：useGitLite / useFind / useDoc / useUpdate（remoteChange 自动 refetch） |
| `@gitlite/ui` | `<GitLiteSetup>` 引导配置（环境检测 → OAuth 登记/PAT 页面引导）+ `<GitLiteWizard>` 连接向导；flows 可注入 |

## 快速上手

```ts
import { initDB } from '@gitlite/sdk';

// 首次：向导引导（GitHub Device Flow / Gitee OAuth 点一下登录）→ 自动建仓建分支
// 之后：幂等静默直连
const db = await initDB();

await db.collection('users').insertOne({ email: 'a@x.com', name: 'A' });
const list = await db.collection('users').find({ age: { $gte: 18 } });
// 全程本地副本读写（写即时落盘），默认 economy 档 10 分钟批量同步远端；启动/退出强制同步
```

REPL 与强类型生成：

```bash
gitlite setup                            # 引导配置：检测 → OAuth 登记引导 / PAT 粘贴校验（一次登记全机生效）
gitlite repl --db gitlite://github:<profile>@me/gitlite-repo/default
gitlite> db.users.find({ age: { $gte: 18 } })   # 表达式求值，Tab 补全字段/操作符

gitlite codegen --schema ./.pull/_schema --out ./src/generated
# → gitlite.types.ts + gitlite.client.ts（db.users.find(...) 全类型检查）
```

React：

```tsx
const { db } = useGitLite('gitlite://github:me@me/gitlite-repo/default');
const { items, loading } = useFind(db, 'users', { age: { $gte: 18 } }); // 远端变更自动刷新
```

## 可行性结论

**可行，但有明确边界。** Top5 开源项目（Decap CMS / TinaCMS / Gitbase / Contentlayer / Isomorphic-git）已验证「Git-as-Backend」成立，但都偏「内容编辑」。GitLite 补的是「数据存储」这一层。

**软件里创建仓库：可以。** GitHub `POST /user/repos`（scope `repo`）、Gitee `POST /api/v5/user/repos`（scope `projects`）都支持；OAuth 点一下登录后即可在软件内一键建/删仓库。

## 设计文档

完整设计见 [`docs/`](./docs) 目录，共 15 篇 + 需求/进度/决策记录：

| # | 文档 | 内容 |
|---|---|---|
| 00 | [总览](./docs/00-overview.md) | 定位、可行性、分层架构、十维度速览、诚实定位、版本路线图 |
| 01 | [整体架构](./docs/01-architecture.md) | 7 层架构、模块清单、本地内存抽象实现、技术栈、风险 |
| 02 | [供应商抽象](./docs/02-provider-abstraction.md) | `GitProvider` 接口、GitHub/Gitee 差异对照（Git DB API 不对称→降级策略）、建仓可行性 |
| 03 | [数据模型](./docs/03-data-model.md) | DB→Git 映射、行分级存储、JSON Schema 锚定 + `x-gitlite-*`、**格式宪法**（additive-only、formatVersion 门禁） |
| 04 | [鉴权登录](./docs/04-auth.md) | GitHub Device Flow / Gitee OAuth+PKCE+loopback、scope 矩阵、OS 凭据库、多 profile 隔离 |
| 05 | [CRUD 与查询 API](./docs/05-crud-api.md) | Mongo 风格 filter、更新操作符、include 关联、聚合管道、游标分页、事件订阅、错误模型 |
| 06 | [同步缓存引擎](./docs/06-sync-cache.md) | 三层缓存、乐观写+CommitQueue、冲突解决、离线队列、配额预算 |
| 07 | [事务一致性](./docs/07-transactions.md) | 三级一致性、短事务+长事务（分支）、OCC + expectedHeadOid CAS、隔离级别 |
| 08 | [索引与性能](./docs/08-indexing-performance.md) | 倒排索引文件格式、查询计划器与 explain、**SQLite 索引后端（已落地）**、性能基准 |
| 09 | [SDK 与 CLI](./docs/09-sdk-cli.md) | monorepo、SDK API + URI、Codegen、CLI 全命令集 + REPL、React Hooks、插件机制 |
| 10 | [安全与路线图](./docs/10-security-roadmap.md) | 配额矩阵、QuotaManager、字段级加密、密钥轮换、威胁模型、路线图 |
| 11 | [实施设计](./docs/11-implementation-design.md) | 模块图、接口契约、数据流、错误模型、测试策略（P3 实现基线） |
| 12 | [复核清单](./docs/12-review-checklist.md) | 需求-架构逐条复核：0 缺口 / 6 实现注意项 |
| 13 | [天花板与红线](./docs/13-limits-and-ceiling.md) | 外圈：平台配额推演容量/延迟/吞吐/并发四维极限；功能轨状态 |
| 14 | [引擎对标 SQLite](./docs/14-engine-parity-sqlite.md) | 内圈：引擎能力逐项对标 + P1a→P4 补齐序列（已全部落地） |
| ADR | [技术决策记录](./docs/decisions.md) | ADR-001 同步频率 / ADR-002 格式宪法（**1.0.0 已冻结**）/ ADR-003 字段级加密 |
| REQ | [需求基线](./docs/requirements.md) | 用户故事 / FR / NFR / MVP 边界 |
| PROG | [开发进度](./docs/progress.md) | **唯一进度入口**：阶段状态、里程碑、质量门禁、变更日志 |
| 📖 | [对外发布文档](./docs/index.html)（浏览器打开） | 使用+接入标准：原理、数据安全模型、快速上手、API 速查、格式契约 |
| 🤖 | [llms.txt](./docs/llms.txt) | AI/Agent 接入标准（llmstxt.org 规范） |

## 适用场景

✅ 个人项目 / 知识库、小型应用后端、Headless CMS、配置中心（版本化+回滚）、原型 / Demo、低写入频率数据、多端只读同步。

❌ 高并发写入、大数据量（仓库建议 <1GB）、强一致事务（金融/库存防超卖）、高频实时查询、大二进制存储、多用户并发编辑。

## 技术栈

TypeScript + isomorphic-git（跨 Node / 浏览器 / Electron），npm workspaces；可选本地 SQLite 索引后端（node:sqlite，零原生依赖）；React hooks / 向导组件。

## 状态

**v0.2 能力轨 + 功能轨全部完成，v0.3（格式冻结 1.0.0 / Codegen / React+UI）已落地**（2026-08-16）。
门禁：**188 测试全绿（31 文件）· 覆盖率 lines 91.48% · 7 包 tsc strict 0 错 · golden-v1.0 冻结基线稳定**。实时进度以 [docs/progress.md](./docs/progress.md) 为准。
待用户真机验证：Gitee OAuth 全链路（需注册 OAuth App）、mac/linux OS 钥匙串。
