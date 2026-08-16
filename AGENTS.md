# AGENTS.md — AI 协作与进度控制入口

> **所有 AI（及新加入的人类协作者）动手前必须先读本文件。**
> 本文件是唯一内容源，已入 git；`CLAUDE.md` 与 `.github/copilot-instructions.md` 只是一行转发指针（只改本文件，勿在指针文件写内容）。
> 本文件只放「规矩、硬原则、地图」这类稳定内容；**活的进度与需求状态一律以 [docs/progress.md](docs/progress.md) 为准**，不要在本文件里找实时状态。

## 0. 进度控制协议（核心规矩）

1. **开工第一步**：读 [docs/progress.md](docs/progress.md)（唯一进度/需求入口）——确认当前阶段、下一个任务、红线，不从记忆或猜测开工。
2. **立即记录，不攒到收工**：每完成一个可验证的步骤（测试转绿 / 文档状态翻转 / bug 修复 / 决策确定）就**马上**更新 docs/progress.md——状态翻转 + 变更日志加一行（日期 / 做了什么 / 回归结果）。会话随时可能中断，没写进 progress.md 的进度等于丢失。
3. 需求与边界以 [docs/requirements.md](docs/requirements.md)（FR/NFR/MVP 边界）+ [docs/13-limits-and-ceiling.md](docs/13-limits-and-ceiling.md)（物理天花板与立项红线）为准。
4. 影响全局的决策（同步频率、格式、加密、存储结构等）：先在 [docs/decisions.md](docs/decisions.md) 写 ADR，再动代码。
5. 完成判据：§4 门禁全绿。门禁不绿不许在 progress.md 标 ✅。

## 1. 项目一句话

把 GitHub/Gitee 私有仓库当作数据库后端，做嵌入式的 Git-as-Backend 数据库——对标 SQLite 的引擎能力（查询/索引/事务/加密/快照），但零服务器、分钟级低频同步、纯前端可打包 dmg/exe/apk。

## 2. 必读文件地图（按优先级）

| 优先 | 文件 | 内容 |
|---|---|---|
| 1 | [docs/progress.md](docs/progress.md) | 唯一进度入口：流程模型、阶段状态、里程碑、变更日志 |
| 2 | [docs/14-engine-parity-sqlite.md](docs/14-engine-parity-sqlite.md) | 内圈能力轨（P1a→P4），当前推进序列所在 |
| 3 | [docs/13-limits-and-ceiling.md](docs/13-limits-and-ceiling.md) | 外圈物理天花板（平台配额→容量/延迟/吞吐/并发），立项红线 |
| 4 | [docs/decisions.md](docs/decisions.md) | ADR-001 同步频率 / ADR-002 格式宪法 / ADR-003 字段级加密 |
| 5 | [docs/11-implementation-design.md](docs/11-implementation-design.md)、[docs/12-review-checklist.md](docs/12-review-checklist.md) | 架构设计 + 复核清单 |
| 6 | [docs/requirements.md](docs/requirements.md) | 需求基线（用户故事 / FR / NFR / MVP 边界） |
| 7 | `packages/core/src/` | 核心代码（client / sync / storage / query / index / tx / crypto） |
| — | [project_memory.md](project_memory.md) | 设计期记忆存档；与 docs/ 冲突时以 docs/ 为准 |

## 3. 硬原则（不可违反）

- **格式宪法（ADR-002）**：仓库结构/格式变更一律 additive-only；未知字段/文件老客户端必须原样保留；不许改 `_rev`/JSONL 结构（防用户数据库被重置）。改动前先看 ADR-002。
- **数据先走内存镜像（ADR-001）**：写 = 镜像 + 离线队列，flush 才批量同步远端；同步频率默认 economy（10 分钟窗口，启动/退出强制同步）。
- **加密在 commit/pull 边界（ADR-003）**：镜像/基线/diff 必须明文（随机 IV 会让密文 diff 不稳）；加密字段禁索引/唯一/复合。
- **core 零 node 内置依赖**：一切经 RuntimeAdapter 注入（fs/crypto/credential/fetch）；WebCrypto 用 `globalThis.crypto.subtle`。
- **平台配额是硬约束**：GitHub 内容创建 500 次/h 是写吞吐真瓶颈；不复刻「秒级同步」。

## 4. 验证命令（工作目录 = 仓库根）

| 命令 | 用途 |
|---|---|
| `npx vitest run` | 全量测试 |
| `npx vitest run --coverage` | 覆盖率（看 All files lines，门槛 ≥80%） |
| `npm run typecheck` | 4 包 tsc strict，0 错误 |

测试文件与源码同目录（如 `src/crypto/cipher.test.ts` 测 `cipher.ts`）。

## 5. 当前状态快照（2026-08-16）

> ⚠️ 快照会过期，**一律以 [docs/progress.md](docs/progress.md) 为准**。

- 能力轨（docs/14）：P1a→P4 全部 ✅（内圈补齐序列收官）
- 功能轨（docs/13）v0.2：全部 ✅；v0.3：格式冻结 1.0.0 ✅（ADR-002 已执行，golden-v1.0 基线）、Codegen ✅、@gitlite/react + @gitlite/ui ✅
- **全部规划内可实现项已完成**（7 包：core/adapters-node/codegen/react/ui/sdk/cli）；剩余仅物理依赖用户的事项（见下）
- 门禁：188 测试全绿（31 文件），覆盖率 lines 91.48%，7 包 build/typecheck 0 错，golden v1.0 冻结基线稳定

**醒来后只剩三件物理上无法代做的事**：① Gitee OAuth 真机 E2E（需用你的 Gitee 账号注册 OAuth App，回调填 `http://127.0.0.1:18365/callback`）；② mac/linux 真钥匙串验证（security/secret-tool CLI 实测，本机是 Windows）；③ review + commit（全部代码在工作区未提交，与之前的未提交改动并存）。

## 6. 已知坑（历史教训，勿重踩）

- **markSynced 竞态**：flush 期间晚到写入会被误标已同步吞掉——现为增量基线 + 仅清「基线已与镜像一致」集合的脏标记。改同步逻辑时保持此语义。
- **decryptFiles 依赖 schema**，但它运行在 importFiles（schema 加载）之前——现自行从 `_schema/` 解析加密字段。
- **putSchema 的 `void flush()` 是吞写源头**——已改走 `schedule()` 统一调度；不要恢复后台裸 flush。
- **跨包类型走 dist**：改 core 的类型/导出后，`npm run typecheck` 前先 `npm run build`——adapters-node/sdk 解析 `@gitlite/core` 的类型用的是 dist 声明（vitest 走 src 别名，测试绿 ≠ typecheck 绿）。
- **manager 的 guard 会吞存储异常**（by design，H2 降级）：调试 SQLite 后端时用裸 `SqliteIndexStore` 复现，别隔着 IndexManager 看不到真实错误。
