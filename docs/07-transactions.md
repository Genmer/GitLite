# 07 · 事务与一致性模型

> 把 Git 的 commit / branch / ref 语义映射为数据库事务语义。给开发者提供可信的 ACID-like 契约，同时诚实声明边界——Git 不是真正的分布式事务存储，GitLite 给的是「足够好的」一致性。

## 0. 设计目标

1. **原子性**：一组写操作要么全成、要么全弃，用单次 commit 实现。
2. **隔离性**：事务内的改动在 commit 前对外不可见（本地隔离）。
3. **一致性**：schema 与约束在事务边界校验；冲突可检测可解决。
4. **持久性**：commit + push 成功后远端可恢复。
5. **诚实**：明确告诉用户哪些场景 GitLite 保证不了（跨库事务、强一致防超卖）。

## 一、三级一致性契约

GitLite 提供三个一致性级别，由调用方按需选择：

| 级别 | 别名 | 保证 | 性能 | 适用 |
|---|---|---|---|---|
| **L1 Local-Optimistic** | `'cache'` | 本地 Mirror 即时一致；远端最终一致 | 最快 | 单端读写、UI 反馈、原型 |
| **L2 Synced-Read** | `'synced'` | 读自己写必见（flush 后读）；不保证看到他人最新写 | 中等 | 表单提交后立即重读 |
| **L3 Strong-ish** | `'fresh'` | 读前强制 pull；写用 CAS（`expectedHeadOid`）保证串行化 | 最慢（多一次 RTT） | 跨端协作、关键写 |

### API

```ts
// 全局默认
const db = await GitLite.connect({
  defaultConsistency: 'cache' | 'synced' | 'fresh'
});

// 单次查询覆盖
await users.findOne(filter, { consistency: 'fresh' });

// 事务内指定
await db.transaction(async (tx) => { /*...*/ }, { consistency: 'fresh' });
```

**没有「跨事务的强一致快照隔离」**——这是 GitLite 的明确边界。需要强一致快照隔离的场景请用真正的数据库。

## 二、短事务（默认）

适合单次业务操作的原子提交：转账、订单创建、多文档更新。

```ts
await db.transaction(async (tx) => {
  const alice = await tx.users.findOne({ _id: aliceId });
  if (alice.balance < 100) throw new Error('insufficient');

  await tx.users.updateOne({ _id: aliceId }, { $inc: { balance: -100 } });
  await tx.users.updateOne({ _id: bobId },   { $inc: { balance: 100 } });
  await tx.transactions.insertOne({
    from: aliceId, to: bobId, amount: 100, at: new Date()
  });
}, { consistency: 'fresh' });
// → 全部成功：打包成单次 commit；任一失败：本地回滚，不 push
```

### 实现机制

1. 创建 `TransactionContext`，承载暂存改动 `txBuffer: Map<collection, Map<id, {op, doc}>>`。
2. 事务内所有读写都走 `txBuffer`（read-your-writes within tx）。
3. commit 时：
   - 校验全部改动满足 schema 与约束。
   - 检查 OCC：每个改动的 doc 比对 `expectedRev`。
   - 生成单次 commit，包含所有改动文件。
   - push 到远端。
4. 失败回滚：
   - schema/约束失败 → 抛 `ValidationError`，`txBuffer` 弃用。
   - OCC 冲突 → 按 `onConflict` 策略处理。
   - push non-fast-forward → pull + rebase + 重试。

### API 签名

```ts
transaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  opts?: { consistency?: Consistency; onConflict?: ConflictStrategy; maxRetries?: number; }
): Promise<T>;

interface Transaction extends CollectionAccessor {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  // 自动 commit/rollback 由 transaction() 包装器处理
}
```

## 三、长事务（基于分支）

适合需要长时间持有改动的场景：草稿编辑、批量导入、跨会话工作流。

### 机制

```
1. begin → 创建临时分支 gitlite/tx/<txId>（base = 当前 HEAD）
2. 事务内所有写都 commit 到该分支（可多次 commit，不污染主分支）
3. commit → fast-forward merge 到主分支（或 PR 流程）
4. rollback → 删除分支
```

