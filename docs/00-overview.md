# GitLite 设计总览

> 本篇是 GitLite 的顶层设计纲要。各维度细节见 `01`~`10` 各专题文档。

## 一、定位与寓意

**GitLite** —— 对标 SQLite，强调「像 SQLite 一样嵌入在本地，但原生连通云端 Git 仓库」。

把任意 Git 仓库（首先 GitHub、Gitee）抽象成一个嵌入式云端数据库：把远程仓库当成本地工作内存来用（类似 Java 的抽象工作内存）。上层应用通过简单易用的 API 操作仓库，无需公网 IP、无需服务器。

- **分支 = 数据库（默认）**：默认仓库 `gitlite-repo` 内用 `gitlite/<库名>` 分支区分 database（一个仓库存所有库，规避 Gitee 私有仓上限 5 个的限制）；也支持一仓库一库（分摊 GitHub 按仓库计的 push 限流）。
- **目录 = 表，行按规模分级存储**：collection = 目录；行数 <50 单文件 inline、<5000 一行一文件、更大自动转千行一分片 JSONL——物理形态对上层 API 完全透明（见 03）。
- **commit = 事务**：一次 commit 原子，多文件改动可打包成单 commit。
- **分支 = 沙箱**：临时分支承载长事务，merge = 提交，delete = 回滚。
- **本地内存抽象**：读写先打在本地 In-Memory Mirror，再批量同步到远端。

## 二、可行性结论

**可行，但有明确边界。** 开源界 Top5「Git-as-Backend」项目已验证思路成立：

| 项目 | 机制 | 启示 |
|---|---|---|
| Decap CMS | SPA + OAuth + 直读写 Git 文件 | UI 完善，但查询弱、依赖全量解析 |
| TinaCMS | GraphQL 数据层 + 索引服务 | Bridge+Cache 双层是关键模板 |
| Gitbase | libgit2 + SQL 接口 | 偏代码分析，读多写少 |
| Contentlayer | 编译期类型安全 JSON | 零运行时开销，但运行时动态写弱 |
| Isomorphic-git | 纯 JS Git 内核 | BYO fs/http，跨环境可嵌入 |

GitLite 的差异：补「数据存储」这一层（非内容编辑），把配额合规与字段级安全作为一等公民，Gitee 一等支持。

**软件里创建仓库：可以。**
- GitHub：`POST /user/repos`，scope `repo`（删仓另需 `delete_repo`）
- Gitee：`POST /api/v5/user/repos`，scope `projects`（含删仓）

用户点登录拿带权限 token 后即可软件内一键建/删仓库。前置条件：GitLite 官方预置一对 OAuth App（GitHub 用 Device Flow 只要公开 client_id；Gitee 因强制 client_secret 需编译进 binary），用户侧零配置。

## 三、分层架构

```
L7 消费层        CLI · SDK(TS) · REST/GraphQL
L6 API Gateway   connect(uri)·连接池·限流·审计
L5 查询引擎      filter AST → 索引或全表扫 → 聚合
L5a 模式层       collection/field 校验·路径映射
L4 事务管理器    begin/commit/rollback·写意图·冲突重试
L3 存储引擎      DB概念↔Git文件映射，读写先打 Mirror
L2 本地内存抽象  In-Memory Mirror + Sync Engine  ← 核心
L1 供应商抽象    GitProvider 接口（GitHub/Gitee/GitLab/Local）
L0 Git 内核      isomorphic-git(默认) / nodegit / git-cli
   远端          GitHub · Gitee
横切  鉴权       OAuth 交互登录（产品首选）/ PAT（仅限自动化CI测试，不推荐用于用户产品） → 系统凭据库
```


**焦点**：L2「本地内存抽象」——读写都先打在 In-Memory Mirror（读命中即返回、写乐观入缓存），再由 Sync Engine 批量 commit+push。这是「远端仓库当本地内存用」的实现机制。

**依赖规则**：单向无环，上层依赖下层；Provider 是唯一接触 Kernel 的层，故 Kernel 可整体替换；Auth/Transaction 为横切模块。

## 四、十维度速览

