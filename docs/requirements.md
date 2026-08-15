# GitLite v0.1 需求文档（P0 产出）

> 来源：`00`~`10` 设计文档 + ADR + 用户对话。每条需求有唯一编号与可测试的验收标准。
> 范围对应路线图 **v0.1 MVP（GitHub 单平台）**。范围冻结后变更需在文末登记。
> 流程位置见 [progress.md](./progress.md)。

## 1. 用户故事

| # | 作为…我想…以便… | 对应需求组 |
|---|---|---|
| US-1 | 个人开发者，给小工具一个云端数据库 | 不买服务器、不搞公网 IP 就能存取数据 | A/B/I |
| US-2 | app 开发者，`npm i` 后调一次 `initDB()` | 首次引导（登录+选仓库）全自动完成 | A |
| US-3 | 用户，初始化时选/建仓库 | 数据放在自己账号下，可控可带走 | A/C |
| US-4 | 用户，误选了非空仓库时得到明确警告 | 不损坏仓库里已有的东西 | A |
| US-5 | 开发者，用熟悉的 Mongo 风格 API 读写 | 学习成本趋近于零 | E |
| US-6 | 用户，读写像本地一样快 | 日常使用感受不到远端存在 | F |
| US-7 | 用户，同步低频进行 | 不被平台限流、不打扰我 | F/K |
| US-8 | 用户，断网/限流时照常使用 | 恢复后自动补同步，不丢数据 | F |
| US-9 | 开发者，多步写操作要么全成要么全弃 | 数据不留半完成状态 | G |
| US-10 | 开发者，命令行直接查看/操作数据库 | 调试与运维不求人 | J |

## 2. 功能需求（FR）

### A 组 · 初始化与连接

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| A1 | `initDB()` 幂等：首次弹引导流程（v0.1 headless 参数模式），已初始化则静默直连 | ①无绑定时按参数走完整引导并落 `bindings.json`；②有绑定时不再要求任何交互即返回可用 db | SDK |
| A2 | `connect` 支持分支模式：仓库默认 `gitlite-repo`，database = `gitlite/<name>` 分支 | 连接后读写发生在指定分支；URI 形式 `gitlite://github:<profile>@<owner>/gitlite-repo/<db>` 与对象参数等价 | SDK |
| A3 | `createIfMissing`：仓库/分支不存在时自动创建（私有 + autoInit） | ①空账号首连自动建仓+建分支+bootstrap；②已存在时不重复创建不报错 | SDK/Provider |
| A4 | 仓库检查三态：`empty` / `gitlite` / `foreign` | `probeRepo` 对三者返回正确判定；`foreign` 且未获确认时**拒绝写入**并返回现有文件清单 | SDK |
| A5 | bootstrap：空库首次写入系统目录 | 生成 `gitlite.config.jsonc`(含 formatVersion 0.1.0)、`_schema/`、`_indexes/_manifest.json`、`_meta/head.json` 并形成首个 commit | 存储 |

### B 组 · 鉴权（GitHub）

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| B1 | Device Flow 登录 | 输出 user_code + verification_uri；轮询按 interval，处理 `slow_down`；成功拿到 token | Auth |
| B2 | PAT 直接注入 | `auth:{type:'pat'}` 可跳过 OAuth 直连（CI 场景） | Auth |
| B3 | token 存 OS 凭据库 | Node 环境写入系统凭据管理器；`~/.gitlite/` 下**不出现明文 token**；进程重启后可恢复 | Auth |
| B4 | 多 profile | 同机多账号隔离；`auth status/use/logout` 可管理；连接可指定 profile | Auth/CLI |
| B5 | 401/403 统一拦截 | token 失效给可读错误与重登指引；不裸抛 HTTP 错误 | Auth |

### C 组 · 数据库管理（分支模式）

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| C1 | `databases.create/list/drop` | create=建分支；list=列分支并剥 `gitlite/` 前缀；drop=删分支（带确认参数） | SDK |
| C2 | CLI `db create/list/drop` | 命令行为与 SDK 等价 | CLI |

