# 08 · 索引与查询性能

> 让查询从「全 collection 扫描」进化到「索引定位候选集」。索引文件独立存放于 `_indexes/`，与数据分离；本地 SQLite 可选作为高性能索引后端。

## 0. 设计目标

1. **查询延迟 P99 < 100ms**（中小数据集，本地内存）。
2. **索引自维护**：写入自动更新索引，无需手动重建。
3. **多索引类型**：唯一索引、复合索引、文本索引、地理索引（可选）。
4. **配额友好**：索引文件精简，避免吃掉仓库配额。
5. **降级可用**：索引损坏或缺失时自动回退全表扫描。

## 一、索引文件格式

### 单文件倒排索引

```
_indexes/
├── users.email.idx.json              ← 单字段索引
├── users.age_name.idx.json           ← 复合索引
├── posts.content.text.idx.json       ← 文本索引
├── posts.authorId_createdAt.idx.json ← 复合索引
└── _manifest.json                    ← 索引清单与版本
```

### 文件结构（JSON）

```jsonc
// _indexes/users.email.idx.json
{
  "name": "email",
  "collection": "users",
  "fields": ["email"],
  "unique": true,
  "version": 3,                          // 索引格式版本
  "schemaVersion": 3,                    // 对应 schema 版本
  "builtAt": "2026-08-15T12:00:00Z",
  "stats": { "docCount": 42, "keyCount": 42, "sizeBytes": 4096 },
  "entries": {
    "alice@example.com":  ["01H8X9EJ5S2KQ3M4N5P6Q7R8S9"],
    "bob@example.com":    ["01H8X9F..."],
    "_null":              [],            // 字段缺失的 doc ids
    "_undefined":         []
  }
}
```

### 复合索引

```jsonc
// _indexes/users.age_name.idx.json
{
  "name": "age_name",
  "fields": ["age", "name"],
  "entries": {
    "30|Alice":  ["01H8X..."],
    "30|Bob":    ["01H8Y..."],
    "25|Carol":  ["01H8Z..."]
  }
}
```

- 键用 `|` 分隔（值中包含 `|` 时转义为 `||`）。
- 支持前缀匹配：`{ age: 30 }` 用前缀 `30|` 扫描。

### 文本索引（倒排）

```jsonc
// _indexes/posts.content.text.idx.json
{
  "name": "content_text",
  "fields": ["content"],
  "type": "text",
  "analyzer": "simple",                  // simple | standard | cjk
  "entries": {
    "gitlite": ["01H8Z...", "01H90..."],
    "database": ["01H8Z..."],
    "嵌入式": ["01H8Z..."]
  },
  "docLengths": { "01H8Z...": 120, "01H90...": 80 }   // 用于 TF-IDF
}
```

- `simple`：按空白与标点分词。
- `standard`：兼容大小写折叠、停用词。
- `cjk`：中文/日文/韩文 n-gram 分词（默认 bigram）。

## 二、索引类型

| 类型 | 用途 | 示例 |
|---|---|---|
| **单字段** | 等值 / 范围查 | `{ email: '...' }` |
| **复合** | 多字段联合查 | `{ age: 30, name: 'A' }` |
| **唯一** | 强制唯一约束 | email、username |
| **文本** | 全文搜索 | `content $regex` 或 `$text` |
| **数组** | 数组成员查询 | `tags: 'staff'` |
| **地理**（可选） | 经纬度查询 | `{ location: { $near: [...] } }` |

### 声明方式

```jsonc
// users.schema.jsonc
{
  "indexes": [
    { "name": "email",      "fields": ["email"],      "unique": true },
    { "name": "age_name",   "fields": ["age", "name"] },
    { "name": "tags_array", "fields": ["tags"],       "type": "array" }
  ]
}
```

字段级简写：

```jsonc
{ "fields": { "email": { "type": "string", "indexed": true, "unique": true } } }
```

## 三、索引自动维护

### 写时维护

```
insertOne(doc):
  1. 写 document
  2. 对该 collection 的每个索引：
     - 计算 key = encode(doc[field])
     - entries[key].push(doc._id)
     - 唯一索引：若 key 已存在 → UniqueConstraintError
  3. 索引文件标记 dirty，随数据 commit 一起 push
```

```
updateOne(filter, update):
  1. 读旧 doc
  2. 应用 update 生成新 doc
  3. 对每个索引：
     - 旧 key = encode(oldDoc[field])
     - 新 key = encode(newDoc[field])
     - 若 key 变化：
       - entries[oldKey].remove(id)
       - entries[newKey].push(id)
       - 唯一索引：检查新 key 不冲突
  4. 写新 doc + 索引
```

