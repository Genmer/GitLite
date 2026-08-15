# 11 · 实施设计（P1 产出：模块级设计与接口契约）

> 本篇是 v0.1 MVP 的**实现契约**：包结构、模块边界、关键接口签名、核心数据流。P2 复核以本篇 + [requirements.md](./requirements.md) 为准。设计原则：core 零依赖、零 node 内置 import，一切环境能力经 RuntimeAdapter 注入。

## 0. 工程结构与工具链

```
gitlite/
├── package.json              npm workspaces（环境无 pnpm，工具层偏差已记录）
├── tsconfig.base.json        strict / ES2022 / NodeNext / declaration
├── vitest.config.ts          单测 + 覆盖率门禁 ≥80%（core）
└── packages/
    ├── core/                 @gitlite/core      引擎内核（零依赖）
    ├── adapters-node/        @gitlite/adapters-node   fs/crypto/credential/fetch
    ├── sdk/                  @gitlite/sdk       connect/initDB/databases/URI 解析
    └── cli/                  @gitlite/cli       auth/db/data/sync/repl
```

## 1. core 模块图与依赖方向

```
client(GitLiteClient) ──► collection ──► query(filter/update)
      │            └──────► tx(TransactionCtx)
      ├──► sync(SyncEngine) ──► provider(GitProvider)
      ├──► storage(StorageEngine) ──► schema / model(ulid,rev)
      ├──► index(IndexManager)
      ├──► quota(QuotaTracker) ──► provider
      └──► auth(AuthStore)                （横切，sdk 层组装注入）
共享：errors / types / event(EventBus) / runtime(RuntimeAdapter)
```

依赖规则：`provider` 是唯一接触网络的模块；`storage` 不知 sync 存在；`collection` 不知 provider 存在。

## 2. 关键接口签名（实现以此为准）

### 2.1 runtime（环境能力注入）

```ts
export interface RuntimeAdapter {
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(dir: string): Promise<void>;
  };
  crypto: {
    randomBytes(n: number): Uint8Array;
    sha1hex(s: string): string;
  };
  credential: {
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<void>;
  };
  fetch: typeof fetch;
  now(): number;
}
```

### 2.2 provider（唯一网络出口）

```ts
export interface RepoRef { owner: string; repo: string }

export interface FileChange
  { kind: 'put'; path: string; content: string }
| { kind: 'delete'; path: string }

export interface GitProvider {
  readonly id: string;
  getRepo(ref: RepoRef): Promise<RepoInfo | null>;          // null=404
  createRepo(ref: RepoRef, input: CreateRepoInput): Promise<RepoInfo>;
  listBranches(ref: RepoRef): Promise<string[]>;
  createBranch(ref: RepoRef, name: string, from: string): Promise<void>;
  getHead(ref: RepoRef, branch: string): Promise<string | null>;   // commit oid
  getFiles(ref: RepoRef, branch: string): Promise<Map<string, string> | null>; // 全量快照
  commit(ref: RepoRef, branch: string, message: string,
         changes: FileChange[], expectedHeadOid?: string): Promise<{ oid: string }>;
  // expectedHeadOid 不符 → throw ConflictError（CAS 语义）
}
```

实现：`GitHubProvider`（REST + Git DB API：blob→tree(base_tree)→commit→PATCH ref）、`MemoryProvider`（测试/离线仿真，导出自 core 供全部测试使用）。

### 2.3 storage（数据模型映射 + 行级分层）

```ts
export interface StorageEngine {
  // 装载
  importFiles(files: Map<string, string>): void;   // pull/bootstrap 后调用，建立镜像+基线
  exportFiles(): Map<string, string>;              // 含系统文件（config/_schema/_indexes/_meta）
  diff(): FileChange[];                            // exportFiles() vs 基线
  // 读写（打在镜像上）
  read(c: string, id: string): Document | null;
  scan(c: string): Document[];
  upsert(c: string, doc: Document): void;
  delete(c: string, id: string): boolean;
  // schema
  putSchema(c: string, schema: object): void;      // 同时校验存量
  validate(c: string, doc: Document): void;        // throw ValidationError
  // 行级分层（对上层透明）
  tierOf(c: string): 'inline' | 'doc-per-file' | 'sharded';
}
```

