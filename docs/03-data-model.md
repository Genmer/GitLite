# 03 · 数据模型与存储映射

> 把数据库概念（database / collection / document / index / schema）干净地映射到 Git 仓库的文件与目录结构上。映射规则一旦定下，存储引擎、查询引擎、同步引擎都按它行事。

## 0. 设计目标

1. **自描述**：仓库被 clone 下来即可被人/工具读懂，不依赖外部元数据服务。
2. **Git 友好**：单文件即一行（document），改动可 diff、可合并、可回滚；避免把整个数据库塞进单个大文件。
3. **类型安全**：schema 显式声明，编译期与运行时双重校验。
4. **可演进**：schema 版本化，迁移有迹可循。
5. **配额友好**：避免无谓的大对象、重复冗余；索引与数据分目录管理。

## 一、核心映射规则

| 数据库概念 | Git 仓库实体 | 路径约定（默认） | 说明 |
|---|---|---|---|
| Database | **分支**（默认）或仓库 | `gitlite/<name>` 分支 | 默认：一个仓库（`gitlite-repo`）内以 `gitlite/<name>` 分支区分 database。备选：一仓库一库（分摊 push 配额）。见下节。 |
| Collection | 目录（Directory） | `/<collection>/**` | 一级目录即一个 collection；collection 名即目录名。 |
| Document | 文件或文件内一行 | `/<collection>/<id>.json` 等 | 按 collection 规模分级存储（inline / doc-per-file / sharded），见「表-行存储分级」。 |
| Index | 索引文件 | `/_indexes/<collection>.<name>.idx.json` | 倒排索引，独立目录，避免与数据混淆。 |
| Schema | Schema 文件 | `/_schema/<collection>.schema.jsonc` | 显式声明字段、类型、约束。 |
| Migration | 迁移记录 | `/_migrations/<timestamp>-<name>.json` | 不可变日志。 |
| Config | 配置文件 | `/gitlite.config.jsonc` | 数据库级配置：默认一致性、缓存策略、加密策略。 |
| Secrets | 加密字段 | 内嵌于 document（`_enc` 前缀） | AES-256-GCM 字段级加密（见 10-security-roadmap）。 |

### 数据库寻址：分支模式（默认）与仓库模式

**分支模式（默认）**：默认仓库 `gitlite-repo`，每个 database 是一条 `gitlite/<name>` 分支。

```
gitlite-repo/
├── branch: main            ← 仅 README/说明，不存数据
├── branch: gitlite/blog    ← database "blog"
├── branch: gitlite/tasks   ← database "tasks"
└── branch: gitlite/crm     ← database "crm"
```

| 操作 | 分支模式实现 | API |
|---|---|---|
| 建库 | 建分支（base = main） | GitHub `POST /repos/.../git/refs`；Gitee `POST /repos/.../branches` |
| 列库 | 列分支，过滤 `gitlite/` 前缀 | 两平台均有 branches list |
| 删库 | 删分支 | 两平台均可删分支 |
| 连库 | fetch 单分支（depth=1） | isomorphic-git / Git DB API |

**为何默认分支模式**：Gitee 免费个人账号私有仓上限 5 个——一仓一库会让用户第三个 app 就没额度；一个 `gitlite-repo` 承载所有库，仓库配额只消耗 1 个。

**仓库模式（备选）**：`connect` 指定独立仓库、不带 database 名，即一仓库一库。适用：写密集的多库用户（GitHub push 次级限流 6/min **按仓库计**，多库共仓会共享 push 预算，分仓可分摊）、组织共享库。

```
connect URI:
gitlite://github:alice@alice/gitlite-repo/blog        ← 分支模式（gitlite/blog 分支）
gitlite://github:alice@alice/my-app-db                ← 仓库模式（整仓即库）
```

### 表-行存储分级（Storage Tiers）

