# 05 · CRUD 与查询 API

> 给上层应用提供 MongoDB / Prisma / Firestore 风格的简洁 API。屏蔽底层 Git 文件操作、缓存同步、冲突重试。开发者写的是 `db.users.findOne({ email })`，不是 `git commit`。

## 0. API 设计原则

1. **链式 + 对象式并存**：`db.users.findOne({...})` 与 `db.users.find({...}).limit(10).toArray()` 都支持。
2. **filter 对象优先**：用 Mongo 风格的查询操作符，避免 SQL 注入面与字符串拼接。
3. **强类型**：schema 生成 TS 类型，`db.users` 推断出 `User` 类型。
4. **写后即读**：写入立即从本地 Mirror 返回（乐观），异步同步远端。
5. **关联展开**：`include` 一等公民，避免 N+1。

## 一、连接与 Collection 获取

```ts
import { GitLite } from '@gitlite/sdk';

const db = await GitLite.connect({
  provider: 'github',
  repo: { owner: 'alice', repo: 'my-app-db' },
  auth: { type: 'stored', profile: 'alice-gh' }
});

const users = db.collection<User>('users');
const posts = db.collection<Post>('posts');
```

`db.collection<T>(name)` 返回 `Collection<T>` 对象，类型 `T` 由 schema 生成或用户传入。

## 二、Create

### insertOne

```ts
const id = await users.insertOne({
  email: 'alice@example.com',
  name: 'Alice',
  age: 30,
  tags: ['staff']
});
// → 返回生成的 _id（默认 ULID）
// → 文档写入本地 Mirror，加入提交队列
```

签名：

```ts
insertOne(doc: OptionalId<T>): Promise<string>;
```

- 自动生成 `_id`（按 schema `idStrategy`）。
- 自动维护 `createdAt` / `updatedAt`（如 schema 声明 `timestamps: true`）。
- 校验 schema，不通过抛 `ValidationError`。
- 唯一约束冲突抛 `UniqueConstraintError`。

### insertMany

```ts
const ids = await users.insertMany([
  { email: 'a@x.com', name: 'A' },
  { email: 'b@x.com', name: 'B' }
]);
// → 多文档打包进同一 commit
```

签名：

```ts
insertMany(docs: OptionalId<T>[], opts?: { ordered?: boolean }): Promise<string[]>;
```

- `ordered: true`（默认）：遇错即停；`false`：尽量全插，返回成功 ID。
- 全部文档打包为单个 commit（受配额软上限约束，超限自动分批）。

## 三、Read

### findOne

```ts
const alice = await users.findOne({ email: 'alice@example.com' });
// → User | null
```

签名：

```ts
findOne(filter: Filter<T>, opts?: FindOptions): Promise<T | null>;
```

- 命中索引则走索引；否则全 collection 扫描（本地内存）。
- 默认不展开关联，`opts.include` 控制关联展开。

### find

```ts
// 链式
const results = await users.find({ age: { $gte: 18 } })
  .sort({ createdAt: -1 })
  .limit(20)
  .skip(40)
  .toArray();

// 一次性
const page = await users.find(
  { role: 'admin' },
  { sort: { name: 1 }, limit: 10, skip: 0, include: ['posts'] }
);
```

签名：

```ts
find(filter: Filter<T>, opts?: FindOptions): QueryCursor<T> | Promise<Page<T>>;

interface FindOptions {
  sort?: Partial<Record<keyof T, 1 | -1>>;
  limit?: number;
  skip?: number;
  projection?: Partial<Record<keyof T, 0 | 1>>;   // 字段筛选
  include?: Array<keyof T | string>;                // 关联展开
  consistency?: 'cache' | 'synced' | 'fresh';       // 见 07
}

interface Page<T> { items: T[]; total: number; hasMore: boolean; }
```

### findById

```ts
const user = await users.findById('01H8X9EJ5S2KQ3M4N5P6Q7R8S9');
```

等价于 `findOne({ _id })`，但走主键直查，最快路径。

### count / exists

```ts
const total = await users.count({ role: 'user' });
const exists = await users.exists({ email: 'alice@x.com' });
```

## 四、Filter 表达式

### 比较操作符

| 操作符 | 含义 | 示例 |
|---|---|---|
| `$eq` | 等于（默认） | `{ age: 30 }` ≡ `{ age: { $eq: 30 } }` |
| `$ne` | 不等于 | `{ age: { $ne: 30 } }` |
| `$gt` / `$gte` | 大于 / 大于等于 | `{ age: { $gte: 18 } }` |
| `$lt` / `$lte` | 小于 / 小于等于 | `{ age: { $lt: 60 } }` |
| `$in` | 在数组中 | `{ role: { $in: ['admin','user'] } }` |
| `$nin` | 不在数组中 | `{ role: { $nin: ['guest'] } }` |
| `$exists` | 字段存在/不存在 | `{ avatarUrl: { $exists: true } }` |
| `$regex` | 正则匹配 | `{ name: { $regex: '^Al', $options: 'i' } }` |
| `$type` | 类型判断 | `{ age: { $type: 'int' } }` |