序列化规则（冻结清单落地）：`inline` → `/<c>.jsonl`；`doc-per-file` → `/<c>/<id>.json`；`sharded` → `/<c>/shard-NNNN.jsonl`（≤min(1000 行,512KB)，ULID 前缀序分片）。分级按行数（<50 / <5000 / ≥5000），迟滞系数 1.2，级别变更写 `_migrations/` 记录。

### 2.4 query（filter 求值 / update 应用）

```ts
export function matches(doc: Document, filter: Filter): boolean;
// v0.1 操作符：$eq $ne $gt $gte $lt $lte $in $nin $exists $regex $and $or $not + 点路径
// 数组字段语义：等值/$in = 包含匹配（Mongo 语义）

export function applyUpdate(doc: Document, update: Update): Document;
// v0.1 操作符：$set $unset $inc $push $pull $addToSet
```

### 2.5 sync（队列 + 引擎）

```ts
export interface SyncPolicy {
  timeWindowMs: number;      // economy=600_000
  batchSize: number;         // economy=100
  maxRetries: number;        // 3
  maxRemoteCallsPerHour: number; // K2 预算
}

export interface SyncEngine {
  startup(): Promise<void>;      // P0 强制：pull + 重放遗留队列 + flush
  schedule(): void;              // 写后调度（窗口/批量触发）
  flush(): Promise<void>;        // diff→commit(CAS)→失败 pull+merge+重试≤3
  pull(): Promise<void>;         // head 变更→getFiles→合并(本地 dirty 优先,字段级三路)→事件
  close(): Promise<void>;        // P0 强制：flush
  status(): SyncStatus;          // pending/queue/lastSyncAt/mode
}
```

离线队列（NFR-4）：CommitQueue 持久化为 JSON（op 序列：insert/update 携带完整 doc、delete 携带 id，按 `_id` 合并），路径 `~/.gitlite/queues/<hash>.json`；进程重启后 `startup()` 重放。

冲突合并（v0.1 简化诚实版）：pull 时对远端变更 doc——本地未 dirty 直接接受；本地 dirty 则按字段三路合并（base=基线快照），无法合并字段进 `_conflicts` 并发事件。

### 2.6 index / tx / quota

```ts
export interface IndexManager {
  rebuild(c: string, docs: Document[]): void;      // 生成 entries
  onWrite(c: string, before: Document|null, after: Document|null): void;
  checkUnique(c: string, doc: Document): void;     // throw UniqueConstraintError
  exportFiles(): Map<string, string>;              // _indexes/<c>.<name>.idx.json
  importFiles(files: Map<string, string>): void;
  available(c: string): boolean;                   // H2 降级探测
}

// tx：txBuffer 覆盖层；commit=校验+批量应用+单次强制 flush（G1 单 commit）
export interface TransactionCtx {
  collection<T>(name: string): Collection<T>;      // 读写走 buffer
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface QuotaTracker {
  track(): void;                    // provider 调用包装计数
  canSpend(n: number): boolean;     // flush 前预算检查（K2）
  status(): QuotaStatus;
}
```

### 2.7 client / collection（对 sdk 暴露）