```ts
const tx = await db.beginTransaction({
  mode: 'branch',
  name: 'import-users-batch',
  ttl: '24h'                          // 分支保留时间，过期自动清理
});

try {
  for (const user of hugeList) {
    await tx.users.insertOne(user);
    if (++count % 100 === 0) await tx.checkpoint();   // 中途提交到分支
  }
  await tx.commit();                  // merge 到主分支
} catch (e) {
  await tx.rollback();                // 删分支
}
```

### 长事务的代价

- 每次 `checkpoint()` 都是一次远端 commit，消耗配额。
- merge 时主分支可能已前进，需 rebase 或合并 commit。
- 不适合高频小事务。

### API 签名

```ts
beginTransaction(opts: {
  mode: 'branch';
  name: string;
  ttl?: string;
  autoCleanup?: boolean;
}): Promise<LongTransaction>;

interface LongTransaction extends Transaction {
  checkpoint(): Promise<{ commitSha: string }>;
  getBranchName(): string;
  createPullRequest?(title: string, body?: string): Promise<PR>;   // 集成 GitHub/Gitee PR
}
```

## 四、乐观并发控制（OCC）

GitLite 默认 OCC，不持锁，提交时检测冲突。

### document 级 OCC（_rev）

```ts
// 拿到 doc 时记录 _rev
const alice = await users.findById(id);
// alice._rev = "a1b2c3"

// 更新时携带 expectedRev
await users.updateOne(
  { _id: id },
  { $set: { balance: alice.balance - 100 } },
  { expectedRev: alice._rev }
);
// 远端 _rev 与 expectedRev 不一致 → ConflictError
```

### commit 级 CAS（expectedHeadOid）

```ts
await db.transaction(async (tx) => { /* ... */ }, {
  consistency: 'fresh',
  expectedHeadOid: currentHeadSha,    // 提交时强制 HEAD 一致
  onConflict: 'rebase'
});
```

- 提交时把 `expectedHeadOid` 作为 parent commit sha 提交给 Git DB API。
- Git 的 ref update 本质就是 CAS：`PATCH /refs/heads/<branch>` 携带 `sha` 字段即「期望当前 sha 是 X，否则失败」。
- 失败（422 / non-fast-forward）触发重试。

### 重试策略

```ts
interface RetryPolicy {
  maxRetries: number;          // 默认 3
  backoff: 'fixed' | 'exponential';
  initialDelay: number;        // ms
  onConflict: ConflictStrategy;
}
```

```
attempt 1: 失败 → pull → rebase → 重试
attempt 2: 失败 → backoff 100ms → 重试
attempt 3: 失败 → backoff 400ms → 重试
attempt 4: 失败 → 抛 ConflictError，保留 txBuffer 供人工处理
```

## 五、隔离级别

GitLite 实现的是 **Read Committed + Optimistic**（近似）：

| 隔离现象 | GitLite 行为 |
|---|---|
| 脏读 | 不会：未 commit 的事务改动只在 txBuffer，他人看不到 |
| 不可重复读 | 可能：同一事务内两次读同一 doc，期间他人 commit 了，第二次读可能不同（fresh 模式） |
| 幻读 | 可能：range 查询期间他人插入新文档 |
| 写丢失 | 默认防：OCC + _rev 检测；冲突抛错或按策略合并 |

**不提供 Serializable**：跨多个 doc 的并发写无法串行化到 Git 单 ref 上而不退化。

## 六、约束与校验

### 事务边界校验

```ts
await db.transaction(async (tx) => {
  // 这些校验在 commit 时统一执行
  await tx.users.insertOne({ email: 'a@x.com', ... });
  await tx.users.insertOne({ email: 'a@x.com', ... });   // 同事务内唯一冲突
}, { consistency: 'fresh' });
// → commit 时抛 UniqueConstraintError，整个事务回滚
```

约束类型：

| 约束 | 校验时机 |
|---|---|
| schema 字段类型 | 写入即校验（fail fast） |
| `required` | commit 时校验（允许事务内分步填字段） |
| `unique` | commit 时统一查索引校验 |
| `immutable` | 更新时校验 |
| 外键引用完整性（声明 `onDelete`） | commit 时校验 |