### D 组 · 数据模型

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| D1 | schema 采用 JSON Schema 2020-12 子集 + `x-gitlite-*` 扩展 | 合法 schema 通过校验；非法（未知标准关键字误用/类型错）给出带字段路径的错误 | 存储 |
| D2 | ULID 默认主键 | 生成的 `_id` 符合 ULID 规范且时间有序；同 ms 内批量生成不冲突 | 存储 |
| D3 | 行分级存储 L0/L1/L2 | ①<50 行落 `<c>.jsonl`；②默认 `<c>/<id>.json`；③超 5000 行转 `shard-NNNN.jsonl`（片≤min(1000行,512KB)）；④迁移记录进 `_migrations/`；⑤对上层 API 透明（同一 find 跨级结果一致） | 存储 |
| D4 | `_rev` 内容哈希 | 同内容同 `_rev`；任何字段变更 `_rev` 改变 | 存储 |
| D5 | timestamps 自动维护 | 声明 `timestamps:true` 时 insert 填 createdAt/updatedAt，update 刷新 updatedAt（UTC ISO 8601） | 存储 |
| D6 | formatVersion 门禁 | repo.major>client.major 拒绝打开；0.x 实验期跨 minor 允许打开并告警 | 存储 |

### E 组 · CRUD 与查询

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| E1 | insertOne/insertMany | 返回 `_id`；违反 schema/唯一约束抛 `ValidationError`/`UniqueConstraintError`；insertMany 打包单 commit | 查询 |
| E2 | filter 操作符：`$eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or $not` + 点路径嵌套 | 全操作符单测覆盖；非法操作符/字段名报错 | 查询 |
| E3 | findOne/find/findById/count/exists | find 支持 sort/limit/skip/projection；结果分页结构 `{items,total,hasMore}` | 查询 |
| E4 | updateOne/updateMany/replaceOne/upsert | 操作符 `$set $unset $inc $push $pull $addToSet`；expectedRev 不符抛 `ConflictError` | 查询 |
| E5 | deleteOne/deleteMany | 软删除不实现（v0.4）；删除进 commit 队列可随事务回滚 | 查询 |
| E6 | 写后即读 | 事务外连续调用同一连接，insert 后立即 find 可见（本地 Mirror） | 查询/同步 |

### F 组 · 同步与缓存

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| F1 | 三层缓存 L1/L2/L3 | 读命中 L1 不触发 L2/L3；L3 落盘路径 `~/.gitlite/cache/...` | 同步 |
| F2 | economy 默认档 | 写 flush 10min 窗口/100 条；不轮询；远端调用 <8 次/h（模拟时钟验证） | 同步 |
| F3 | 强制同步时机 | connect 立即 pull+补推遗留；进程退出/手动 `close()` 立即 flush（测试可注入生命周期钩子） | 同步 |
| F4 | 手动 sync | `push/pull/sync/flush` 显式可用，`manual` 模式完全不自动 | 同步 |
| F5 | 离线队列 | 断网写操作成功返回（本地）；网络恢复后按序重放；进程重启队列不丢 | 同步 |
| F6 | OCC 冲突 | push 遇 non-fast-forward：pull→按 `_rev`/字段级合并→重试≤3 次；仍败抛 `ConflictError` 且本地数据不丢 | 同步 |
| F7 | 限流退避 | 403+`X-RateLimit-Remaining:0` → 暂停至 reset 时间；期间读写走本地（fully-local），事件通知 | 同步/配额 |
| F8 | 一致性选项 | `cache`（默认）/`synced`（flush 后读）/`fresh`（强制 pull）三级行为正确 | 同步 |

### G 组 · 事务

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| G1 | 短事务原子性 | 多表多操作单 commit；中途抛错则全部不生效且远端无残留 commit | 事务 |
| G2 | read-your-writes | 事务内读到本事务已写数据 | 事务 |