### 逻辑操作符

```ts
{
  $and: [
    { age: { $gte: 18 } },
    { $or: [
        { role: 'admin' },
        { tags: 'staff' }
    ]},
    { age: { $ne: 99 } }
  ]
}
```

| 操作符 | 含义 |
|---|---|
| `$and` | 全部满足 |
| `$or` | 任一满足 |
| `$nor` | 全部不满足 |
| `$not` | 取反 |

### 数组操作符

| 操作符 | 含义 | 示例 |
|---|---|---|
| `$all` | 包含全部元素 | `{ tags: { $all: ['staff','early'] } }` |
| `$elemMatch` | 数组元素满足条件 | `{ scores: { $elemMatch: { $gte: 90, $lt: 100 } } }` |
| `$size` | 数组长度 | `{ tags: { $size: 2 } }` |

### 嵌套字段

```ts
{ 'address.city': 'Shanghai' }
{ 'address.zip': { $regex: '^200' } }
```

用点号路径访问嵌套对象与数组下标（`tags.0`）。

### Filter 类型生成

```ts
export type Filter<T> =
  | Partial<{ [K in keyof T]: T[K] | FieldOperator<T[K]> }>
  | LogicalFilter<T>;
```

由 schema 生成的 `User` 类型自动推导出 `Filter<User>`，TS 在写错字段名时报错。

## 五、Update

### updateOne / updateMany

```ts
await users.updateOne(
  { _id: '01H8X...' },
  { $set: { age: 31 }, $push: { tags: 'verified' } }
);

await users.updateMany(
  { role: 'user' },
  { $inc: { loginCount: 1 } }
);
```

签名：

```ts
updateOne(filter: Filter<T>, update: Update<T>, opts?: UpdateOptions): Promise<UpdateResult>;
updateMany(filter: Filter<T>, update: Update<T>, opts?: UpdateOptions): Promise<UpdateResult>;

interface UpdateResult { matchedCount: number; modifiedCount: number; upsertedId?: string; }
```

### 更新操作符

| 操作符 | 含义 | 示例 |
|---|---|---|
| `$set` | 设置字段值 | `{ $set: { name: 'Alice2' } }` |
| `$unset` | 删除字段 | `{ $unset: { avatarUrl: '' } }` |
| `$inc` | 数值自增 | `{ $inc: { age: 1 } }` |
| `$mul` | 数值乘 | `{ $mul: { score: 1.5 } }` |
| `$min` / `$max` | 取极值 | `{ $min: { lowestScore: 80 } }` |
| `$rename` | 重命名字段 | `{ $rename: { name: 'displayName' } }` |
| `$push` | 数组追加 | `{ $push: { tags: 'new' } }` |
| `$pushAll` | 数组批量追加 | `{ $pushAll: { tags: ['a','b'] } }` |
| `$addToSet` | 数组去重追加 | `{ $addToSet: { tags: 'new' } }` |
| `$pull` | 数组按条件删除 | `{ $pull: { tags: 'old' } }` 或 `{ $pull: { tags: { $in: ['a','b'] } } }` |
| `$pop` | 弹首/尾 | `{ $pop: { tags: 1 } }`（1=尾，-1=首） |

### UpdateOptions

```ts
interface UpdateOptions {
  upsert?: boolean;        // 不存在则插入
  expectedRev?: string;    // OCC 乐观锁
  returnUpdated?: boolean; // 返回更新后文档
}
```

### replaceOne

```ts
await users.replaceOne({ _id: '01H8X...' }, { email: '...', name: '...', age: 31 });
// → 整体替换（保留 _id、_rev、createdAt）
```

### upsert

```ts
await users.updateOne(
  { email: 'new@x.com' },
  { $set: { email: 'new@x.com', name: 'New', age: 20 } },
  { upsert: true }
);
// → 不存在则创建
```

## 六、Delete

### deleteOne / deleteMany

```ts
await users.deleteOne({ _id: '01H8X...' });
await users.deleteMany({ role: 'guest' });
```

签名：

```ts
deleteOne(filter: Filter<T>): Promise<DeleteResult>;
deleteMany(filter: Filter<T>): Promise<DeleteResult>;

interface DeleteResult { deletedCount: number; }
```

- 软删除（可选）：schema 声明 `softDelete: true`，delete 实际执行 `$set: { deletedAt: now }`，查询默认过滤 `deletedAt: { $exists: false }`，`find(..., { includeDeleted: true })` 显式包含。
- 删除操作也走 commit 队列，可回滚（事务内）。

## 七、关联展开（include）

```ts
const alice = await users.findOne(
  { email: 'alice@example.com' },
  { include: ['posts'] }
);
// → { ..., posts: [ { _id: '01H8Z...', title: 'Hello' }, ... ] }
```

- `include` 接受字段名或点路径：`['posts', 'posts.comments']`。
- 引用式关联走第二次查询（命中索引），打包成单次返回。
- 内嵌关联原样返回。
- 防止深度爆炸：默认最大深度 3，可配置 `maxIncludeDepth`。