「一行一文件」在 10 万行时就是 10 万个 blob。硬约束：GitHub Tree API 超 10 万条目返回 `truncated`；Contents 列表每页 1000 条；每个 blob 都是一次 API 调用与对象开销。因此按 collection 规模自动分级，**对查询/API 层完全透明**（它们始终面对 document 抽象）：

| 级别 | 物理形态 | 适用规模 | 文件数 | 典型场景 |
|---|---|---|---|---|
| **L0 inline** | `/<collection>.jsonl` 单文件装整表 | < 50 行 | 1 | 配置表、特性开关 |
| **L1 doc-per-file** | `/<collection>/<id>.json` 一行一文件 | < 5,000 行 | = 行数 | 默认起点；diff 粒度最细 |
| **L2 sharded** | `/<collection>/shard-NNNN.jsonl` 千行一分片 | 5k – 100k 行 | ≈ 行数/1000 | 日志、事件、大表 |

```
users/                          ← L1：一行一文件
├── 01H8X....json
└── 01H8Y....json

events/                         ← L2：分片
├── shard-0000.jsonl            ← 每片 ≤ min(1000 行, 512KB)
├── shard-0001.jsonl
└── shard-0002.jsonl
```

L2 分片机制：

- **分片键**：ULID 前缀范围分片（时间聚簇，天然利于时间范围扫描）；分片清单存 `_meta/shards/<collection>.json`（range → file）。
- **按 id 定位**：主键索引 `_indexes/<collection>._id.idx.json` 映射 id → 分片文件 → 行内查找。
- **写放大控制**：改一行 = 重写该分片（1 个 blob）；同分片改 N 行也只重写一次。诚实代价：1KB 行 × 1000 行/片 ≈ 1MB，改一行要传整片——所以分片大小压在 512KB 内（Gitee 无 Git DB API、降级走 Contents API 有单文件 1MB 硬限）。
- **分片格式 JSONL**：一行 = 一个 document（含 `_id`），行级 diff 友好。
- **冲突合并**：引擎读 base/local/remote 三个分片版本，**按行 `_id` diff 后再做字段级三路合并**，重新序列化——不依赖 Git 文本合并。
- **自动分裂/合并**：分片超 1500 行自动 split、低于 200 行可并入相邻片，作为一次结构迁移 commit 记入 `_migrations/`。
- **级别迁移**：行数穿越阈值（带 1.2× 迟滞）时引擎自动 inline ↔ doc-per-file ↔ sharded 迁移，同样记入迁移日志；schema 可用 `"storage": "auto" | "inline" | "doc-per-file" | "sharded"` 锁定。

> 查询层与索引层**不感知**存储级别：storage engine 统一暴露 `read(collection, id)` / `scan(collection)` / `applyWrites(collection, ops)`，物理形态（文件还是行）完全内部消化。

### 目录结构示例（分支模式，database = `gitlite/blog` 分支内）

```
（gitlite-repo 仓库，gitlite/blog 分支）
├── gitlite.config.jsonc        ← DB 级配置
├── _schema/
│   ├── users.schema.jsonc
│   ├── posts.schema.jsonc
│   └── _meta.schema.jsonc      ← 系统元 schema
├── _indexes/
│   ├── users.email.idx.json
│   ├── posts.authorId_createdAt.idx.json
│   └── _manifest.json          ← 索引清单与版本
├── _migrations/
│   └── 20260101T000000Z-init.json
├── config.jsonl                ← L0 inline collection（小配置表）
├── users/                      ← L1 doc-per-file collection
│   ├── 01H8X...ULID.json
│   └── 01H8Y...ULID.json
├── events/                     ← L2 sharded collection
│   ├── shard-0000.jsonl
│   └── shard-0001.jsonl
└── _meta/                      ← 系统元数据（提交水位、分片清单、向量时钟等）
    ├── head.json
    └── shards/events.json
```

> 系统目录约定以 `_` 开头（`_schema`/`_indexes`/`_migrations`/`_meta`），与用户 collection 区分；用户 collection 名禁止以 `_` 开头。