### H 组 · 索引

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| H1 | 单字段+唯一索引 | 声明后写入自动维护 `_indexes/<c>.<f>.idx.json`；唯一冲突抛错 | 索引 |
| H2 | 索引降级 | 索引文件缺失/损坏时自动全表扫描，查询不失败；后台重建 | 索引 |
| H3 | 索引随数据同步 | 索引变更与数据在同一 commit（远端可见） | 索引/同步 |

### I 组 · SDK 形态

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| I1 | `GitLite.connect` 对象参数 + URI 双形态 | 两种形态产生等价连接 | SDK |
| I2 | Collection 泛型 | `db.collection<User>('users')` 推断返回类型；filter 字段名拼写错误编译期报错 | SDK |
| I3 | 事件 | `insert/update/delete`（本地）与 `sync:push/pull/conflict`、`remoteChange` 可订阅 | SDK |
| I4 | 运行时注入 | v0.1 交付 `adapters/node`；core 不直接 import node 内置模块（可测性） | SDK |

### J 组 · CLI

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| J1 | `auth login/status/use/logout` | 全流程命令行可完成；status 显示 profile/有效期 | CLI |
| J2 | `db create/list/drop`、`repo create/list/delete` | 与 SDK 行为等价 | CLI |
| J3 | `data insert/find/update/delete/list/count` | `--json` 输出可管道 | CLI |
| J4 | `sync status/push/pull/flush` | status 显示在线态/队列/水位 | CLI |
| J5 | `repl` | 交互式执行 CRUD；支持 `.exit` | CLI |

### K 组 · 配额管理

| # | 需求 | 验收标准 | 载体 |
|---|---|---|---|
| K1 | 配额计数 | 每次远端调用后更新剩余量（解析响应头）；`quota status` 可查 | 配额 |
| K2 | 预算守门 | flush 前检查预算，不足则推迟并入下次窗口；触发 `quota:warning` | 配额 |

## 3. 非功能需求（NFR）

| # | 维度 | 要求 | 验证方式 |
|---|---|---|---|
| NFR-1 | 读性能 | L1 命中 P50 <1ms、P99 <5ms（1k docs 内存态） | bench 用例 |
| NFR-2 | 写性能 | insert 本地返回 P50 <5ms（不含 flush） | bench 用例 |
| NFR-3 | 远端预算 | economy 档稳态 <8 调用/h（模拟时钟） | 集成测试 |
| NFR-4 | 数据不丢 | 写返回即已落 L3；kill -9 后重启补推成功（模拟） | 故障注入测试 |
| NFR-5 | 格式兼容 | additive-only；黄金仓库 v0.1 快照可被后续版本读取 | 快照 CI |
| NFR-6 | 安全 | token 不入日志/明文文件；URI 中的 token 打印时脱敏 | 静态检查+用例 |
| NFR-7 | 平台 | Node ≥18；core/sdk 零 native 依赖；pnpm 构建 | CI 矩阵 |
| NFR-8 | 可测试 | core 单测行覆盖 ≥80%；Provider 可 mock 注入；真实 GitHub E2E 标记可选 | coverage 门禁 |
| NFR-9 | 可观测 | sync status/慢查询(>200ms)/配额事件可查询 | 用例 |

## 4. MVP 边界（v0.1 明确不做）

| 不做 | 归属版本 |
|---|---|
| Gitee Provider、多绑定 failover | v0.2 / v0.5 |
| 内置向导 UI（`@gitlite/ui`）、Codegen、聚合管道、复合索引、CLI explain | v0.3 |
| 长事务、字段加密、软删除 | v0.4 |
| SQLite 索引后端、文本索引、lazy 大集合 | v0.5 |
| 浏览器/移动端 adapter | v0.6 |
| include 关联展开、游标分页、`$lookup` | v0.3（v0.1 filter 不含关联） |
| auto-increment/named 主键策略 | 后置（v0.1 仅 ULID/PAT 注入） |
| YAML / MD frontmatter 存储格式 | 后置（v0.1 仅 JSON/JSONL） |

## 5. 需求变更记录

| 日期 | 编号 | 变更 | 理由 |
|---|---|---|---|
| — | — | — | 初稿，待复核冻结 |
