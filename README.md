# GitLite

> 像 SQLite 一样嵌入在本地，但原生连通云端 Git 仓库。

GitLite 把任意 Git 仓库（首先支持 GitHub 和 Gitee）抽象成一个**嵌入式云端数据库**——把远程仓库当成本地工作内存来用（类似 Java 的抽象工作内存）。它提供简单易用的 API 给上层应用，让开发者像用 SQLite / MongoDB 一样操作 Git 仓库，无需公网 IP、无需服务器。

## 🤖 协作与进度控制（入口）

- **AI / 新协作者必读**：[AGENTS.md](./AGENTS.md) —— 协作规矩（开工先读、收工必更新）、硬原则、验证命令、已知坑。
- **进度唯一入口**：[docs/progress.md](./docs/progress.md) —— 流程模型、阶段状态、里程碑、变更日志；**开工先读它，收工必更新它**。
- **需求与红线**：[docs/requirements.md](./docs/requirements.md)（FR/NFR/MVP 边界）、[docs/13-limits-and-ceiling.md](./docs/13-limits-and-ceiling.md)（平台配额物理天花板与立项红线）。

## 核心理念

- **分支 = 数据库（默认）**：默认仓库 `gitlite-repo` 内用 `gitlite/<库名>` 分支区分 database（一个仓库存所有库，规避 Gitee 私有仓上限）；也支持一仓库一库分摊 push 配额。
- **目录 = 表，行按规模分级**：collection 是目录；行数 <50 单文件、<5000 一行一文件、更大自动转千行一分片的 JSONL——对上层 API 完全透明。
- **commit = 事务**：一次 commit 是原子的，多文件改动可打包成单个 commit。
- **分支 = 沙箱**：临时分支承载长事务，merge 即提交、delete 即回滚。
- **本地内存抽象**：读写先打在本地 In-Memory Mirror 上（读命中即返回、写乐观入缓存），再由 Sync Engine 批量 commit+push 到远端。

## 可行性结论

**可行，但有明确边界。** Top5 开源项目（Decap CMS / TinaCMS / Gitbase / Contentlayer / Isomorphic-git）已验证「Git-as-Backend」成立，但都偏「内容编辑」。GitLite 补的是「数据存储」这一层。

**软件里创建仓库：可以。** GitHub `POST /user/repos`（scope `repo`）、Gitee `POST /api/v5/user/repos`（scope `projects`）都支持。用户点登录拿到带权限的 token 后即可在软件内一键建/删仓库。

## 设计文档

完整设计见 [`docs/`](./docs) 目录，共 15 篇 + 需求/进度/决策记录：