### 外键级联

```jsonc
// posts.schema.jsonc
{ "relations": { "author": { "kind": "many-to-one", "to": "users._id", "localField": "authorId",
                             "onDelete": "cascade" } } }
```

- `cascade`：删用户时同步删其所有 posts。
- `restrict`：用户有 posts 时禁止删（抛 `ForeignKeyViolation`）。
- `setNull`：删用户时把 posts.authorId 置 null。

级联在事务内执行，避免半完成状态。

## 七、回滚与补偿

### 本地回滚（短事务）

- `txBuffer` 弃用即可，无副作用。
- 已写入 L3 的待提交数据从 CommitQueue 移除。

### 分支回滚（长事务）

- 删除临时分支 `gitlite/tx/<txId>`。
- 已 checkpoint 的 commit 在分支上消失；主分支未受影响。

### 已 push 但后续失败

- 极端情况：commit+push 成功，但后续操作失败需要回滚整批。
- 策略：生成反向 commit（补丁取反），而非 `git revert`（语义更清晰）。
- 标记为「补偿事务」，记入 `_meta/compensations.json`。

## 八、跨端并发模型

### 向量时钟（可选高级）

```
_meta/vector-clock.json
{
  "clientId": "client-abc",
  "clock": { "client-abc": 42, "client-def": 17 }
}
```

- 每次 pull 时合并 clock；写 commit 时带上 clock 作为 metadata。
- 用于检测因果并发写，辅助字段级合并决策。

### Last-Write-Wins（默认）

- 用 `updatedAt` 时间戳作为冲突解决依据。
- 客户端时钟偏差 < 5 秒可接受；偏差大时建议切向量时钟或 `manual` 策略。

## 九、与原生 Git 语义对照

| 数据库概念 | Git 概念 | GitLite 实现 |
|---|---|---|
| BEGIN | （无对应） | 创建 txBuffer / 临时分支 |
| INSERT/UPDATE/DELETE | add/rm + commit | 写文件 + commit |
| COMMIT | ref update (fast-forward) | PATCH refs/heads/<branch> |
| ROLLBACK | branch delete / reset | 弃 txBuffer / 删分支 |
| SAVEPOINT | 中间 commit（分支上） | `tx.checkpoint()` |
| Isolation Level | （无对应） | consistency 选项模拟 |
| Lock | （Git 无锁） | OCC + CAS 代替 |
| MVCC | Git 历史 + ref | branch = snapshot（弱） |

## 十、边界与诚实声明

**GitLite 不能保证：**

1. **跨仓库事务**：两个 repo 之间无原子提交。需要分布式事务的应用请用真数据库。
2. **强一致防超卖**：并发扣减库存场景，OCC 重试可能多次失败；可用 `consistency: 'fresh' + expectedHeadOid` 串行化，但吞吐受限。
3. **Serializable 隔离**：跨 doc 的并发写不保证可串行化。
4. **实时一致性**：默认最终一致，他人写的最新数据可能要等 pull 才看到。
5. **跨客户端锁**：GitLite 不提供分布式锁；需要锁请配合外部协调（如基于 branch 创建竞态）。

**GitLite 适合的事务场景：**

- 单端业务原子操作（转账、订单创建、表单提交）。
- 跨文档批量更新（导入、迁移）。
- 草稿编辑、多步工作流（长事务 + 分支）。
- 读多写少的协作（最终一致即可）。

## 十一、API 速查

```ts
// 短事务
await db.transaction(async (tx) => { ... }, { consistency: 'fresh', onConflict: 'field_merge' });

// 长事务
const tx = await db.beginTransaction({ mode: 'branch', name: 'import', ttl: '24h' });
await tx.checkpoint();
await tx.commit();  // 或 tx.rollback();

// 自动重试的单次写
await users.updateOne(filter, update, { expectedRev, retry: { maxRetries: 3 } });

// CAS 提交
await db.commitWithCas(expectedHeadOid, ops);
```

这一层让 Git 的 commit/branch/ref 三件套变成可信的事务原语——不是真正的 ACID，但对绝大多数应用级操作「足够好」，并诚实声明边界。