| # | 维度 | 关键决策 |
|---|---|---|
| 1 | 整体架构 | 7 层单向依赖；Provider 隔离 Kernel 可换；TS + isomorphic-git 跨环境 |
| 2 | Provider 抽象 | 统一接口 + capabilities 协商；Gitee 无 Git DB API，批量提交降级或切 isomorphic-git |
| 3 | 数据模型 | db=分支（默认 `gitlite-repo` 内 `gitlite/<name>`）或整仓；collection=目录；行分级存储；schema 锚定 JSON Schema 2020-12 + `x-gitlite-*`；**格式宪法**：锚定开放标准、additive-only、v0.3 冻结 formatVersion 1.0.0 |
| 4 | 鉴权登录 | GitHub Device Flow / Gitee 授权码+PKCE；token 存 OS 凭据库；多账号隔离 |
| 5 | CRUD API | MongoDB/Prisma 风格 filter 对象；`$set/$inc/$push` + include 关联 + 聚合 |
| 6 | 同步缓存 | 三层缓存；乐观写本地+提交队列；分钟级低频同步（economy 默认 10min，启动/退出强制一次）；多绑定 failover；离线队列重放 |
| 7 | 事务一致性 | 三级一致性；OCC + 原生 CAS（`expectedHeadOid`）+ 自动 rebase；诚实契约 |
| 8 | 索引性能 | `/_indexes/*.idx.json` 倒排；本地 SQLite 索引；中小数据全量内存查询 |
| 9 | SDK/CLI | pnpm monorepo；CLI 对标 Prisma+Firebase+sqlite3；schema→强类型 Client |
| 10 | 安全路线 | 配额管理器；字段级 AES-256-GCM；MVP v0.1 GitHub 单平台；v1.0 多用户 |

## 五、诚实定位

**适合**：个人项目 / 知识库、小型应用后端、Headless CMS、配置中心、原型 / Demo、低写入频率数据、多端只读同步。

**不适合**：高并发写入（写配额 ~1500 单文件/hour）、大数据量（仓库建议 <1GB）、强一致事务（金融/库存防超卖）、高频实时查询、大二进制存储、多用户并发编辑。

**差异化**：相比 Decap/Tina（内容编辑层），GitLite 是**数据存储层**——不竞争编辑器 UI，而把配额合规与字段级安全作为一等公民，Gitee 一等支持服务国内用户。

## 六、版本路线图

| 版本 | 目标 | 关键特性 |
|---|---|---|
| **v0.1 MVP** | 单用户 GitHub CRUD 可用、安全、不触配额 | PAT 认证 + Contents/Trees API + 文档 CRUD + 配额管理 + 字段加密 + CLI |
| **v0.5** | 跨平台 + 可查询 | Gitee 适配 + GraphQL + L2 磁盘缓存 + 查询语言 + 配额仪表盘 + 密钥轮换 |
| **v1.0** | 生产可用 | 多用户并发 + Webhook 实时同步 + LFS + 事务语义 + HTTP API/SDK + 可观测 + 安全审计 |
| **v2.0** | 生态 | Web GUI 编辑器 + GitLab/Gitea + 插件机制 + 团队工作流 + 离线 PWA + AI 辅助 |

退出标准示例：v0.1 连续 7 天个人使用无封号警告、无数据丢失、429 自动恢复。

## 七、三大架构风险与应对

1. **性能**（Git 非数据库，频繁小写慢）→ 写默认异步批量化 + 强制本地镜像 + 索引 sidecar + 限速熔断。
2. **并发写冲突**（单分支线性历史 vs 多端并发）→ 事务分支化 + 乐观并发 + 自动 rebase + 冲突收敛到文件粒度。
3. **Kernel 依赖锁定**（isomorphic-git 维护疲软 / nodegit 原生编译痛）→ Provider 接口隔离 + 能力探测 + 三内核适配器并存。

## 八、技术栈

| 维度 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（严格模式） | 类型安全 + 生态广 + isomorphic-git 原生 TS |
| 运行时 | Node 20+ / 浏览器 / Electron | isomorphic-git 纯 JS 跨环境 |
| Git 内核 | isomorphic-git（默认）+ nodegit/git-cli（可选） | 零原生编译、跨环境；高性能场景可选注入 |
| HTTP | undici / fetch | 现代、流式 |
| 鉴权存储 | keytar / Electron safeStorage | OS 凭据库 |
| 本地缓存 | SQLite-WASM (OPFS) / IndexedDB | 业务查询快；git 对象库走 LightningFS |
| CLI | citty / clipanion | 轻量 TS 友好 |
| 测试 | vitest | 内存 Mirror 单测 + 真实沙盒仓库集成测 |
| 打包 | tsup / unbuild | ESM+CJS 双产物 |
| Monorepo | pnpm workspace + Turborepo + changesets | 2026 主流栈 |
