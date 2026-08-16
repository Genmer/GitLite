# GitLite 开发进度

> 本文档是实施阶段唯一进度入口：流程模型、阶段状态、里程碑清单、变更日志。每次工作会话结束必须更新。
> 设计基线见 `00`~`10` 设计文档与 `decisions.md`（ADR）。**重大决策先写 ADR 再动代码。**

## 一、流程模型

```
P0 需求 ──► P1 架构设计 ──► P2 需求-架构复核 ──► P3 实现循环（每个里程碑内 code-review ∥ test 并发）
   │                                             │
   └────────── 发现需求缺陷时回溯 ◄───────────────┘
```

| Phase | 内容 | 完成判据（DoD） |
|---|---|---|
| **P0 需求** | 从设计文档与用户对话提炼：用户故事、功能需求 FR（带验收标准）、非功能需求 NFR、MVP 边界 | 每条 FR 可测试、有唯一编号；范围冻结（变更走记录） |
| **P1 架构设计** | 模块级细化：目录骨架、接口签名、数据流时序、错误模型落地 | 每个 FR 能指出由哪个模块哪个接口承载 |
| **P2 需求-架构复核** | 逐条 FR 对照架构：覆盖？缺口？过度设计？ | 复核清单全绿或有处置结论；输出差距报告 |
| **P3 实现循环** | 按里程碑 M1..Mn 实现；每步「实现 → code review → test」并发推进 | CI 绿、覆盖率达标、review 意见闭环 |

## 二、阶段状态总览

| Phase | 阶段 | 状态 | 产出物 |
|---|---|---|---|
| P0 | 需求 | ✅ 冻结 | [requirements.md](./requirements.md)（10 用户故事 / A~K 11 组 FR / 9 条 NFR / MVP 边界） |
| P1 | 架构设计 | ✅ 完成 | [11-implementation-design.md](./11-implementation-design.md)（模块图/接口契约/数据流/错误模型/测试策略） |
| P2 | 需求-架构复核 | ✅ 通过（0 缺口/6 注意项） | [12-review-checklist.md](./12-review-checklist.md) |
| P3 | 实现循环 | ✅ M1–M8 完成 / M9 部分 | `packages/` 代码 + 65 测试全绿 + 覆盖率过门禁 |

> 阶段状态图例：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⏸ 暂停

## 三、P3 里程碑拆解（v0.1 MVP，对应路线图）

| 里程碑 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **M1** 工程骨架 | monorepo（npm workspaces）、TS 严格模式、vitest、覆盖率门禁、包骨架 | — | ✅ |
| **M2** Provider+Auth | GitHubProvider（Git DB API 四步 commit + CAS）、Device Flow（sleep 可注入）、PAT、凭据文件库、MemoryProvider | M1 | ✅ |
| **M3** 存储引擎 | L0/L1/L2 分级（迟滞+迁移记录）、JSON Schema 子集校验、ULID、_rev、bootstrap、diff（永不删用户文件） | M2 | ✅ |
| **M4** 同步引擎 | 镜像缓存、append-only 离线队列、economy 调度、启动/退出强制同步、CAS 冲突重试、pull 本地胜出合并 | M3 | ✅ |
| **M5** 查询+索引 | filter 全操作符、CRUD API、OCC expectedRev、单字段+唯一索引、索引随数据 commit、损坏降级 | M3 | ✅ |
| **M6** 事务 | 短事务（buffer→批量应用→单 commit flush）、read-your-writes、失败零残留 | M4 M5 | ✅ |
| **M7** SDK | connect（对象/URI）、initDB（幂等 headless）、databases.create/list、PUT schema | M2-M6 | ✅ |
| **M8** CLI | auth/db/data/sync 命令组（手写 argv）；REPL 移至 v0.2 | M7 | ✅ |
| **M9** 集成与发布 | 黄金仓库快照 ✅；**真实 GitHub E2E 用户验证通过**（Device Flow/自动建仓/bootstrap/push 全链路）✅；db drop 待 provider.deleteBranch；正式 client_id 待注册官方 App 后替换占位 | M1-M8 | 🔄 |

