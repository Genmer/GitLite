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

## 五、v0.1 实现质量门禁（实测）

| 指标 | 要求 | 实测 |
|---|---|---|
| 测试 | 全绿 | ✅ 10 文件 / 65 用例 |
| 覆盖率（core） | lines ≥80% | ✅ 85.1%（branches 79.6% / functions 82.3%） |
| 类型检查 | 4 包 tsc strict | ✅ 0 错误 |
| 黄金快照 | 逐字节复现 | ✅ 基线已生成（`packages/core/test-fixtures/golden-v0.1.json`） |

## 六、遗留项（诚实清单，v0.1 收尾前处理）

| 项 | 状态 | 说明 |
|---|---|---|
| ~~真仓库 E2E~~ | ✅ **用户实测通过** | @Genmer 真实账号全链路：Device Flow → 自动建仓 `gitlite-repo` → 建分支 → bootstrap → push（2026-08-15） |
| `databases.drop` | ⬜ | 需给 Provider 接口补 `deleteBranch`（GitHub DELETE /git/refs） |
| CLI REPL（J5） | ⬜ | 降级移至 v0.2（MVP 边界外追回项） |
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
