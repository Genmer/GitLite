# 06 · 同步与缓存引擎

> 「把远程仓库当成本地内存」的核心实现层。读路径三层缓存命中即返回；写路径乐观入 Mirror + 提交队列批量同步；离线时排队，恢复后重放。

## 0. 设计目标

1. **读写延迟接近本地内存**：读 95%+ 命中本地缓存；写不阻塞于网络。
2. **最终一致**：本地乐观写 + 异步同步，远端最终收敛。
3. **冲突可控**：检测冲突并提供可配置解决策略。
4. **离线可用**：断网时正常读写，恢复后自动同步。
5. **配额友好**：合并写入、批量提交、避免无效 push。

## 一、三层缓存结构

```
┌─────────────────────────────────────────────────┐
│  L1  Hot Cache       (进程内 Map，单次会话内)     │
│      键: <collection>:<id>  值: document 对象     │
│      容量: 默认 1000 条 (LRU)                     │
├─────────────────────────────────────────────────┤
│  L2  Working Set     (In-Memory Mirror)          │
│      键: collection -> Map<id, doc>               │
│      默认全量加载小 collection；大集合按需加载      │
│      脏标记: dirty: Set<id>                       │
├─────────────────────────────────────────────────┤
│  L3  Local Persist   (本地磁盘 / IndexedDB)       │
│      路径: ~/.gitlite/cache/<provider>/<owner>/<repo>/
│      结构: 镜像远端文件树 + _meta/head.json       │
│      用途: 跨会话持久、断网恢复                    │
└─────────────────────────────────────────────────┘
                       ↓
              ┌────────────────┐
              │   Remote Git   │  (source of truth)
              └────────────────┘
```

| 层 | 命中延迟 | 持久性 | 默认容量 |
|---|---|---|---|
| L1 Hot Cache | < 0.1 ms | 进程内 | LRU 1000 |
| L2 Working Set | < 1 ms | 进程内（启动加载） | 全量或 lazy |
| L3 Local Persist | 1–10 ms | 跨会话 | 磁盘（无限制） |
| Remote Git | 100–1000 ms | 永久 | 平台配额 |

## 二、读路径

```
read(collection, id)
  ├─ L1 命中？ → 返回                          ★ 最快路径
  ├─ L2 命中？ → 提升 L1，返回
  ├─ L3 命中？ → 提升 L2+L1，返回
  └─ 远端拉取  → GET /repos/.../contents/<path>
                → 写 L3+L2+L1 → 返回
```

### 一致性选项

```ts
interface ReadConsistency {
  consistency?: 'cache' | 'synced' | 'fresh';
}
```

| 模式 | 行为 | 适用 |
|---|---|---|
| `cache`（默认） | 直接读缓存，不等同步 | 大多数读 |
| `synced` | 等待本地待提交队列 flush 完再读 | 读自己刚写的数据 |
| `fresh` | 强制拉远端 HEAD 比对，必要时 pull | 跨端协作强一致读 |

### 全 collection 扫描

- `find()` / `aggregate()` 需要 collection 全量时，从 L2 取；未加载则触发「预热」：批量 list 远端 tree → 一次性拉所有 blob → 填 L3+L2。
- 大 collection（>10k docs）走 lazy + 索引：优先用索引定位候选集，避免全量加载。

### 预热策略

```ts
db.warmup({ collections: ['users'], mode: 'full' | 'lazy' | 'index-only' });
```

- `full`：拉取整个 collection 到 L2。
- `lazy`：只建索引清单，文档按需加载。
- `index-only`：只加载 `_indexes/*.idx.json`，查询走索引扫候选再单文档拉取。

## 三、写路径（乐观写 + 提交队列）

```
write(collection, id, op)
  ├─ 1. 校验 schema
  ├─ 2. 应用到 L2 Mirror（标记 dirty）
  ├─ 3. 写入 L3 Local Persist（持久化待提交）
  ├─ 4. 通知 L1 失效或更新
  ├─ 5. 推入 CommitQueue
  └─ 6. 返回（不等远端）
```

### CommitQueue

```ts
interface CommitQueueEntry {
  ops: WriteOp[];                 // 同一批的多个写操作
  collection: string;
  createdAt: number;
  attempt: number;
}

type WriteOp =
  | { kind: 'insert'; doc: Document }
  | { kind: 'update'; id: string; patch: UpdateOp; expectedRev?: string }
  | { kind: 'delete'; id: string };
```

### 批量提交触发条件