```
deleteOne(filter):
  1. 读 doc
  2. 对每个索引：entries[key].remove(id)
  3. 删 doc + 更新索引
```

### 事务内合并

- 事务内多次写同一 doc，索引按最终值更新一次。
- 同事务内多 doc 写，索引更新打包进同一 commit。

### 增量 vs 全量重建

- 正常运行：增量维护（写时同步更新）。
- 索引损坏 / schema 大改：触发全量重建。

```ts
await db.indexes.rebuild('users', 'email');
await db.indexes.rebuildAll();
```

全量重建：

```
1. 读 collection 全量文档
2. 重新生成 entries 表
3. 校验唯一约束
4. 写回 _indexes/<file>
5. 更新 _manifest.json
```

## 四、查询计划器

### 计划生成

```ts
interface QueryPlan {
  collection: string;
  filter: Filter;
  indexesUsed: IndexHint[];      // 使用的索引
  strategy: 'index-scan' | 'full-scan' | 'index-then-filter';
  estimatedCost: number;
  estimatedRows: number;
}
```

### 索引选择算法

```
给定 filter:
  1. 提取所有等值/范围条件字段
  2. 查找可用索引：
     - 单字段索引：精确匹配字段
     - 复合索引：前缀匹配（最左前缀原则）
  3. 估算候选集大小（用索引 stats.keyCount 或采样）
  4. 选 cost 最小（候选集最小）的索引
  5. 没有索引或候选集 > 阈值 → full-scan
```

### 示例

```ts
// filter: { age: 30, name: { $regex: '^A' }, role: 'admin' }
// 索引: users.age_name (age, name), users.role (role)

plan:
  indexesUsed: [users.age_name]
  strategy: 'index-then-filter'
  steps:
    1. index-scan users.age_name prefix "30|"
    2. filter: name $regex '^A'
    3. filter: role === 'admin'
```

### 索引 hint

```ts
await users.find(filter, { hint: { index: 'age_name' } });
await users.find(filter, { hint: { fullScan: true } });   // 强制全表
```

### EXPLAIN

```ts
const plan = await users.explain(filter);
console.log(plan);
// { indexesUsed: ['age_name'], strategy: 'index-then-filter',
//   estimatedRows: 12, estimatedCost: 0.3 }
```

CLI：

```bash
$ gitlite query explain --collection users --filter '{ "age": 30 }'
Index Scan: users.age_name
  prefix: "30|"
  estimated rows: 12
  cost: 0.3
```

## 五、查询执行

### 索引扫描

```
1. 用 plan.indexesUsed 取索引文件
2. 编码 filter 字段为 key 前缀
3. 遍历 entries 收集候选 doc ids
4. 按 id 从 L2/L3 取文档
5. 应用剩余 filter（非索引字段）
6. 排序、limit、skip
```

### 全表扫描

```
1. 加载 collection 全量到 L2
2. 对每个 doc 应用 filter
3. 排序、limit、skip
```

### 排序优化

- 索引字段排序：用索引天然顺序，免排序。
- 复合索引可满足 `sort({ age: 1, name: 1 })`。
- 非索引字段排序：内存排序，受 `sortMemoryLimit` 限制（默认 50MB）。

### 分页优化

- 游标分页配合索引：`cursor` 编码最后一条的索引 key，下次扫描从 key 之后开始，避免 skip。
- offset 分页在索引上仍需扫描前 N 条，但比全表快。

## 六、本地 SQLite 索引后端（可选）

对大数据量（>10k docs）或复杂查询，把索引从 JSON 文件升级到本地 SQLite：

```ts
const db = await GitLite.connect({
  // ...
  indexBackend: 'sqlite'   // 默认 'json'
});
```

### 工作方式

```
~/.gitlite/cache/<provider>/<owner>/<repo>/
├── cache.db                  ← SQLite 文件
└── ...
```

```sql
CREATE TABLE users_data (
  _id TEXT PRIMARY KEY,
  _rev TEXT,
  email TEXT,
  name TEXT,
  age INTEGER,
  -- 全字段存一列，便于 SQL 查询
  _doc TEXT  -- 完整 JSON
);

CREATE UNIQUE INDEX idx_users_email ON users_data(email);
CREATE INDEX idx_users_age_name ON users_data(age, name);
```

### 同步规则

- **数据源仍是 Git 仓库**：SQLite 只是本地索引/缓存，不作为 source of truth。
- **远端变更触发重建**：pull 后 diff，增量更新 SQLite 行。
- **本地写同步更新 SQLite**：写 Mirror 时同步写 SQLite。
- **SQLite 损坏可重建**：删 `cache.db`，下次启动从远端全量重建。

### 性能对比