## 八、聚合查询

简化版聚合管道，覆盖大多数场景：

```ts
const stats = await users.aggregate([
  { $match: { age: { $gte: 18 } } },
  { $group: { _id: '$role', count: { $sum: 1 }, avgAge: { $avg: '$age' } } },
  { $sort: { count: -1 } },
  { $limit: 10 }
]);
// → [ { _id: 'user', count: 120, avgAge: 28.5 }, { _id: 'admin', count: 5, avgAge: 35.2 } ]
```

支持的阶段：

| 阶段 | 说明 |
|---|---|
| `$match` | 过滤，等价于 filter |
| `$group` | 分组聚合，支持 `$sum` `$avg` `$min` `$max` `$first` `$last` `$push` |
| `$sort` | 排序 |
| `$limit` / `$skip` | 分页 |
| `$project` | 字段裁剪与重命名 |
| `$unwind` | 数组展开为多行 |
| `$lookup` | 关联查询（等价于 include，但更灵活） |
| `$count` | 计数 |

聚合在本地内存执行，不做流式；适合中小数据（< 100k docs）。

## 九、分页与游标

### 偏移分页

```ts
const page = await users.find(
  { role: 'user' },
  { sort: { createdAt: -1 }, limit: 20, skip: 0 }
);
// page.items, page.total, page.hasMore
```

### 游标分页（推荐大数据量）

```ts
let cursor: string | undefined;
do {
  const page = await users.find(
    { role: 'user' },
    { sort: { createdAt: -1, _id: -1 }, limit: 20, cursor }
  );
  cursor = page.nextCursor;
  // 处理 page.items
} while (cursor);
```

- 游标基于排序键编码（`base64(JSON.stringify(lastSortKey))`）。
- 比 offset 更稳定，新增数据不抖动。

## 十、事务边界（简述，详见 07）

```ts
await db.transaction(async (tx) => {
  const alice = await tx.users.findOne({ email: 'alice@x.com' });
  await tx.users.updateOne({ _id: alice._id }, { $inc: { balance: -100 } });
  await tx.users.updateOne({ _id: bobId }, { $inc: { balance: 100 } });
});
// → 全部打包进一个 commit；任一失败回滚
```

- 事务内所有改动暂存到事务上下文，commit 时统一 commit。
- 冲突时按策略重试（rebase / abort）。

## 十一、事件订阅

```ts
users.on('insert', (doc) => { /* ... */ });
users.on('update', (before, after) => { /* ... */ });
users.on('delete', (doc) => { /* ... */ });

// 远端变更（其他客户端推送）
db.on('remoteChange', (event) => {
  console.log(event.collection, event.type, event.doc);
});
```

事件用于驱动 UI 刷新、触发 webhook、增量更新派生视图。

## 十二、错误模型

```ts
class GitLiteError extends Error { code: string; }

class ValidationError      extends GitLiteError { code: 'VALIDATION'; }
class UniqueConstraintError extends GitLiteError { code: 'UNIQUE_CONSTRAINT'; field: string; }
class NotFoundError         extends GitLiteError { code: 'NOT_FOUND'; }
class ConflictError         extends GitLiteError { code: 'CONFLICT'; expectedRev: string; actualRev: string; }
class QuotaExceededError    extends GitLiteError { code: 'QUOTA'; }
class RateLimitError        extends GitLiteError { code: 'RATE_LIMIT'; retryAfter: number; }
class AuthError             extends GitLiteError { code: 'AUTH'; }
class NetworkError          extends GitLiteError { code: 'NETWORK'; }
```

所有 API 调用可能抛这些错误；SDK 提供统一 `try/catch` 模式与重试策略（`retryOn: ['CONFLICT','NETWORK','RATE_LIMIT']`）。

## 十三、使用示例：博客应用后端

```ts
const db = await GitLite.connect({ provider: 'gitee', repo: { owner: 'me', repo: 'blog-db' }, auth: { type: 'stored', profile: 'me-gitee' } });

const posts    = db.collection<Post>('posts');
const comments = db.collection<Comment>('comments');
const authors  = db.collection<Author>('authors');

// 发文
const postId = await posts.insertOne({
  title: 'Hello GitLite',
  slug: 'hello-gitlite',
  content: '...',
  authorId: '01H8X...',
  tags: ['intro'],
  publishedAt: new Date()
});

// 拉列表（含作者）
const list = await posts.find(
  { publishedAt: { $lte: new Date() }, tags: 'intro' },
  { sort: { publishedAt: -1 }, limit: 10, include: ['author'] }
);

// 加评论（事务）
await db.transaction(async (tx) => {
  await tx.comments.insertOne({ postId, authorId: '01H8Y...', body: 'Nice!' });
  await tx.posts.updateOne({ _id: postId }, { $inc: { commentCount: 1 } });
});

// 全文搜索（用 $regex 或索引）
const results = await posts.find({ content: { $regex: 'gitlite', $options: 'i' } });
```

这一层让开发者完全感觉不到 Git 的存在——他写的是数据库 API，Git 只是它的隐形后端。