```ts
interface SyncPolicy {
  batchSize?: number;     // 默认 10：累计 10 个写操作触发提交
  timeWindow?: number;    // 默认 3000ms：3 秒窗口触发
  onExit?: boolean;       // 进程退出前 flush
  onReadFresh?: boolean;  // fresh 读前 flush
}
```

满足任一条件即触发 `flush()`：把队列中的 ops 打包成一次 commit。

### 单次 commit 流程（GitHub Git DB API）

```
1. 比对本地 dirty docs 与远端 tree（按 path）
2. 对每个变更文件：
   - 新增/修改：POST /git/blobs → 拿 blob sha
   - 删除：标记 tree entry 移除
3. POST /git/trees (base_tree=远端 HEAD tree) → 新 tree sha
4. POST /git/commits (parents=[远端 HEAD], tree=新 tree) → 新 commit sha
5. PATCH /git/refs/heads/<branch> (sha=新 commit sha)
   → 冲突（422 / non-fast-forward）：pull + rebase 后重试
6. 成功：清 dirty、更新 _meta/head.json、触发事件
```

### 单次 commit 流程（Gitee 无 Git DB API）

降级为多次 Contents API 调用：

```
for each (path, content):
  GET  /repos/.../contents/<path>     → 拿 sha（修改/删除需要）
  PUT  /repos/.../contents/<path>     → create/update
  DELETE /repos/.../contents/<path>   → delete
```

- 多文件非原子，部分失败需补偿（回滚已提交的文件或记录残留待修）。
- 推荐用户切到 isomorphic-git 内核（见 01）以获得原子批量提交。

### 单次 commit 流程（isomorphic-git 内核）

```
1. fs 操作：写入/删除本地工作树文件
2. git add / git rm
3. git commit (parent = 远端 HEAD)
4. git push origin <branch>
   → non-fast-forward：fetch + rebase 后重试
```

最干净、最原子；适合中小仓库与离线场景。

## 四、同步模式与频率策略

> 设计原则：**同步频率尽量低**。Git API 配额是稀缺资源，默认策略是「激进本地化」——读写都在本地副本，远端同步低频批量。用户可按需调高。

### 频率三档预设（分钟级）

| 档位 | 写 flush 窗口 | 写批量阈值 | 读 pull 轮询 | 每小时远端调用（估） | 适用 |
|---|---|---|---|---|---|
| **economy（默认）** | **10 分钟** | 100 条 | **不轮询**（仅启动 + 手动 + 冲突） | < 8 | 绝大多数 app；个人工具、低频写 |
| balanced | 5 分钟 | 50 条 | 5 分钟 | ~30 | 多端协作 |
| realtime | 1 分钟 | 20 条 | 1 分钟 | ~130 | 高频协作（仍远低于配额） |

```ts
const db = await GitLite.connect({
  sync: { mode: 'auto', policy: 'economy' }        // 预设档位
});

// 或细粒度覆盖（分钟级自定义）
const db = await GitLite.connect({
  sync: {
    mode: 'auto',
    policy: {
      timeWindowMinutes: 1 | 5 | 10 | 30,  // flush 窗口，分钟
      batchSize: 100,                       // 或累计 N 条写操作即 flush
      pullIntervalMinutes: 'off' | 1 | 5 | 10,  // 轮询间隔（economy 默认 off）
    }
  }
});
```

**强制同步时机（不可关闭）**：

| 时机 | 行为 |
|---|---|
| **启动（connect）** | 立即 pull 一次 + flush 上次会话遗留的待提交队列 |
| **退出（进程退出 / app 切后台）** | 立即 flush 全部待提交队列（`flushOnExit` 强制开） |
| push 冲突时 | 被动 pull（rebase 需要，非轮询） |

启动/退出两次强制同步保证了正确性兜底：窗口拉长只影响「其他端看到你改动的延迟」，不影响你自己数据的持久性——**每次写都即时落盘 L3**（本地待提交队列），延迟的只是推远端。

关键默认值 rationale：

- **写 10min/100 条**：economy 档每小时最多 6 次 flush（每次 4 个 Git DB API 调用 ≈ 24 调用/h），远离 GitHub 内容创建次级限流 500/h 数个数量级；100 条批量摊薄单次 commit 的固定开销。
- **读不轮询**：pull 只发生在「启动一次」+「用户显式 `refresh()`」+「push 冲突被动拉」。多端协作场景才需要开轮询。
- **数据安全与窗口无关**：写操作即时持久化到 L3 `pending.json`；进程崩溃/断电后下次启动的强制 flush 会补推。窗口拉长的唯一代价是「其他端可见性延迟」。

### 1. 自动同步（默认）

```ts
const db = await GitLite.connect({
  sync: { mode: 'auto', policy: 'economy' }
});
```