## 二、Schema 定义（JSONC，锚定 JSON Schema 标准）

采用 JSONC 格式，文件名 `.schema.jsonc`。**字段校验部分是 JSON Schema Draft 2020-12 的子集**（标准关键字原样使用），GitLite 特有语义一律用 `x-gitlite-*` 命名空间隔离（仿 OpenAPI `x-` 惯例）——这是「格式宪法」的一部分（见第十一节）：标准部分跟随 JSON Schema 演进永不自造，自定义部分集中在 vendor 扩展里可控演进。

```jsonc
// _schema/users.schema.jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",   // ← 标准 JSON Schema
  "gitliteDescriptor": {                          // ← GitLite collection 级配置（自有契约）
    "collection": "users",
    "version": 3,
    "idStrategy": "ulid",            // ulid | uuid | auto-increment | named
    "idField": "_id",
    "storage": "auto",               // auto(默认,按行数分级) | inline | doc-per-file | sharded
    "timestamps": true
  },

  // ↓↓ 以下全部是标准 JSON Schema 关键字 + x-gitlite-* 扩展
  "type": "object",
  "properties": {
    "_id":       { "type": "string",
                   "x-gitlite-immutable": true },
    "email":     { "type": "string", "format": "email", "maxLength": 254,
                   "x-gitlite-unique": true, "x-gitlite-indexed": true },
    "name":      { "type": "string", "maxLength": 100 },
    "age":       { "type": "integer", "minimum": 0, "maximum": 150,
                   "x-gitlite-indexed": true },
    "role":      { "enum": ["admin", "user", "guest"], "default": "user" },
    "tags":      { "type": "array", "items": { "type": "string" } },
    "address":   { "type": "object", "properties": {
                     "city": { "type": "string" },
                     "zip":  { "type": "string", "pattern": "^\\d{6}$" }
                   } },
    "avatarUrl": { "type": "string", "format": "uri" },
    "metadata":  { "type": "object", "additionalProperties": true },
    "_enc.ssn":  { "type": "string",
                   "x-gitlite-encrypted": true }
  },
  "required": ["_id", "email", "name"],           // ← 标准 required 数组（默认其余 optional）

  "x-gitlite-relations": {
    "posts": { "kind": "one-to-many", "from": "_id", "to": "posts.authorId" }
  },
  "x-gitlite-indexes": [
    { "name": "email",    "fields": ["email"],       "unique": true },
    { "name": "age_name", "fields": ["age", "name"] }
  ]
}
```

### 关键字分类

| 类别 | 关键字 | 来源 |
|---|---|---|
| **标准**（永不改动语义） | `type` `enum` `pattern` `format` `maxLength` `minimum` `maximum` `items` `properties` `additionalProperties` `required` `default` | JSON Schema Draft 2020-12 |
| **vendor 扩展**（GitLite 语义，可演进） | `x-gitlite-unique` `x-gitlite-indexed` `x-gitlite-encrypted` `x-gitlite-immutable` `x-gitlite-ref` `x-gitlite-relations` `x-gitlite-indexes` | GitLite 自有，semver 管理 |

### 类型映射（JSON Schema 类型 → GitLite 语义）

| JSON Schema | GitLite 语义 |
|---|---|
| `string` + `format: date-time` | datetime，统一 UTC ISO 8601（`2026-08-15T10:00:00.000Z`） |
| `integer` / `number` | 整数 / 浮点 |
| `string` + `x-gitlite-ref: "<collection>"` | 引用另一个 collection 的文档 ID |
| `{ "enum": [...] }` | 枚举 |
| `type: object` + `additionalProperties: <schema>` | 任意键 record |
| 无 schema / `true` | 不校验（any） |

## 三、Document 格式

### 主格式：JSON（默认）