每个里程碑内部流程（固定）：

```
1. 设计微调（如接口需细化 → 更新 11-implementation-design.md）
2. 测试先行（先写核心用例，红）
3. 实现（绿）
4. code review（自查清单：见 P2 产出）
5. 集成验证 + 更新本文档状态
```

## 四、v0.1 范围内明确不做（防蔓延）

- Gitee Provider（v0.2）、浏览器/移动端 adapter（v0.6）、内置 UI 向导（headless API 先行，UI v0.3+）
- 聚合管道、复合索引、长事务、字段加密、多绑定 failover、SQLite 索引后端（各属 v0.3~v0.5）
- 详见 [requirements.md §MVP 边界](./requirements.md)

## 五、实现质量门禁（实测，随里程碑滚动更新）

| 指标 | 要求 | 实测（2026-08-16 全量收官后） |
|---|---|---|
| 测试 | 全绿 | ✅ 31 文件 / 188 用例（v0.1 时 65；包数量 4→7） |
| 覆盖率（core） | lines ≥80% | ✅ 91.48%（branches 83.61% / functions 90.05%） |
| 类型检查 | **7 包** tsc strict | ✅ 0 错误（core/adapters-node/codegen/react/ui/sdk/cli） |
| 黄金快照 | 逐字节复现 | ✅ **v1.0.0 冻结基线** `golden-v1.0.json`（ADR-002 冻结执行） |

## 六、遗留项（诚实清单，v0.1 收尾前处理）

| 项 | 状态 | 说明 |
|---|---|---|
| ~~真仓库 E2E~~ | ✅ **用户实测通过** | @Genmer 真实账号全链路：Device Flow → 自动建仓 `gitlite-repo` → 建分支 → bootstrap → push（2026-08-15） |
| ~~`databases.drop`~~ | ✅ 已具备 | Provider.deleteBranch 三家齐备（GitHub DELETE refs / Gitee DELETE branches / Memory）；sdk databases.drop 可用 |
| ~~CLI REPL（J5）~~ | ✅ **v0.2 追回落地** | `gitlite repl --db <uri>`：JS 表达式求值（Proxy 直达 collection：`db.users.find(...)`）+ await/事务 + 点命令（.schema/.collections/.sync/.push/.pull）+ 多行续行 + Tab 补全（点命令/集合/方法）+ 历史持久化（~/.gitlite/repl-history）；可测核心与 readline 循环分离，PassThrough 冒烟覆盖 Ctrl+D 关闭竞态 |
| Device Flow client_id | ⚠️ 占位 | 开发期走 env `GITLITE_DEVICE_CLIENT_ID`（用户自建 App 可用）；正式发布注册 GitLite 官方 App 后替换常量 |
| L1→L2 在线分裂 | ⚠️ 简化 | v0.1 为「下次 flush 重排」（P2 复核已登记 D3 注意项） |

## 七、变更日志