| # | 文档 | 内容 |
|---|---|---|
| 00 | [总览](./docs/00-overview.md) | 定位、可行性、分层架构、十维度速览、诚实定位、版本路线图 |
| 01 | [整体架构](./docs/01-architecture.md) | 7 层架构、模块清单、本地内存抽象实现、技术栈、风险 |
| 02 | [供应商抽象](./docs/02-provider-abstraction.md) | `GitProvider` 接口、GitHub/Gitee 差异对照、建仓可行性、混合策略 |
| 03 | [数据模型](./docs/03-data-model.md) | DB→Git 映射、行分级存储、JSON Schema 锚定 + `x-gitlite-*` 扩展、引用/内嵌关系、**格式宪法**（开放标准锚定、additive-only、formatVersion 门禁） |
| 04 | [鉴权登录](./docs/04-auth.md) | GitHub Device Flow / Gitee PKCE+Loopback、scope 矩阵、OS 凭据库、多 profile 隔离、软件内建删仓 |
| 05 | [CRUD 与查询 API](./docs/05-crud-api.md) | Mongo 风格 filter（比较/逻辑/数组）、更新操作符、include 关联、聚合管道、游标分页、事件订阅、错误模型 |
| 06 | [同步缓存引擎](./docs/06-sync-cache.md) | 三层缓存（L1/L2/L3）、乐观写+CommitQueue、Git DB/Contents/isomorphic-git 三路实现、冲突解决、离线队列、配额预算 |
| 07 | [事务一致性](./docs/07-transactions.md) | 三级一致性（cache/synced/fresh）、短事务+长事务（分支）、OCC + expectedHeadOid CAS、隔离级别、Git 语义对照、诚实边界 |
| 08 | [索引与性能](./docs/08-indexing-performance.md) | 倒排索引文件格式、查询计划器与 explain、SQLite 可选后端、性能基准、预热缓存、监控调优、降级容错 |
| 09 | [SDK 与 CLI](./docs/09-sdk-cli.md) | pnpm monorepo、SDK API + URI 连接串、Codegen 强类型 Client、CLI 全命令集、REPL、React Hooks、跨运行时适配、插件机制 |
| 10 | [安全与路线图](./docs/10-security-roadmap.md) | GitHub/Gitee 配额矩阵、QuotaManager、字段级 AES-256-GCM 加密、密钥轮换、审计合规、威胁模型、v0.1→v1.0 路线图 |
| 11 | [实施设计](./docs/11-implementation-design.md) | 模块图、接口契约、数据流、错误模型、测试策略（P3 实现基线） |
| 12 | [复核清单](./docs/12-review-checklist.md) | 需求-架构逐条复核：0 缺口 / 6 实现注意项 |
| 13 | [天花板与红线](./docs/13-limits-and-ceiling.md) | 外圈：平台配额推演容量/延迟/吞吐/并发四维极限与立项红线；功能轨（Gitee/凭据库/REPL） |
| 14 | [引擎对标 SQLite](./docs/14-engine-parity-sqlite.md) | 内圈：引擎能力逐项对标（12 项判定）+ P1a→P4 补齐序列（当前推进轨道） |
| ADR | [技术决策记录](./docs/decisions.md) | ADR-001 同步频率（4 方案对比→分钟级三档）、ADR-002 格式宪法（开放标准锚定 + additive-only + v0.3 冻结）、ADR-003 字段级加密 |
| REQ | [需求基线](./docs/requirements.md) | 10 用户故事 / FR A~K / NFR / MVP 边界（范围冻结，变更走记录） |
| PROG | [开发进度](./docs/progress.md) | **唯一进度入口**：阶段状态、里程碑、质量门禁、变更日志（AI 协作规矩见 [AGENTS.md](./AGENTS.md)） |
| 📖 | [对外发布文档](./docs/index.html)（浏览器打开） | 使用+接入标准：原理、**数据安全模型**（无服务器/token 仅本地）、快速上手、API 速查、格式契约、AI 接入 |
| 🤖 | [llms.txt](./docs/llms.txt) | AI/Agent 接入标准（llmstxt.org 规范）：心智模型、安全事实、Agent 硬规则、最小代码、文档地图 |

## 快速上手（设计中的 API 形态）

```ts
import { initDB } from '@gitlite/sdk';

const db = await initDB();
// 首次：弹出向导（选 GitHub/Gitee → 登录 → 选/建 gitlite-repo 仓库 → 完成检查）
// 之后：幂等静默直连，不弹任何 UI

await db.users.insertOne({ email: 'a@x.com', name: 'A' });
const list = await db.users.find({ age: { $gte: 18 } });
// 全程本地副本读写（写即时落盘），默认 economy 档 10 分钟批量同步远端、不轮询；
// 启动/退出各强制同步一次；频率可调（1/5/10/30 分钟）
```

内置 UI（向导、绑定管理、同步设置）每一步都有等价 headless API，可完全自建页面。支持绑定多平台（GitHub 主 + Gitee 镜像）：一方限流自动 failover 切换，全部限流则进入纯本地模式等待恢复。

## 适用场景

✅ 个人项目 / 知识库、小型应用后端、Headless CMS、配置中心（版本化+回滚）、原型 / Demo、低写入频率数据、多端只读同步。

❌ 高并发写入、大数据量（仓库建议 <1GB）、强一致事务（金融/库存防超卖）、高频实时查询、大二进制存储、多用户并发编辑。

## 技术栈

TypeScript + isomorphic-git（跨 Node / 浏览器 / Electron），pnpm monorepo。

## 状态

v0.1 MVP 已完成（含真实 GitHub E2E 用户验证）。当前在 v0.2 引擎能力轨（[docs/14](./docs/14-engine-parity-sqlite.md)）：P1 范围索引/增量 diff/增量 pull、P2 计划器+复合索引+聚合管道、P3 SAVEPOINT+字段级加密均已落地；下一个是 P4 本地 SQLite 索引后端。实时进度以 [docs/progress.md](./docs/progress.md) 为准。