```json
// users/01H8X9EJ5S2KQ3M4N5P6Q7R8S9.json
{
  "_id": "01H8X9EJ5S2KQ3M4N5P6Q7R8S9",
  "_rev": "a1b2c3",                          // 文档内容 hash（OCC 乐观锁）
  "_schema": 3,                              // 写入时 schema 版本
  "email": "alice@example.com",
  "name": "Alice",
  "age": 30,
  "role": "admin",
  "tags": ["staff", "early"],
  "address": { "city": "Shanghai", "zip": "200000" },
  "createdAt": "2026-08-15T10:00:00.000Z",
  "updatedAt": "2026-08-15T12:30:00.000Z"
}
```

### 备选格式：YAML / Markdown Frontmatter

为内容编辑场景支持：

- `/<collection>/<id>.yaml`：可读性更好，diff 更友好。
- `/<collection>/<id>.md`：frontmatter 存字段，body 存长文本（适合博客 / 知识库）。

格式由 schema 的 `format` 字段指定：

```jsonc
{ "collection": "posts", "format": "md-frontmatter", "bodyField": "content" }
```

存储引擎按 collection 配置选择序列化器；查询引擎统一抽象为 document。

### 二进制与附件

**不在仓库内存大二进制**（会快速吃光配额）。两种推荐策略：

1. **外部存储引用**：字段存 URL，指向 OSS/S3/对象存储或图床。
2. **小附件 inline**：< 100KB 的图片可 base64 内嵌，但 schema 应显式声明 `encoding: base64` 并加 `maxSize` 校验。

## 四、ID 策略

| 策略 | 格式 | 适用 |
|---|---|---|
| `ulid`（默认） | 26 字符 `01H8X9EJ5S2KQ3M4N5P6Q7R8S9` | 默认。时间有序、可排序、无冲突、URL 安全 |
| `uuid` | 36 字符 UUID v4 | 需要标准 UUID 时 |
| `auto-increment` | `000001`、`000002`… 零填充 | 需要短可读 ID；用 `_meta/seq/<collection>.json` 维护序号 |
| `named` | 用户指定 | 业务自然主键（如 `slug`），需声明 `unique` |

**默认 ULID 的理由**：时间有序利于按时间范围扫描与排序；26 字符 URL 安全；客户端可独立生成无中心协调，写入不打到远端也能预知 ID。

## 五、关系模型

### 引用式（默认）

```jsonc
// posts/01H8Z...json
{ "_id": "01H8Z...", "authorId": "01H8X...", "title": "Hello" }
```

- 类似关系型外键，无强约束（除非 schema 声明 `onDelete: cascade|restrict|setNull`）。
- 查询时通过 `include` 选项展开（见 05-crud-api）。

### 内嵌式

```jsonc
// posts/01H8Z...json
{ "_id": "01H8Z...", "author": { "_id": "01H8X...", "name": "Alice" }, "title": "Hello" }
```

- 适合「一起读、不一起改」的强关联数据。
- 内嵌对象不独立寻址，不维护单独索引。

### 多对多

通过中间 collection 实现：

```
user_roles/
├── 01H...json   { "userId": "...", "roleId": "...", "grantedAt": "..." }
└── 01H...json
```

schema 声明：

```jsonc
{ "collection": "user_roles",
  "relations": {
    "user": { "kind": "many-to-one", "to": "users._id", "localField": "userId" },
    "role": { "kind": "many-to-one", "to": "roles._id", "localField": "roleId" }
  } }
```

## 六、Schema 演进与迁移

### 版本号

每个 schema 文件带 `version` 整数，每次不兼容变更递增。document 写入时记录 `_schema` 版本。

### 迁移日志

```
_migrations/
├── 20260101T000000Z-init.json
├── 20260201T120000Z-add-age-to-users.json
└── 20260301T090000Z-encrypt-ssn.json
```

迁移文件格式：

```jsonc
// _migrations/20260201T120000Z-add-age-to-users.json
{
  "id": "20260201T120000Z-add-age-to-users",
  "appliedAt": "2026-02-01T12:00:00.000Z",
  "appliedBy": "alice",
  "fromVersion": 2,
  "toVersion": 3,
  "collection": "users",
  "description": "Add age field with default 0",
  "transform": {                          // 声明式，由引擎解释执行
    "addField": { "name": "age", "default": 0 }
  },
  "commitSha": "abc1234"                  // 应用迁移那次 commit 的 sha
}
```