| 操作 | JSON 索引 | SQLite |
|---|---|---|
| 等值查询（10k docs） | 5–20 ms | 0.5–2 ms |
| 范围查询（10k docs） | 10–50 ms | 1–5 ms |
| 复杂聚合（10k docs） | 50–200 ms | 5–20 ms |
| 全文搜索 | 弱（n-gram） | 中（FTS5） |
| 维护成本 | 低 | 中（需同步） |
| 跨平台 | 纯 JS | 需 native binding |

## 七、性能基准（目标）

| 数据规模 | 查询类型 | 目标延迟 |
|---|---|---|
| 1k docs | 等值（索引） | < 5 ms |
| 1k docs | 范围（索引） | < 10 ms |
| 1k docs | 全表 | < 20 ms |
| 10k docs | 等值（索引） | < 20 ms |
| 10k docs | 范围（索引） | < 50 ms |
| 10k docs | 全表 | < 200 ms |
| 100k docs | 等值（SQLite） | < 5 ms |
| 100k docs | 范围（SQLite） | < 30 ms |
| 100k docs | 全表（SQLite） | < 500 ms |

实际性能取决于硬件、网络、缓存命中率；目标值是设计基准，非合同。

## 八、缓存与预热

### 索引缓存

- 索引文件加载到 L2 后常驻（小）。
- 大索引（>5MB）按需加载 key 段（分段索引）。

### 数据预热

```ts
db.warmup({
  collections: ['users'],
  mode: 'index-only'   // 只加载索引，文档按需
});
```

启动时后台异步执行，不阻塞主流程。

### 查询结果缓存

```ts
await users.find(filter, { cache: { ttl: 60000 } });
// → 60 秒内同 filter 直接返回缓存
```

缓存键 = `collection + hash(filter) + sort + limit + skip`；写操作自动失效相关缓存。

## 九、监控与调优

```bash
$ gitlite indexes list
Collection  Index          Fields       Unique  Size    DocCount
users       email          email        yes     4 KB    42
users       age_name       age,name      no      6 KB    42
posts       content_text   content       no      120 KB  100

$ gitlite indexes stats --collection users
Index        Hits   Misses  HitRate  AvgLatency
email        120    3       97.6%    2.1ms
age_name     45     8       84.9%    8.3ms

$ gitlite query slow-log
12:00:05  users  find  { age: { $gte: 18 } }  full-scan  180ms
12:01:20  posts  find  { content: { $regex: '...' } }  full-scan  320ms
```

SDK：

```ts
db.on('query:slow', (e) => {
  console.warn(`slow query: ${e.collection} ${e.filter} ${e.duration}ms`);
  console.warn('consider adding index on:', e.suggestedIndex);
});
```

### 自动索引建议

- 慢查询日志分析：发现频繁全表扫描的字段组合，建议加索引。
- 未命中索引的查询：返回 `suggestedIndex` 字段。
- CLI：`gitlite indexes suggest` 输出建议清单。

## 十、索引与同步的协作

### 索引 commit 时机

- 单次写操作：数据 + 索引一起 commit（同一 commit 内）。
- 事务：事务 commit 时统一更新索引。
- 全量重建：单独 commit，标记为 `index-rebuild`。

### 跨端索引一致性

- 索引文件在远端仓库内，所有客户端共享。
- 客户端 A 写数据时同步更新索引，push 后客户端 B pull 即得到新索引。
- 不需要每个客户端独立重建（除非本地 SQLite 模式）。

### 索引版本兼容

- `_manifest.json` 记录每个索引的 `version` 与 `schemaVersion`。
- pull 后比对版本；不兼容则本地重建。

```jsonc
// _indexes/_manifest.json
{
  "indexes": [
    { "name": "email", "file": "users.email.idx.json", "version": 3, "schemaVersion": 3 },
    { "name": "age_name", "file": "users.age_name.idx.json", "version": 3, "schemaVersion": 3 }
  ],
  "formatVersion": 1
}
```

## 十一、降级与容错

| 故障 | 行为 |
|---|---|
| 索引文件缺失 | 回退全表扫描；后台异步重建 |
| 索引文件损坏（JSON parse 失败） | 标记损坏，全表扫描；重建 |
| 唯一索引冲突（数据与索引不一致） | 报告不一致，重建索引 |
| 索引过期（schemaVersion 不匹配） | 重建 |
| 索引大于 10MB | 分片（按 key 前缀拆 `_indexes/users.email.0.idx.json` 等） |

引擎永远不因索引问题阻塞查询，最坏退化到全表扫描。

这一层让 GitLite 在中小数据规模下接近本地数据库的查询体验——索引自动维护、计划器智能选路、SQLite 可选加速、降级保证可用。