写后入队、按策略低频 flush；不主动轮询（除非 pullInterval 开启）。

### 2. 手动同步

```ts
const db = await GitLite.connect({
  sync: { mode: 'manual' }
});

await db.users.insertOne({ ... });   // 仅写本地
await db.users.insertOne({ ... });   // 仅写本地

await db.sync.push();                // 显式推送到远端
await db.sync.pull();                // 显式拉取远端
await db.sync.sync();                // 双向同步（pull+push）
```

适合：批量导入、调试、需要精确控制提交时机。

### 3. 实时同步

```ts
sync: { mode: 'realtime', watch: true, policy: 'realtime' }
```

- 后台 worker 每 1 分钟拉取远端 HEAD（轻量：只比 `refs/heads/<branch>` sha）。
- sha 变化则触发 pull。
- 也可订阅 webhook（需 broker / 公网入口，可选高级特性）。
- 注意：realtime 档也是分钟级（1 分钟）——**GitLite 不提供秒级同步**，这是基于 Git API 配额的刻意设计；需要秒级实时请配合事件总线（webhook → broker → WebSocket）而非轮询。

## 四a、多仓库绑定与故障转移（Failover）

用户可绑定多个远端（如 GitHub 为主 + Gitee 为镜像）。**两个平台的配额池相互独立**——一边被限流，另一边还能用。

### 绑定角色

| 角色 | 行为 |
|---|---|
| **primary** | 唯一写入口：所有 push 目标 |
| **mirror** | 只读备胎：不接受直写，由引擎在 primary 成功 push 后**低频异步镜像**（默认延迟 10 分钟，可配） |

> mirror 为什么只读：避免「双向同步」的复杂性（双写冲突、回环同步）。failover 时 mirror 升级为 primary，原 primary 降级为待修复 mirror。

### Failover 链路

```
正常态：
  本地副本 ⇄ primary(GitHub)  ──低频镜像──>  mirror(Gitee)

限流①  primary 返回 403 + X-RateLimit-Remaining: 0（或 secondary limit）
  → QuotaManager 标记 primary 进入 cooldown（直到 X-RateLimit-Reset 时间）
  → 探测 mirror 可用（1 次轻量调用）→ 可用则提升为 primary
  → 本地队列继续 flush 到新 primary，app 无感
  → 事件 db.on('binding:failover', e => ...)

限流②  所有绑定均 cooldown / 不可用
  → 进入完全本地模式（fully-local）：
     读写全部走本地副本，CommitQueue 持久化等待
  → 恢复探测用指数退避：1min → 5min → 15min（封顶），探测本身只花 1 个 API 调用
  → 事件 db.on('mode', e => e.mode === 'fully-local')

恢复：
  任一绑定恢复 → flush 积压队列 → 重新镜像 → 回到正常态
```

### 代价（诚实声明）

- **双倍存储与配额**：镜像把数据写两份，API 消耗约 ×1.5（镜像批量、低频）。
- **镜像延迟**：mirror 默认落后 primary 最多 10 分钟——failover 切换时可能丢最新 N 分钟的远端状态？**不会丢本地数据**：本地队列是 source，切到 mirror 后会补 push；丢的只是「其他客户端写到旧 primary 的变更」，待旧 primary 恢复后再 reconcile。
- **复杂度**：绑定状态机（primary/mirror/cooldown）需要 UI 暴露给用户看懂。

### API

```ts
// 查看绑定
const bindings = await GitLite.bindings.list();
// → [
//   { provider:'github', owner:'me', repo:'gitlite-repo', role:'primary',  status:'ok' },
//   { provider:'gitee',  owner:'me', repo:'gitlite-repo', role:'mirror',   status:'ok', lagMs: 320_000 }
// ]

// 追加镜像（弹登录若未授权该平台）
await GitLite.bindings.add({ provider: 'gitee', role: 'mirror' });
await GitLite.bindings.setPrimary('gitee');
await GitLite.bindings.remove('gitee');

// 绑定状态实时查询
db.bindings.status;   // { mode:'normal'|'failover'|'fully-local', activeProvider, cooldowns:[...] }
```

绑定关系持久化在本地 `~/.gitlite/bindings.json`（不含 token，token 在凭据库），跨会话生效。

## 五、Pull 流程与变更合并

```
1. GET /repos/.../git/refs/heads/<branch> → 拿远端 HEAD sha
2. 若 == 本地 _meta/head.remoteHeadOid → 无变更，返回
3. GET /repos/.../compare/<localHead>...<remoteHead>
   → 拿到 files: [{ filename, status, sha, patch? }]
4. 对每个变更文件：
   - 远端新增/修改：拉取 blob，写入 L3+L2，覆盖本地（除非本地也 dirty）
   - 远端删除：从 L3+L2 移除
5. 触发 'remoteChange' 事件，驱动 UI 刷新
6. 更新 _meta/head.json
```