### 兼容性策略

| 变更类型 | 兼容性 | 处理 |
|---|---|---|
| 加字段（有 default） | 兼容 | 懒迁移：读到旧 doc 自动补 default 并异步写回 |
| 加字段（无 default） | 兼容 | 视为 optional；查询返回 `null` |
| 删字段 | 兼容（读） | 旧字段读时忽略；写时丢弃 |
| 改字段类型 | 不兼容 | 必须迁移；声明式 transform 或自定义脚本 |
| 改 `unique` 约束 | 不兼容 | 迁移 + 重建索引 |

## 七、Document 内容 Hash（_rev）

每个文档维护 `_rev` = 内容（除 `_rev` 外字段按规范化顺序序列化）的 SHA-1 前 12 位。

用途：

1. **OCC 乐观锁**：更新时携带 `expectedRev`，与服务端比对，冲突则重试。
2. **同步去重**：相同 `_rev` 跳过传输。
3. **缓存校验**：本地缓存按 `_rev` 失效。

## 八、系统元数据 `_meta/`

```
_meta/
├── head.json          ← 当前已同步远端 HEAD commit sha、时间、push 水位
├── seq.json           ← auto-increment 序号表（如使用）
└── vector-clock.json  ← 多客户端并发写入的向量时钟（可选）
```

`head.json` 示例：

```jsonc
{
  "remoteHeadOid": "abc1234...",
  "remoteHeadAt": "2026-08-15T12:00:00.000Z",
  "localPendingCommits": 3,
  "lastSyncAt": "2026-08-15T12:01:00.000Z"
}
```

## 九、配额与尺寸约束

| 维度 | 软上限 | 理由 |
|---|---|---|
| 单 document 大小 | 1 MB | GitHub Contents API 单文件上限 1 MB；Gitee 同 |
| 单 collection 文档数 | 100,000 | 全量内存查询性能拐点 |
| 仓库总大小 | 1 GB | GitHub/Gitee 免费私有仓库推荐上限 |
| 单 commit 文件改动数 | 100 | 平衡 commit 体积与冲突概率 |
| 索引文件大小 | 10 MB | 超过则分片（见 08-indexing-performance） |

引擎在写入前校验，超限抛 `QuotaExceededError`，给出可读建议（如「请改用外部存储」「请分 collection」）。

## 十、与查询/同步引擎的契约

- **存储引擎**：负责序列化/反序列化、路径解析、schema 校验、`_rev` 计算。
- **查询引擎**：通过 storage engine 的 `read(collection, id)` / `scan(collection, filter)` 接口取数，不直接碰 Git API。
- **同步引擎**：按 collection 维度 diff「本地 Mirror」与「远端 tree」，生成 commit 计划；提交后回写 `_meta/head.json`。
- **索引引擎**：监听 collection 写事件，增量更新 `_indexes/*.idx.json`。

这一层映射是后续所有模块的共同语言：上层只看到 document，下层只看到文件。

## 十一、格式标准与兼容性契约（Format Constitution）

> 软件会多次迭代，但**仓库内文件/目录结构标准一旦发布就尽量不改**——否则用户数据库就要丢弃重置。本节定义「格式宪法」：锚定开放标准 + 只增不改演进规则 + 版本门禁。目标是 v0.3 冻结 `formatVersion 1.0.0`。

### 1. 锚定的开放标准（不自造）

