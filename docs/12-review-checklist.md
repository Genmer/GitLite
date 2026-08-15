# 12 · 需求-架构复核清单（P2 产出）

> 逐条 FR/NFR 对照 [11-implementation-design.md](./11-implementation-design.md) 与既有设计文档。
> 结论：✅ 已覆盖（有明确模块+接口承载）｜⚠️ 覆盖但需实现时注意（备注风险）｜❌ 缺口（必须补设计）。

## FR 复核

### A 初始化与连接

| # | 载体（模块/接口） | 结论 | 备注 |
|---|---|---|---|
| A1 initDB 幂等 | sdk `initDB(opts)` + 本地 bindings 文件 | ✅ | bindings 路径 `~/.gitlite/bindings.json`；v0.1 无 UI，headless 参数即全部 |
| A2 分支模式 | client + provider.createBranch/listBranches | ✅ | URI 解析在 sdk |
| A3 createIfMissing | connect 流程（§3.1） | ✅ | autoInit 保证 main 存在 |
| A4 三态检查 | connect 流程 probe + ForeignRepoError | ✅ | foreign 只读：collection 写操作须拦截（实现点，已在错误模型列 ForeignRepoError） |
| A5 bootstrap | storage.exportFiles 系统文件 | ✅ | formatVersion=0.1.0（0.x 实验期） |

### B 鉴权

| # | 载体 | 结论 | 备注 |
|---|---|---|---|
| B1 Device Flow | sdk auth（fetch 轮询 github.com/login/device） | ✅ | client_id 常量；interval/slow_down 处理 |
| B2 PAT | auth:{type:'pat'} | ✅ | |
| B3 OS 凭据库 | adapters-node credential | ⚠️ | v0.1 无 keytar（避免 native 依赖）：实现为 0600 权限文件 + 可选 passphrase 加密；文件不落在 `~/.gitlite/`（放系统凭据目录或同目录加密体），并在文档标注为 fallback 级别 |
| B4 多 profile | sdk profiles + credential key 规范 `gitlite:<provider>:<login>` | ✅ | |
| B5 401/403 拦截 | provider 错误映射 + AuthError | ✅ | |

### C 数据库管理

| # | 载体 | 结论 |
|---|---|---|
| C1 databases.create/list/drop | sdk 静态方法 → provider 分支 API | ✅ |
| C2 CLI db | cli | ✅ |

### D 数据模型

| # | 载体 | 结论 | 备注 |
|---|---|---|---|
| D1 schema 子集校验 | schema/validate | ✅ | 未支持关键字必须报错不静默 |
| D2 ULID | model/ulid | ✅ | 同 ms 单调递增防碰撞 |
| D3 分级存储 | storage 序列化 | ⚠️ | L1→L2 自动迁移（>5000 行）v0.1 实现为「下次 flush 重排 + _migrations 记录」，无在线分裂；测试覆盖跨级一致性 |
| D4 _rev | model/rev（规范化 JSON SHA1 前 12） | ✅ | |
| D5 timestamps | collection 写路径 | ✅ | |
| D6 formatVersion 门禁 | connect 检查 | ✅ | 0.x 期：跨 minor 告警放行 |

### E CRUD

| # | 载体 | 结论 | 备注 |
|---|---|---|---|
| E1 insert | collection | ✅ | |
| E2 filter 操作符 | query/filter | ✅ | v0.1 无 $all/$elemMatch（已在 MVP 边界） |
| E3 find 族 | collection | ✅ | projection 实现为字段挑选 |
| E4 update 族 | query/update + OCC expectedRev | ✅ | |
| E5 delete | collection | ✅ | |
| E6 写后即读 | 本地镜像 | ✅ | |

### F 同步

| # | 载体 | 结论 | 备注 |
|---|---|---|---|
| F1 三层缓存 | L1=读结果对象缓存（v0.1 简化为镜像即 L2，L1 预留） | ⚠️ | 诚实偏差：v0.1 L1 未单列（Map 直读已 <1ms 满足 NFR-1），接口留 hook |
| F2 economy | SyncPolicy 默认值 | ✅ | 假时钟测调用数 |
| F3 强制时机 | startup()/close() | ✅ | close 由 sdk 显式调用 + process 信号钩子（adapters-node） |
| F4 手动 sync | client.sync | ✅ | |
| F5 离线队列 | CommitQueue 持久化 + startup 重放 | ✅ | kill -9 测试：写返回后队列文件已在盘 |
| F6 OCC 冲突 | flush CAS + merge 重试 | ✅ | |
| F7 限流退避 | QuotaTracker + RateLimitError → fully-local | ⚠️ | v0.1 预算为本地计数（未解析响应头精确值），响应头解析列为 v0.2；行为等价 |
| F8 一致性选项 | FindOptions.consistency | ✅ | synced=flush 后读；fresh=强制 pull |

### G/H/I/J/K

| # | 载体 | 结论 | 备注 |
|---|---|---|---|
| G1/G2 事务 | tx/TransactionCtx + 单次强制 flush | ✅ | |
| H1 唯一索引 | IndexManager.checkUnique | ✅ | |
| H2 索引降级 | available() 探测→全表扫 | ✅ | |
| H3 索引随数据 commit | storage.exportFiles 含 _indexes | ✅ | |
| I1 URI+对象 | sdk | ✅ | |
| I2 泛型 | sdk 类型 | ✅ | as-cast 层，运行时由 schema 校验兜底 |
| I3 事件 | core EventBus | ✅ | |
| I4 运行时注入 | RuntimeAdapter | ✅ | core 零 node import（CI 用 grep 断言） |
| J1–J5 CLI | cli 手写 argv（v0.1 不引 commander） | ⚠️ | 轻量解析够用；v0.3 换 commander |
| K1/K2 配额 | QuotaTracker 本地计数 | ⚠️ | 同 F7：v0.1 计数预算，响应头精确解析 v0.2 |

## NFR 复核

| # | 结论 | 承载 |
|---|---|---|
| NFR-1/2 性能 | ✅ | 内存镜像 + bench 用例（vitest bench 标记） |
| NFR-3 远端预算 | ✅ | fake timers 断言 flush 次数 |
| NFR-4 不丢 | ✅ | 队列先落盘再返回；重启重放用例 |
| NFR-5 格式 | ✅ | 黄金仓库快照测试（M9 生成 fixtures） |
| NFR-6 安全 | ✅ | token 脱敏 util + 测试；credential 文件 0600 |
| NFR-7 平台 | ✅ | CI 矩阵 node18/20/24（本机 24 验证） |
| NFR-8 覆盖率 | ✅ | vitest coverage threshold 80 |
| NFR-9 可观测 | ✅ | sync.status + 慢查询事件（>200ms emit） |

## 复核结论

- **❌ 缺口：0 条**。全部 FR 有承载。
- **⚠️ 6 条实现注意**（B3/F1/F7/J/K1 精确度类）：均为「v0.1 简化实现 + 行为等价 + 归属后续版本」，已在 11-implementation-design §6 与本表登记，不阻塞进入 P3。
- **P0→P2 回溯**：无需求层缺陷发现，requirements.md 冻结。

**批准进入 P3 实现循环（M1→M9）。**