### 本地 dirty 与远端变更冲突

```
本地有 dirty doc X，远端也修改了 doc X：
  → 触发 ConflictResolver.resolve(localDoc, remoteDoc, baseDoc?)
```

## 六、冲突检测与解决策略

### 冲突类型

| 类型 | 检测 | 默认策略 |
|---|---|---|
| **Write-Write（同文档）** | 本地 dirty doc 与远端 pull 修改同 id | 字段级合并（见下） |
| **Delete-Update（同文档）** | 一边删一边改 | 默认保留更新（`update_wins`） |
| **Unique 违反** | 远端引入与本地 dirty 冲突的唯一值 | 报冲突，标记需用户介入 |
| **Schema 版本不一致** | 远端 schema 版本 > 本地 | 先拉 schema + 迁移，再处理数据 |
| **Push non-fast-forward** | 远端 HEAD 领先 | pull + rebase 重试 |

### 解决策略（可配置）

```ts
type ConflictStrategy =
  | 'last_write_wins'        // 时间戳晚的赢
  | 'first_write_wins'       // 时间戳早的赢
  | 'local_wins'             // 本地优先
  | 'remote_wins'            // 远端优先
  | 'field_merge'            // 字段级合并（默认）
  | 'manual';                // 抛 ConflictError，由用户处理

interface ConflictResolver {
  resolve(local: Doc, remote: Doc, base?: Doc): Doc | 'manual';
}
```

### 字段级合并（默认）

```
base = 共同祖先版本
for each field f:
  if local.f == base.f:  result.f = remote.f   (本地未改，取远端)
  elif remote.f == base.f: result.f = local.f  (远端未改，取本地)
  else: result.f = manual (双方都改了且不同 → 冲突)
```

- 文本字段可接 `diff3` 三路合并。
- 数组字段用 union 或 set 合并（去重）。
- 冲突字段写入 `_conflicts: { field: [localVal, remoteVal] }`，触发事件等用户介入。

### Push 冲突重试

```
push 失败 (non-fast-forward):
  1. fetch 远端 HEAD
  2. 对本地 commit 范围内的每个 dirty doc：
     若远端同期也修改 → 应用 ConflictResolver
  3. 重新生成 commit (base = 新 HEAD)
  4. 重试 push（最多 3 次）
  5. 仍失败 → 抛 SyncError，保留本地待提交
```

## 七、离线支持

### 检测离线

- 网络状态 API（`navigator.onLine` / OS 网络事件）+ 主动探测（API 调用失败时）。
- 离线状态写入 `connection.online = false`，触发 `db.on('offline')` 事件。

### 离线行为

- 写：照常入 Mirror + L3 + CommitQueue，不触发 push。
- 读：完全本地，命中 L3 即返回。
- CommitQueue 持久化到 L3（`pending.json`），即使进程重启也不丢。

### 恢复在线

```
db.on('online', async () => {
  await db.sync.sync();   // 自动 pull + push 队列
});
```

- 先 pull 远端变更合并，再 push 本地待提交。
- 冲突按策略解决。
- 队列中堆积过多时（>1000），分批 push 避免单次 commit 过大。

## 八、缓存失效与版本管理

### document _rev

- 每次修改重算 `_rev`（内容 SHA-1 前 12 位）。
- L1/L2 缓存按 `_rev` 验证；远端 pull 拿到的 doc 比对 `_rev`，相同则跳过更新。

### collection 水位

```jsonc
// _meta/head.json
{
  "remoteHeadOid": "abc1234",
  "remoteHeadAt": "2026-08-15T12:00:00Z",
  "collectionWatermarks": {
    "users": { "maxUpdatedAt": "2026-08-15T11:00:00Z", "count": 42 },
    "posts": { "maxUpdatedAt": "2026-08-15T10:00:00Z", "count": 100 }
  }
}
```

- Pull 时先比 `remoteHeadOid`；变了再走 compare 拿增量。
- 增量 pull 用 `since` 参数（GitHub 支持 `?since=<timestamp>` 列 commit；Gitee 类似）缩小范围。

### LRU 与容量管理

- L1 LRU 上限可配（默认 1000）。
- L2 全量加载上限（默认 50k docs / 100MB），超过自动转 lazy。
- L3 按仓库隔离；提供 `db.cache.clear()` 与 `db.cache.evict(olderThan)`。