```ts
export interface GitLiteClient {
  collection<T = any>(name: string): Collection<T>;
  transaction<T>(fn: (tx: TransactionCtx) => Promise<T>): Promise<T>;
  sync: { push(); pull(); flush(); status() };
  putSchema(name: string, schema: object): Promise<void>;
  close(): Promise<void>;
  on(event: string, fn: (e: any) => void): () => void;   // I3 事件
}

export interface Collection<T> {
  insertOne(doc: OptionalId<T>): Promise<string>;
  insertMany(docs: OptionalId<T>[]): Promise<string[]>;
  findOne(f?: Filter, o?: FindOptions): Promise<T | null>;
  findById(id: string): Promise<T | null>;
  find(f?: Filter, o?: FindOptions): Promise<Page<T>>;
  count(f?: Filter): Promise<number>;
  exists(f?: Filter): Promise<boolean>;
  updateOne(f: Filter, u: Update, o?: UpdateOptions): Promise<UpdateResult>;
  updateMany(f: Filter, u: Update): Promise<UpdateResult>;
  replaceOne(f: Filter, doc: T, o?: UpdateOptions): Promise<UpdateResult>;
  deleteOne(f: Filter): Promise<DeleteResult>;
  deleteMany(f: Filter): Promise<DeleteResult>;
}
```

## 3. 核心数据流

### 3.1 connect（A1–A5）

```
runtime 解析 → provider.getRepo
  └ null + createIfMissing → createRepo(private,autoInit)
分支探测 getHead → null + createIfMissing → createBranch(base=main)
getFiles → 全空? bootstrap(写系统文件,含 formatVersion 0.1.0) : importFiles
  ├ 有文件且无 gitlite.config.jsonc → 状态 foreign（A4：未确认即只读）
  └ formatVersion.major > client → 拒绝打开（D6）
startup()：重放本地遗留队列 → flush → ready
```

### 3.2 写路径（E/F）

```
collection.insertOne
  → schema.validate + index.checkUnique
  → ulid 生成 _id / rev 计算 / timestamps
  → storage.upsert（镜像）+ index.onWrite
  → queue.enqueue(op) + 持久化队列（NFR-4：返回前已落盘）
  → sync.schedule()：窗口/批量条件满足 → flush
flush：quota.canSpend → storage.diff() → provider.commit(CAS)
  └ ConflictError → pull+merge → 重试≤3 → 仍败：保留队列+事件（F6）
```

### 3.3 pull 合并（F6/F8）

```
provider.getHead ≠ head.remoteHeadOid → getFiles
对每个变更 doc：本地镜像同 _id 未 dirty → 覆盖；dirty → 字段级三路合并
→ index.rebuild(受影响 collection) → emit remoteChange → 更新基线
```

### 3.4 事务（G1/G2）

```
transaction(fn)：txBuffer = Overlay(storage)
fn 内读写经 buffer（read-your-writes）
成功 → 逐 op 校验(unique/schema) → storage 批量应用 → 立即 flush（单 commit）
抛错 → 弃 buffer，镜像与队列零残留
```

## 4. 错误模型（落地 errors.ts）

`GitLiteError{code}` 基类；`ValidationError` `UniqueConstraintError` `NotFoundError` `ConflictError`(expected/actual) `QuotaExceededError` `RateLimitError`(retryAfterMs) `AuthError` `NetworkError` `FormatVersionError` `ForeignRepoError`。provider 层负责把 HTTP 401/403/404/422/5xx 映射进该体系，上层永不接触裸 HTTP（B5）。

## 5. 测试策略（NFR-8）

- 单测：ulid/rev/schema/filter/update/storage 分层/索引/队列/配额（vitest，core 内）
- 集成：MemoryProvider 跑 connect→bootstrap→CRUD→flush→pull 合并→冲突→事务→重启重放 全链路
- E2E（可选标记 `GITLITE_E2E_TOKEN` 存在时跑）：GitHubProvider 对真实私有仓库
- 覆盖率：core 行覆盖 ≥80%（vitest --coverage 门禁）

## 6. 实现偏差记录

| 偏差 | 原设计 | v0.1 实际 | 理由 |
|---|---|---|---|
| 包管理 | pnpm | npm workspaces | 环境无 pnpm；工作区语义等价，后续可平移 |
| 冲突合并 | 完整字段三路+向量时钟 | 字段三路（基线=快照） | v0.1 无多客户端时钟，快照即 base |
| schema 校验 | JSON Schema 全集 | 2020-12 子集（§2.4 列），未列关键字报「不支持」 | 需求 D1 即子集；诚实报错优于静默忽略 |