| GitLite 结构 | 锚定标准 | 稳定性来源 |
|---|---|---|
| 底层存储模型 | Git 对象模型（blob / tree / commit / ref） | Git 本身 15+ 年向后兼容 |
| 文档与分片文件 | JSON（RFC 8259）、JSONL（jsonlines.org） | 通用基础标准 |
| schema 字段校验 | **JSON Schema Draft 2020-12**（子集，见第二节） | 标准委员会维护，关键字语义永不自造 |
| 主键 ID | ULID 官方 spec（github.com/ulid/spec） | 规范冻结 |
| 时间戳 | ISO 8601（UTC） | 冻结 |
| 格式版本号 | SemVer 2.0.0 | 冻结 |
| MD collection | YAML frontmatter（gray-matter 惯例） | 生态通用惯例 |
| 自定义关键字 | 一律 `x-gitlite-*` 前缀 | 仿 OpenAPI `x-` 惯例，与标准隔离 |

**原则：能借开放标准的绝不自造。** 自造面收缩到两处：目录布局约定（本文档第一节）+ `x-gitlite-*` 扩展关键字。

### 2. formatVersion 与版本门禁

`gitlite.config.jsonc` 头字段（对标 SQLite 文件头的 read/write version 字段哲学）：

```jsonc
{
  "formatVersion": "1.0.0",     // SemVer：[major, minor, patch]
  "createdBy": "gitlite@0.3.0",
  ...
}
```

客户端打开规则：

| 情形 | 行为 |
|---|---|
| repo.major == client.major | 正常打开（minor/patch 差异必须兼容） |
| repo.major < client.major | 正常打开（新客户端向后兼容旧格式） |
| repo.major > client.major | **拒绝打开**，提示升级 GitLite（防止旧客户端写入破坏新格式） |

### 3. 演进规则：只增不改（additive-only）

**minor 版本升级只能做加法，禁止做减法或语义变更：**

1. **允许**：新增 `_` 系统目录/文件（如未来 `_views/`）、文档新增可选元字段、`x-gitlite-*` 新增关键字、索引文件新增可选字段。
2. **禁止**：改已有文件路径/命名、改字段语义、删除系统文件、改 `_rev` 算法、改 JSONL 行结构。
3. **未知容忍（前向兼容核心）**：客户端遇到**不认识的 `_` 目录、文件、schema 关键字、文档元字段**时——读路径忽略、写路径**原样保留**（commit 时不得丢弃）。这条规则保证「旧客户端打开新格式仓库」不损坏数据。
4. **major 升级**：仅当绝对必要时（预期极少），必须伴随官方迁移工具（`gitlite migrate --from 1 --to 2`），且迁移可回滚。

### 4. 冻结与验证机制

| 机制 | 说明 |
|---|---|
| **早期冻结** | v0.1–v0.2 标记 `formatVersion: "0.x.0"`（实验期，允许重置，UI 明示）；**v0.3 冻结 `1.0.0`**，此后只走 additive-only |
| **黄金仓库测试集** | CI 维护一组各版本快照仓库；每个新版 GitLite 必须通过「读所有历史黄金仓库 + 写回后逐字节等价（除时间戳）」测试 |
| **双客户端互操作测试** | 最新版客户端 × 历史版客户端（N-2 起）交叉读写测试 |
| **格式变更 RFC** | 任何 formatVersion 变更需走 RFC 流程（提案 → 影响评估 → 迁移方案 → 冻结） |

### 5. 已冻结的核心结构清单（v1.0.0）

以下结构进入冻结范围，v1.x 内不可变更：

- 数据库寻址：`gitlite/<database>` 分支命名、`gitlite/tx/<txId>` 事务分支前缀
- 根级文件：`gitlite.config.jsonc`、`_schema/`、`_indexes/`、`_migrations/`、`_meta/`
- collection 布局：`<collection>.jsonl`（L0）/ `<collection>/<id>.json`（L1）/ `<collection>/shard-NNNN.jsonl`（L2）
- 文档元字段：`_id`（ULID）、`_rev`（内容 SHA-1 前 12 位）、`_schema`、`createdAt`/`updatedAt`（ISO 8601 UTC）
- schema 文件：JSON Schema Draft 2020-12 子集 + `x-gitlite-*` 扩展命名空间