### 打包形态（WebView）下的存储持久化

GitLite 可打包进 Electron / Tauri / Capacitor 壳（dmg/exe/apk），此时 L3 落在 WebView 的 IndexedDB，有两个特性必须处理：

1. **配额**：WebView 的 IndexedDB 配额通常远小于桌面磁盘（部分 Android WebView 低至数十 MB～数百 MB，且可能被系统回收）。
2. **可清除性**：用户「清除应用数据」或 OS 存储压力下可能整体清空。

策略（L3 按形态自动选择）：

| 形态 | L3 实现 | 说明 |
|---|---|---|
| Node / Electron | 本地文件（`~/.gitlite/cache/...`） | 无配额问题，跨会话稳定 |
| Tauri | IndexedDB + 可选 Tauri fs 插件落盘 | 大缓存建议走插件 fs |
| Capacitor / RN（apk/ipa） | IndexedDB / AsyncStorage，**按需加载 + 上限配额** | 默认 `index-only` 预热，文档按需拉取，不缓存全量 |
| 纯浏览器 | IndexedDB | 同移动策略；可被用户清除 |

配套机制：

- **配额探测**：连接时用 `navigator.storage.estimate()` 探测配额，接近上限（>80%）自动 evict 冷数据（LRU by lastAccessAt）。
- **持久化申请**：调用 `navigator.storage.persist()` 请求持久存储，降低被系统清除的概率。
- **缓存即缓存**：L3 永远可丢——source of truth 是远端仓库。L3 清空后下次连接重新预热，数据不丢（这也是「远端当本地内存」设计的自然兜底）。
- **离线队列冗余**：`pending.json`（待提交队列）是唯一不可丢的本地状态，移动端额外镜像一份到 AsyncStorage/Preferences，双写防止单一存储被清导致写丢失。

## 九、同步引擎接口

```ts
interface SyncEngine {
  push(): Promise<PushResult>;
  pull(): Promise<PullResult>;
  sync(): Promise<SyncResult>;
  flush(): Promise<void>;            // 等待 CommitQueue 清空
  setStatusListener(fn: (s: SyncStatus) => void): void;

  getPendingCount(): number;
  getConflictLog(): ConflictRecord[];
  resolveConflict(conflictId: string, resolution: Doc | 'local' | 'remote'): Promise<void>;
}

interface SyncStatus {
  online: boolean;
  lastSyncAt: string;
  pendingPush: number;
  pendingPull: number;
  conflicts: number;
  remoteHeadOid: string;
}
```

## 十、性能与配额

### 优化策略

| 优化点 | 手段 |
|---|---|
| **批量提交** | 默认 batchSize=10，合并多个写为一个 commit |
| **去重写入** | 同 doc 短时间多次写，只 commit 最终值 |
| **索引同步** | 数据 commit 时一并更新索引文件，避免二次 IO |
| **tree 复用** | Git DB API 用 `base_tree` 复用未变部分 |
| **压缩** | L3 持久化用 gzip 压缩冷数据 |
| **预拉取** | 启动时后台预拉常用 collection |

### 配额预算

```ts
interface QuotaBudget {
  commitsPerHour: number;     // 默认保守 60（GitHub 5000/h，留余量）
  pushPerHour: number;        // 默认 60（GitHub 6/min 限）
  filesPerCommit: number;     // 默认 100
  bytesPerCommit: number;     // 默认 1MB
}
```

- SyncEngine 跟踪配额计数，接近上限时合并写入或推迟提交。
- 触发 `QuotaWarning` 事件，建议用户调大时间窗口或减少写频率。

## 十一、调试与可观测

```bash
$ gitlite sync status
Online: ✓
Remote HEAD: abc1234 (2026-08-15T12:00:00Z)
Local HEAD:  abc1234
Pending push: 3 ops (1 commit queued)
Conflicts: 0
Last sync: 2026-08-15T12:01:00Z

$ gitlite sync log
12:00:00  pull  +5 docs (users), -1 doc (posts)
12:00:05  push  3 ops → commit abc1240
12:01:00  pull  no changes

$ gitlite sync conflicts
#1  users/01H8X...  field: email  local: a@x  remote: a@y  [unresolved]
```

SDK 侧：

```ts
db.on('sync:push', (e) => console.log('pushed', e.commitSha, e.ops));
db.on('sync:pull', (e) => console.log('pulled', e.changedFiles));
db.on('sync:conflict', (e) => console.warn('conflict', e));
```

这一层让「远端当本地内存用」从口号变成可工程化的机制——读得快、写得轻、冲突可控、断网可活。