| 日期 | 变更 | 备注 |
|---|---|---|
| 2026-08-15 | 建立进度文档；启动 P0 需求阶段 | 流程模型与里程碑拆解定稿 |
| 2026-08-15 | P0 需求初稿完成（requirements.md） | 10 用户故事、FR A~K 共 11 组、NFR 9 条、MVP 不做清单；待 P2 前冻结 |
| 2026-08-15 | P1 实施设计 + P2 复核完成 | 0 缺口 / 6 实现注意项；批准进入 P3 |
| 2026-08-15 | **P3：M1–M8 完成，M9 部分** | 65 测试全绿、覆盖率 85.1% 过门禁、tsc 0 错、黄金快照基线建立；遗留 5 项见上表 |
| 2026-08-15 | initDB 可运行演示落地 | core 加 `ConnectStep`/`onProgress`，sdk 加 `providerInstance` 注入；`examples/demo-init.ts`（`npx tsx examples/demo-init.ts`）实测：首跑建仓/建分支/bootstrap ✓、二跑幂等静默直连 ✓、数据完好 ✓；回归 65/65 绿 + tsc 0 错 |
| 2026-08-15 | **真实链路 initDB 落地（全自动模式 B）** | Provider 加 `getUser()`；`initDB` 无 owner 时自动「Device Flow 登录→识别身份」；`onLoginCode` 回调透出（页面显码/自动开浏览器归宿主）；client_id 开发期走 env（`GITLITE_DEVICE_CLIENT_ID`）；新增 `examples/demo-real.ts` 真实演示（无 client_id 时打印注册指引退出）。回归 65/65 + tsc 0 错 |
| 2026-08-15 | **✅ 真实 GitHub E2E 用户验证通过**（M9 关键项） | 用户 @Genmer 实测：Device Flow 登录 ✓ 自动识别账号 ✓ 自动建私有仓 `Genmer/gitlite-repo` ✓ 自动建分支 `gitlite/demo-db` ✓ bootstrap ✓ 真实数据写入 push ✓ |
| 2026-08-15 | **对外发布文档落地** | `docs/index.html`（人读：原理/数据安全模型/上手/API/格式契约/AI 接入/FAQ，单文件零依赖，明暗自适应，浏览器实测无破版+修复锚点遮挡）；`docs/llms.txt`（AI 接入标准：心智模型/安全事实口径/Agent 六条硬规则/最小代码/文档地图） |
| 2026-08-16 | **定纲：外圈+内圈天花板**（docs/13、docs/14） | 13 号：平台配额推演容量/延迟/吞吐/并发四维极限与立项红线；14 号：SQLite 引擎能力逐项对标（12 项判定 + 判定法则 + P1a~P4 补齐序列） |
| 2026-08-16 | **P1a 索引范围扫描落地**（SQLite B-Tree 范围查找对位） | IndexManager 加类型感知排序 key + 二分 rangeCandidates；Collection 等值/范围条件自动分流（修复：等值路径截胡操作符条件返空的 bug）；range.test.ts 6 用例；回归 73/73 绿 + tsc 0 错 |
| 2026-08-16 | **P1b 脏集合增量 diff 落地**（WAL 增量写对位） | StorageEngine 写路径标 dirty → exportFiles/diff 只导出脏表 + 受限删除（clean 表/用户文件零触碰）+ ownerOf；IndexManager 按表过滤导出（manifest 常驻）；flush 空 diff 清脏；dirty.test.ts 5 用例 |
| 2026-08-16 | **P1c pull 增量化落地**（按需页读取对位） | 新增可选 `getChangedFiles?` 原语（树一次比对 + 仅拉变更 blob + 删除清单）；GitHub 与 Memory 双实现；commit 返回全树作 remoteTree 增量基准；SyncEngine 首拉全量/后续增量 + 基线+增量重构远端全量；pull-incremental.test.ts 5 用例（含 GitHub mock 按需取 blob 验证） |
| 2026-08-16 | **P1 性能三优化全部完成** | P1a/P1b/P1c 闭环：回归 83/83 绿 + tsc 0 错；docs/13、14 三处状态翻转；v0.2 性能阶段收口 |
| 2026-08-16 | **P2 最小计划器 + explain 落地**（SQLite 代价优化器对位第一步） | 新增 `query/planner.ts`：单一事实源 select() 决策 index-eq/index-range/full-scan + 精确候选基数预估（统计信息），Collection.explain() 与实际执行严格一致；替换旧 firstIndexedEq/Range 双函数；planner.test.ts 5 用例；回归 88/88 绿 + tsc 0 错 |
| 2026-08-16 | **P2 复合索引落地**（联合索引对位） | IndexDef 加 fields 支持多字段；compositeCandidates 全字段等值匹配（部分前缀留 v0.3）；写路径/唯一约束/rebuild 全兼容；planner 新增 index-composite 路径优先；composite.test.ts 6 用例 |
| 2026-08-16 | **P2 聚合管道落地**（GROUP BY/聚合对位） | 新增 `query/aggregate.ts`：$match/$group/$sort/$skip/$limit/$project/$count + $sum/$avg/$min/$max/$push；Collection.aggregate()；aggregate.test.ts 10 用例 |
| 2026-08-16 | **P2 全部完成** | 优化器第一步 + 复合索引 + 聚合管道：回归 104/104 绿 + 覆盖率 88.41% + tsc 0 错；docs/14 P2 三行翻转 ✅ |
| 2026-08-16 | **P3 长事务 SAVEPOINT 落地**（SQLite SAVEPOINT 对位） | TransactionManager 加 savepoint/rollbackTo：buffer 快照栈 + 部分回滚 + 同名隐式释放 + 嵌套 + 回滚不存在的点抛错整体回滚；单 commit 原子性不变；savepoint.test.ts 4 用例；回归 108/108 绿 + tsc 0 错 |
| 2026-08-16 | **P3 字段级加密落地**（SQLite SEE 对位，ADR-003） | 新增 `crypto/cipher.ts`（AES-256-GCM + PBKDF2 WebCrypto，零依赖）；加密仅在 SyncEngine commit/pull 边界（encryptChanges/decryptFiles，幂等），镜像/基线/diff 全明文保证 diff 稳定；加密字段禁索引/唯一/复合（schema 校验互斥）；passphrase 注入 + OS 凭据库缓存（按 provider/仓库/分支隔离）；无口令/错口令安全降级读密文；**修复 markSynced 竞态**（增量基线 + 仅清一致集合脏标记，防止 putSchema void flush 吞写）+ putSchema 改走统一调度；cipher.test.ts 12 用例；回归 120/120 绿 + 覆盖率 89.99% + tsc 0 错 |
| 2026-08-16 | **建立 AI 协作与进度控制入口** | 新增根 `AGENTS.md`（进度控制协议：开工先读 progress.md / 收工必更新 + 硬原则 + 验证命令 + 状态快照 + 已知坑）与 `CLAUDE.md` 转发指针；README 头部加「协作与进度控制」入口区、文档表补 11~14/需求/进度行、修正过期状态；`project_memory.md` 标记为设计期存档。纯文档变更，无代码改动 |
| 2026-08-16 | **P4 本地 SQLite 索引后端落地**（Pager 分页缓存对位，内圈唯一「换部件」项完成） | `IndexStore` 双后端：内存（默认，对外 API 零改动）+ SQLite（`index/sqlite-store.ts`，经 `RuntimeAdapter.sqlite` 注入同步能力，core 零 node 依赖）；XOR 文档指纹增量维护（onWrite 可增量更新）→ 重启/未变 pull 跳全量重建；idx.json 渲染缓存 + importFiles 全命中零写入快路径；`indexBackend:'sqlite'` 接线 client/sdk（缓存 `~/.gitlite/cache/<指纹>/index.db`，可删重建），adapters-node 加 `createNodeSqlite()`（node:sqlite，Node<22.5 返回 null 回退内存）；**顺带修复两个存量 bug**：①idx.json 空 entries（`JSON.stringify(Map)` 得 `{}`，带内索引持久化从未生效，golden 基线已重生成）②内存后端同值更新丢排序键（空桶不删除致 insertSorted 跳过，范围扫描漏数据——parity 测试暴露）+ importFiles 漏建 sorted；sqlite.test.ts 9 用例（双后端 parity/持久化零写入/指纹跳过/降级/唯一/client 全链路）+ adapters-node 冒烟 2 用例；回归 131/131 绿 + 覆盖率 91.34% + tsc 0 错；docs/08/13/14 状态翻转 |
| 2026-08-16 | **CLI REPL 落地**（J5 v0.2 追回，功能轨第 11 项） | 新增 `packages/cli/src/repl.ts`：`db.<collection>.<op>()` 表达式求值（AsyncFunction + Proxy 属性直达 collection，支持 await / db.transaction）、点命令（.help/.exit/.collections/.schema/.sync/.push/.pull）、括号引号未闭合自动续行、Tab 补全（点命令/collection 名/集合方法；字段级补全留 v0.3）、历史持久化（~/.gitlite/repl-history，截尾 200）；可测核心（handleLine/isIncomplete/makeCompleter）与 readline 循环分离；**修复两处交互缺陷**：行事件异步并发需 promise 链串行化（慢求值晚于 .exit 关闭后 prompt 会 use-after-close）、Ctrl+D 输入流关闭与链排空竞态（safePrompt + 链结算后 resolve）；repl.test.ts 6 用例（含 PassThrough 全会话冒烟）；回归 137/137 绿 + 覆盖率 91.41% + tsc 0 错 |
| 2026-08-16 | **Gitee Provider 落地**（功能轨第 9 项，docs/02 §2.2 不对称适配） | 新增 `provider/gitee.ts`（API v5，Bearer 认证，fetch 注入零 node 依赖）：**Contents 降级提交**（无 Git DB API → 逐文件 POST 创建/PUT 更新按 sha 区分 + DELETE 幂等，多文件消息带序号，非原子已文档化）；CAS = 提交前 getHead 预检（ConflictError）；`getChangedFiles` 增量拉取 = 目录递归列表（每目录 1 调用）得 path→sha 树 + 仅拉变更文件内容；扩展名守卫（Gitee contents 硬约束，docs/02）；UTF-8 安全 base64（btoa 多字节会抛错）；错误映射对齐 GitHub（401/403/409/422/5xx，Gitee 限流头不规整按保守退避）；分页 page 参数拉全；createBranch 按 refs 源分支名 + 冲突幂等；SDK 接线：provider 'gitee'（凭据键 `gitlite:gitee:*` 隔离）+ databases.create/list/drop 支持 gitee；gitee.test.ts 10 用例（mock fetch 路由）；回归 147/147 绿 + 覆盖率 91.23% + tsc 0 错；遗留：Gitee OAuth PKCE+loopback 交互登录（需 loopback server 能力注入，PAT 已可用）；`databases.drop` 遗留项随之关闭（三家 deleteBranch 齐备） |
| 2026-08-16 | **OS 凭据库落地**（功能轨第 10 项，docs/04） | 新增 `adapters-node/src/credentials.ts`：FileCredentialStore（0600 文件，v0.1 行为迁移）+ `createOsCredentialStore`——零原生依赖路线：darwin=`security` CLI（add/find/delete-generic-password，exit 44=不存在→null）、linux=`secret-tool`（store 走 stdin 防进程列表泄露，lookup/clear）、其余平台（win32 等）直接文件回退；**ENOENT 粘性降级**（CLI 缺失自动切文件且不再重试）；非 ENOENT 真实失败上抛不静默；runner/platform 可注入（测试与宿主覆盖）；`createNodeRuntime({ credential: 'os' })` 选入（默认 file 兼容 v0.1，测试稳定性优先）；credentials.test.ts 5 用例；回归 152/152 绿 + 覆盖率 91.23% + build/typecheck 0 错 |
| 2026-08-16 | **v0.2 收尾：限流响应头精确解析 + REPL 字段级补全**（功能轨第 11 项全量收口） | ① 新增 `provider/rate-limit.ts` 共享解析：Retry-After（秒数/HTTP-date，次级限流标准头）优先 → X-RateLimit-Remaining=0 + Reset（unix 秒差值；reset 已过=1s 小退避；确认限流但无 reset 才保守 60s）——github/gitee 的 req 统一接线：**429 新增映射**（原 GitHub 429 直接穿透未处理）、403 仅在可识别限流头时报 RateLimitError（精确 retryAfterMs），否则 AuthError（修正 Gitee 原「403 无头一律当限流」的误报）；rate-limit.test.ts 5 用例 + github/gitee 各增 3 断言组。② REPL 补全扩展：filter 对象内（`db.users.find({ …`）补 schema 字段名（带引号键形态 `'email': `）与 $ 操作符（词表与 filter.ts 实际支持集一致）。回归 158/158 绿 + 覆盖率 91.28%（rate-limit.ts 100%）+ build/typecheck 0 错 |
| 2026-08-16 | **Gitee OAuth 授权码 + loopback 登录落地**（v0.2 功能轨最后遗留项收口，docs/04） | 架构决策（自主拍板）：loopback HTTP 服务放 **adapters-node**（node 本就是能力层），core 接口零扩张。① core `auth/gitee.ts` 纯逻辑：授权 URL（state 必传防 CSRF；PKCE 参数保留可选——Gitee 无官方文档化支持，docs/02 差异表）、换 token/刷新（POST 表单 + JSON 响应，fetch 注入零 node 依赖）、client_id env 解析（GITLITE_GITEE_CLIENT_ID，与 GitHub Device Flow 同模式）。② adapters-node `loopback.ts`：`waitForRedirect` 一次性回调接收（固定端口 18365 = docs/04；port=0 随机供测试；onListening 端口就绪回调；超时拒绝；closeIdleConnections 防进程悬挂）。③ sdk `giteeLogin`：loopback → 授权 URL（onCode 回调宿主展示/开浏览器）→ state 校验 → 换 token → 存 `gitlite:gitee:default`。④ CLI：`gitlite auth login --provider gitee`；auth status 双平台显示。测试：gitee.test.ts 4 用例（URL 形态/表单体/错误映射/env 解析）+ loopback.test.ts 3 用例（**真实 socket** 回调/超时）+ sdk gitee-login.test.ts 2 用例（全流程含 state 篡改拒绝）；**真机 Gitee E2E 待用户**（需注册 Gitee OAuth App 填回调 http://127.0.0.1:18365/callback）。回归 168/168 绿 + 覆盖率 91.41% + build/typecheck 0 错。**v0.2 功能轨至此全部落地** |
| 2026-08-16 | **Codegen 强类型 Client 落地**（v0.3 第 3 项，docs/09 §三） | 新包 `@gitlite/codegen`（第 5 个包）：schema(.schema.jsonc，**真实 JSON Schema + x-gitlite-\* 格式**，非 docs 示例简化形态) → `gitlite.types.ts`（Doc 接口注入 _id/时间戳/_rev 系统字段并防重复 + Input 接口剔除系统字段保持必填约束）+ `gitlite.client.ts`（TypedGitLiteClient：类型化 Collection 成员 + raw 透出未生成面 + connect 便捷函数）；tsType 映射覆盖 string/int/integer/number/boolean/null/array(object items)/object/类型数组去重；非标识符名安全处理（声明字符串键 + 访问方括号——`this."x"` 不合法的坑）；乱序输入确定性输出（排序稳定）；CLI `gitlite codegen [--schema][--out][--watch]`（watch=fs.watch 防抖 200ms，常驻）；**顺带修复 CLI 存量缺陷**：无子命令的命令（repl/codegen）第一个 flag 会被 run() 的 sub 槽吃掉导致参数整体错位（repl --db 此前实际不可用）。index.test.ts 8 用例 + CLI 冒烟 1 用例；vitest 别名/build 链/package 依赖接入；回归 176/176 绿 + 覆盖率 91.41% + build/typecheck 0 错 |
| 2026-08-16 | **格式冻结 1.0.0（ADR-002 提前执行）** | `SYS.formatVersion` 0.1.0→**1.0.0**（§3.6 清单即冻结范围）；读兼容策略：0.x 仓库可读（format:warn 一次后继续）、2.x 拒读（FormatVersionError）、同版本静默；黄金基线重立 `golden-v1.0.json`；新增 `format-version.test.ts` 四态用例；存量断言随冻结更新（engine/integration 的版本锚定）；decisions.md ADR-002 §3.5 追加冻结执行记录 |
| 2026-08-16 | **@gitlite/react + @gitlite/ui 落地**（第 6/7 个包，docs/09 §六 + docs/04 向导） | ① `@gitlite/react`：useGitLite（连接生命周期/卸载即 close）、useCollection、useFind（filter/opts 序列化比较 + **remoteChange/sync:pull 自动 refetch**，docs/09 契约）、useDoc、useUpdate（pending 往返）；以 db 为中心的 API（bus 可达；codegen 用户传 db.raw）。② `@gitlite/ui`：`<GitLiteWizard>` 多步向导（选平台→登录（onCode 提示码/授权 URL）→身份预填+仓库配置→连接（ConnectStep 中文进度）→onReady/db；错误步可重试）；**flows 可注入**（默认 nodeFlows=Device Flow/Gitee OAuth+sdk connect，桌面宿主；浏览器宿主注入自定义 flows 免打包 node 内置）。测试基建：react19 + @testing-library/react + jsdom（vitest 按文件 pragma 切环境，include 补 .test.tsx）；react 5 用例（真实 memory 链路 + 事件自动 refetch）、ui 4 用例（全流程/进度/错误重试/owner 校验；vitest 无 globals 需手动 afterEach(cleanup)）；typecheck/build 链扩至 7 包。回归 188/188 绿 + 覆盖率 91.48% + build/typecheck 0 错。**v0.2+v0.3 可自主项至此全部完成** |
| 2026-08-16 | **Gitee OAuth 真机 E2E 自动化就绪**（等用户 1 分钟登记后一条命令可跑） | ① 补 `client_secret` 全链路：core `resolveGiteeClientSecret()`（Gitee 换 token 必需，env `GITLITE_GITEE_CLIENT_SECRET`）+ sdk giteeLogin 默认取 env；② 新增 `examples/demo-gitee-oauth.ts` 真机全链路演示（无凭据时打印登记指引；有凭据时自动：弹浏览器授权 → loopback 接码 → 换 token → initDB 识别账号/建仓/建分支/bootstrap → 写入读回 → 强制 push），对齐 demo-real.ts 模式。登记地址 gitee.com/oauth/applications/new，回调必须 `http://127.0.0.1:18365/callback`，权限勾 projects+user_info。OAuth 应用创建是账号网页专属操作（无 API）——该步物理上只能用户做，其余全部自动化。回归 188/188 绿 + build/typecheck 0 错 |
| 2026-08-16 | **引导配置模块落地**（`gitlite setup` + `<GitLiteSetup>`：全程页面/向导引导配置，不再需要口头指引） | ① sdk 配置层 `app-config.ts`：`~/.gitlite/app-config.json` 持久化 OAuth 应用凭据（登记一次全机生效，按平台合并不互覆；token 仍只走凭据库）；giteeLogin/interactiveLogin 凭据解析链：显式参数 > env > app-config > 占位。② `@gitlite/ui` 新增 **GitLiteSetup**：挂载即环境检测（两平台「OAuth 应用/已登录」状态徽标）→ OAuth 登记引导页（注册链接直达 + 回调地址一键复制 + 权限说明 + ClientID/Secret 粘贴保存）或 PAT 粘贴（getUser 校验通过即存并自动识别 owner）→ 自动进入 GitLiteWizard（PAT 带 token/owner 直达仓库配置步）；GitLiteWizard 支持 initialToken/initialProvider/initialOwner 跳步；错误页返回记住来源表单。③ CLI `gitlite setup`：终端同流程交互版（检测 → 选平台 → OAuth 登记/PAT → 校验保存 → 可选立即登录），`--check` 非交互打印状态。④ 测试：app-config 3 用例（真实文件跨会话持久）+ setup 组件 6 用例 + cli --check；**修 build 链依赖顺序**（sdk 需先于 react/ui，旧序 ui 在 sdk 前导致跨包类型读旧 dist）。回归 198/198 绿 + 覆盖率 91.49% + build/typecheck 0 错 |
| 2026-08-16 | **引导配置演示页上线**（`npx tsx examples/setup-page/server.ts` → http://127.0.0.1:4173） | 浏览器版自助配置全链路：React 页面（esbuild 单进程打包 + node 适配桩）+ 同进程 /api 能力端点（状态检测/OAuth 凭据保存/PAT 校验/Device Flow 与 Gitee OAuth loopback 登录（登录任务轮询式）/服务端真实连接建仓）；token 永不出服务端凭据库；页面错误探针（白屏时把脚本错误写到 #root）。**修复浏览器侧两处**：① IAB 内联 module 脚本不执行 → 改独立 /app.js 文件服务；② detect 调用参数序颠倒（api('GET', path) → api(path)）导致状态键 undefined。无头自检通过：首页双平台绑定状态徽标（真实反映）+ Gitee OAuth 登记引导页（注册链接/回调一键复制/权限说明/凭据粘贴） |
