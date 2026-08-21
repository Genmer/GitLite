# 09 · SDK 与 CLI

> 给开发者递一把好用的瑞士军刀：SDK 像 Prisma / Firestore 一样顺手的 client；CLI 对标 `sqlite3` + `prisma` + `firebase`，从建库到查询一气呵成。

## 0. 设计目标

1. **5 分钟上手**：`npm i @gitlite/sdk` → `connect` → `insertOne`，无配置。
2. **类型安全**：schema → 强类型 Client，编译期 catch 错误。
3. **CLI 全功能**：建库、登录、迁移、查询、导入导出、调试。
4. **跨运行时**：Node.js / Bun / Deno / 浏览器 / Edge Worker / React Native。
5. **可扩展**：插件机制、自定义 Provider、自定义索引后端。

## 一、Monorepo 结构

```
gitlite/
├── packages/
│   ├── core/                  @gitlite/core      引擎内核（无运行时依赖）
│   │   ├── src/
│   │   │   ├── provider/      Provider 抽象 + GitHub/Gitee 适配
│   │   │   ├── storage/       存储引擎 + 数据模型映射
│   │   │   ├── sync/          同步与缓存引擎
│   │   │   ├── query/         查询引擎 + 计划器
│   │   │   ├── index/         索引引擎
│   │   │   ├── tx/            事务管理器
│   │   │   └── auth/          鉴权模块
│   │   └── package.json
│   ├── sdk/                   @gitlite/sdk       用户 facing API
│   │   ├── src/
│   │   │   ├── client.ts      GitLite.connect(...)
│   │   │   ├── collection.ts  Collection<T>
│   │   │   ├── cursor.ts      QueryCursor
│   │   │   └── types.ts       公共类型
│   │   └── package.json
│   ├── cli/                   @gitlite/cli       命令行工具
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   └── repl.ts
│   │   └── package.json
│   ├── codegen/               @gitlite/codegen   schema → TS 类型
│   │   └── ...
│   ├── react/                 @gitlite/react     React hooks
│   │   └── ...
│   ├── ui/                    @gitlite/ui        内置向导与绑定管理组件
│   │   └── ...
│   └── adapters/                                  运行时适配
│       ├── node/              fs / http / keytar
│       ├── browser/           IndexedDB / fetch / WebCrypto
│       └── bun/               Bun.file / fetch
├── examples/                  示例代码
├── docs/                      设计文档
└── pnpm-workspace.yaml
```

包依赖：`sdk` → `core` + `adapters-node`；`cli` → `sdk + codegen + adapters-node`；`react` → `sdk`；`ui` → `sdk + react + adapters-node`。`core` 通过 `RuntimeAdapter` 注入运行时能力。
`@gitlite/sdk` 作为一体化主包，已经统一 re-export 了 Node 适配器函数（`createNodeRuntime`、`createNodeSqlite`、`waitForRedirect`、`createOsCredentialStore`、`FileCredentialStore`）与核心错误类（`OAuthAppNotConfiguredError`、`GitLiteError` 等），业务层无需单独安装或引入 `@gitlite/adapters-node`。

## 二、SDK 核心 API

### 连接

```ts
import { connect, createNodeRuntime } from '@gitlite/sdk';

const db = await connect({
  provider: 'github',
  owner: 'alice',
  repo: 'my-app-db',
  token: process.env.GITHUB_TOKEN
});
```


### 连接字符串（URI 模式）

```ts
// 等价于上面
const db = await GitLite.connect('gitlite://github:alice-gh@alice/my-app-db');

// 仅限无人工界面的 CI/CD 自动化测试（强烈不推荐在用户产品中使用 PAT，对终端用户极不友好）：
const db = await GitLite.connect('gitlite://github:<token>@alice/my-app-db');

// Gitee
const db = await GitLite.connect('gitlite://gitee:alice-gitee@alice/my-app-db');

```

URI 格式：

```
gitlite://<provider>:<auth>@<owner>/<repo>[/<database>]?<options>

provider: github | gitee | gitlab | local
auth:     <profile-name> | <token> | oauth
database: 省略 = 仓库模式（整仓即库）；带名 = 分支模式（分支 gitlite/<database>，默认推荐）
options:  sync=auto & consistency=cache & indexBackend=json
```

### 首次初始化：`initDB()` 一键向导（推荐入口）

对标 SQLite 的 `sqlite3.open()`——但 GitLite 需要登录与选仓库，所以第一次调用 `initDB()` 会**弹出内置向导 UI**（WebView 弹窗 / 新浏览器窗口），引导用户完成全部配置；之后调用则**幂等静默**：读本地绑定记录直接返回连接，不再打扰用户。

```ts
import { initDB } from '@gitlite/sdk';

const db = await initDB();        // 第一次：弹向导；之后：静默直连
```

向导流程（内置 UI，`@gitlite/ui` 提供）：

```
Step 1  选平台      [GitHub] [Gitee] （可多选：第二个作为镜像绑定）
Step 2  登录        OAuth（GitHub Device Flow / Gitee PKCE），token 入 OS 凭据库
Step 3  选仓库      ○ 默认 gitlite-repo（推荐）
                   ○ 自定义名称 [________]
                   ○ 从已有仓库列表选择 [dropdown]
        选数据库    ○ 默认 app 约定名（如 myapp） ○ 自定义
Step 4  仓库检查    （见下表三种结果）
Step 5  完成        连接就绪，返回 db；绑定关系写入 ~/.gitlite/bindings.json
```

**Step 4 仓库检查**——这是安全关键步骤：

| 检查结果 | 判定 | 行为 |
|---|---|---|
| 空仓库 / 仅有 autoInit README | tree 为空或只有 README | 直接 bootstrap（写入系统文件并 commit） |
| **GitLite 标准仓库** | 根目录有 `gitlite.config.jsonc` 且 `_meta/head.json` 存在 | 校验 `formatVersion` 兼容后直接连接 |
| **非空且非 GitLite** | 有其他文件但无 GitLite 标志 | ⚠️ **强制警告页**，用户三选 |

非 GitLite 仓库的警告页（危险操作提示）：

```
┌─────────────────────────────────────────────────┐
│ ⚠️ 该仓库包含非 GitLite 数据                      │
│                                                 │
│ 检测到 23 个现有文件：                            │
│   src/ · docs/ · README.md · package.json ...   │
│                                                 │
│ 初始化将【添加】GitLite 系统文件：                 │
│   gitlite.config.jsonc · _schema/ · _indexes/   │
│   _meta/ · _migrations/                         │
│                                                 │
│ 承诺：不会删除或修改任何现有文件。                  │
│ 但仍建议使用空仓库或专用仓库，避免混乱。            │
│                                                 │
│   [取消]   [换个仓库]   [我已了解，继续初始化]      │
└─────────────────────────────────────────────────┘
```

**headless 模式（自建设计页面）**：向导的每一步都暴露为普通 API，内置 UI 只是默认皮肤——

```ts
// 不弹 UI，全代码控制（自己设计页面的用户用这组 API）
const db = await initDB({
  ui: false,
  provider: 'gitee',
  repo: 'gitlite-repo',            // 或自定义名
  database: 'myapp',
  onNonGitLiteRepo: 'confirm'      // 'confirm' | 'abort' | (repo)=>Promise<'confirm'|'abort'>
});                                 //     ↑ 非空非标准仓库时的策略：已确认/中止/回调自定义 UI

// 或分步 API 完全手动编排
const providers = GitLite.supportedProviders();            // ['github','gitee']
await GitLite.auth.login({ provider: 'gitee' });
const existing = await GitLite.repos.list();               // 给用户挑
const check = await GitLite.probeRepo({ owner, repo });    // → { state:'empty'|'gitlite'|'foreign', files? }
const db = await GitLite.connect({ ..., createIfMissing: true });
```

### initDB 幂等语义

```
initDB() 调用
  ├─ 本地已有 bindings.json？
  │   ├─ 有 → 静默用已存绑定 connect（不弹任何 UI）
  │   └─ 无 → 弹向导（或走 headless 参数）
  └─ force: true → 无视已有绑定，重新走向导（换仓库/换账号用）
```

绑定记录 `~/.gitlite/bindings.json`（WebView 环境存 IndexedDB）：

```jsonc
{
  "active": "github",
  "bindings": [
    { "provider": "github", "owner": "me", "repo": "gitlite-repo", "role": "primary" },
    { "provider": "gitee",  "owner": "me", "repo": "gitlite-repo", "role": "mirror" }
  ],
  "database": "myapp"
}
```

（只存绑定关系；token 始终在 OS 凭据库，见 04。）

### 底层：connect 与首次初始化流程

`initDB` 内部最终调 `connect`。`connect` 提供 `createIfMissing` 与自动登录，把「登录 → 建仓/建分支 → bootstrap」串成一次调用：

```ts
// 分支模式（默认推荐）：默认仓库名 gitlite-repo，库 = gitlite/<database> 分支
const db = await GitLite.connect({
  provider: 'gitee',
  repo: { owner: 'me', repo: 'gitlite-repo' },   // 缺省 repo 名即 gitlite-repo
  database: 'blog',                               // → 分支 gitlite/blog
  auth: { type: 'oauth', flow: 'pkce' },
  createIfMissing: { private: true, autoInit: true }  // 仓库或分支不存在都自动建
});

// 仓库模式（备选）：整仓即库，不带 database
const db2 = await GitLite.connect({
  provider: 'github',
  repo: { owner: 'alice', repo: 'my-app-db' },
  auth: { type: 'oauth', flow: 'device' },
  createIfMissing: { private: true, autoInit: true }
});
```

首次 connect 内部流程（分支模式）：

```
1. 取 token：keychain 无 → 自动触发 OAuth 登录（Device Flow / PKCE）
             → 存入 OS 凭据库
2. 探测仓库：GET /repos/<owner>/gitlite-repo
   └─ 404 且配置了 createIfMissing → POST /user/repos 建仓（autoInit 保证有 main）
3. 探测分支：GET 分支 gitlite/<database>
   └─ 不存在且配置了 createIfMissing → 建分支（base = main）
4. Bootstrap（仅空分支首次）：写入系统目录并 commit
   ├─ gitlite.config.jsonc        默认配置
   ├─ _schema/_meta.schema.jsonc  系统 schema
   ├─ _indexes/_manifest.json     索引清单
   └─ _meta/head.json             水位初始化
5. 预热：fetch 单分支（depth=1）→ 建立本地三层缓存 → ready
```

第二次及以后 connect：跳过 1–4，直接预热就绪。

### 运行期管理页面（可随时调出）

向导不是一次性的——app 可随时调出内置管理 UI，或用等价 API 自建页面：

```ts
// 内置 UI（React 组件，来自 @gitlite/ui）
import { BindingManager, SyncSettings } from '@gitlite/ui';

<BindingManager db={db} />      // 绑定管理：加/删镜像、切主、看限流冷却状态
<SyncSettings db={db} />        // 同步设置：频率档位、手动 sync、离线队列查看

// 等价 headless API（自建页面用）
GitLite.ui.showBindings();      // 非 React 宿主的封装弹窗（Web Component）
GitLite.ui.showSettings();

await GitLite.bindings.list();                    // 见 06 failover 一节
await GitLite.bindings.add({ provider: 'gitee', role: 'mirror' });  // 加镜像（弹登录）
await GitLite.bindings.setPrimary('gitee');
db.bindings.status;   // { mode:'normal'|'failover'|'fully-local', cooldowns:[...] }
```

BindingManager 页面示意：

```
┌─ 仓库绑定 ──────────────────────────────────────┐
│ ● github  me/gitlite-repo   [primary]  ✓ 正常   │
│ ○ gitee   me/gitlite-repo   [mirror]   ✓ 镜像中 │
│                                 落后 3 分钟     │
│                                                │
│ [+ 绑定新平台]   [设为主仓库]   [移除]           │
├─ 同步 ─────────────────────────────────────────┤
│ 档位: (•)economy  ( )balanced  ( )realtime      │
│ 离线队列: 12 条待提交        [立即同步]          │
└────────────────────────────────────────────────┘
```

### 数据库管理 API（分支模式的库操作）

```ts
// 在默认仓库 gitlite-repo 内管理多个 database
await GitLite.databases.create('blog',  { provider: 'gitee', auth });  // 建分支
await GitLite.databases.list({ provider: 'gitee', auth });
// → ['blog', 'tasks', 'crm']  （gitlite/ 前缀已剥掉）
await GitLite.databases.drop('old-db', { provider: 'gitee', auth });   // 删分支（二次确认）

// CLI
$ gitlite db create blog
$ gitlite db list
$ gitlite db drop old-db
```

> 分仓 vs 共仓的选择：GitHub push 次级限流（6/min）按仓库计——多个库共享 `gitlite-repo` 会共享 push 预算。写密集的多库用户用仓库模式分仓分摊；普通用户用默认分支模式，Gitee 私有仓配额只占 1 个。

### 仓库归属的三种模式

「用户怎么指定仓库」取决于 app 的数据放谁账号下：

| 模式 | repo 参数来源 | 首次体验 | 适用 |
|---|---|---|---|
| **A. 开发者自己的仓库** | 写死在代码/配置里 | 终端用户登录**开发者或专用账号**（PAT 仅限内部测试，强烈不推荐给用户使用） | 个人工具、自用脚本 |
| **B. 终端用户自己的仓库**（推荐用于分发 app） | 登录后取 `user.login`，默认仓 `gitlite-repo` + `database` 用 app 约定名（如 `myapp`） | 每个用户首次启动：登录自己账号 → app 在**他的**账号下自动建仓+分支 | 分发的桌面/移动 app——**app 零后端，数据跟用户走**；多 app 共用一个 `gitlite-repo`，不额外吃仓库配额 |
| **C. 组织共享仓库** | 写死指向组织仓库 | 用户登录（需组织权限） | 团队协作，多端连同一个库 |


模式 B 的标准写法：

```ts
// 1. 先登录（不知道 owner 是谁）
const auth = await GitLite.auth.login({ provider: 'github', flow: 'device' });

// 2. 用登录身份连接：默认仓 gitlite-repo + database 用 app 约定名，不存在则建
const db = await GitLite.connect({
  provider: 'github',
  repo: { owner: auth.user.login, repo: 'gitlite-repo' },  // 缺省仓库名
  database: 'myapp',                                        // → 分支 gitlite/myapp
  auth: { type: 'oauth' },
  createIfMissing: { private: true, autoInit: true }
});
```

仓库选择也可以交给 UI：app 先 `repos.list()` 让用户挑已有仓库、`databases.list()` 挑已有库，或输入新名字创建——SDK 把两条路径都暴露为普通 API，UI 层自由组合。

> 边界提醒：Gitee 免费个人账号私有仓库上限 5 个。分支模式（默认）下所有 app 共用一个 `gitlite-repo`，正好规避此限制——这也是分支模式设为默认的主要原因。若用户仓库数已满，`createIfMissing` 建仓会失败，SDK 返回可读错误引导用户清理或改用已有仓库。

### Collection 操作

```ts
const users = db.collection<User>('users');

// CRUD
await users.insertOne({ email: 'a@x.com', name: 'A' });
const alice = await users.findOne({ email: 'a@x.com' });
await users.updateOne({ _id: alice._id }, { $set: { age: 31 } });
await users.deleteOne({ _id: alice._id });

// 查询
const page = await users.find(
  { age: { $gte: 18 } },
  { sort: { createdAt: -1 }, limit: 20, include: ['posts'] }
);

// 聚合
const stats = await users.aggregate([
  { $match: { role: 'user' } },
  { $group: { _id: '$role', count: { $sum: 1 } } }
]);

// 事务
await db.transaction(async (tx) => {
  await tx.users.updateOne({ _id: aliceId }, { $inc: { balance: -100 } });
  await tx.users.updateOne({ _id: bobId }, { $inc: { balance: 100 } });
});
```

### Schema 与迁移

```ts
await db.schema.create('users', {
  fields: { email: { type: 'string', unique: true }, name: { type: 'string' } },
  indexes: [{ name: 'email', fields: ['email'], unique: true }]
});

await db.schema.update('users', { version: 2, addField: { name: 'age', type: 'int' } });
await db.migrate('users', { addField: { name: 'age', default: 0 } });
```

### 仓库管理

```ts
await db.repos.create({ name: 'new-db', private: true, autoInit: true });
await db.repos.list({ owner: 'alice' });
await db.repos.delete({ owner: 'alice', repo: 'old-db' });
```

### 同步控制

```ts
await db.sync.push();
await db.sync.pull();
await db.sync.sync();
await db.sync.flush();

const status = db.sync.status;
// { online: true, pendingPush: 3, conflicts: 0, lastSyncAt: '...' }
```

### 事件

```ts
db.on('online',  () => { /* ... */ });
db.on('offline', () => { /* ... */ });
db.on('sync:push',    (e) => { /* ... */ });
db.on('sync:pull',    (e) => { /* ... */ });
db.on('sync:conflict',(e) => { /* ... */ });
db.on('remoteChange', (e) => { /* ... */ });
users.on('insert', (doc) => { /* ... */ });
users.on('update', (b, a) => { /* ... */ });
users.on('delete', (doc) => { /* ... */ });
```

## 三、Codegen：schema → 强类型 Client

### 输入 schema

```jsonc
// _schema/users.schema.jsonc
{ "collection": "users", "fields": {
    "email": { "type": "string", "required": true },
    "age": { "type": "int" },
    "tags": { "type": "array", "items": { "type": "string" } }
}}
```

### 生成类型

```ts
// generated/gitlite.types.ts
export interface User {
  _id: string;
  email: string;
  age?: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserInput {
  email: string;
  age?: number;
  tags?: string[];
}
```

### 生成强类型 Client

```ts
// generated/gitlite.client.ts
import { GitLite, TypedCollection } from '@gitlite/sdk';
import { User, UserInput } from './gitlite.types';

export class GitLiteClient {
  users: TypedCollection<User, UserInput>;
  posts: TypedCollection<Post, PostInput>;
  // ...

  constructor(private db: GitLiteDb) {
    this.users = db.collection<User>('users');
  }
}

export async function connect(opts: ConnectOptions): Promise<GitLiteClient> {
  const db = await GitLite.connect(opts);
  return new GitLiteClient(db);
}
```

### 使用

```ts
import { connect } from './generated/gitlite.client';

const db = await connect({ /* ... */ });

const alice = await db.users.findOne({ email: 'a@x.com' });
//    ^? User | null，且 filter 字段名拼写错误会编译报错

await db.users.updateOne({ _id: alice._id }, { $set: { age: 'thirty' } });
//                                            ^? Type 'string' is not assignable to 'number'
```

### CLI 触发

```bash
$ gitlite codegen                    # 从连接的远端仓库生成
$ gitlite codegen --schema ./_schema # 从本地 schema 文件生成
$ gitlite codegen --watch            # 监听 schema 文件变化自动重生
```

## 四、CLI 命令体系

### 全局结构

```
gitlite <command> <subcommand> [flags]

命令分组：
  auth       鉴权与账号
  repo       仓库管理
  schema     schema 与迁移
  data       数据操作（CRUD/查询）
  sync       同步控制
  indexes    索引管理
  import     导入数据
  export     导出数据
  codegen    生成类型代码
  repl       交互式 shell
  config     配置
```

### auth

```bash
gitlite auth login [--provider github|gitee] [--flow device|pkce] [--scopes ...]
gitlite auth status
gitlite auth use <profile>
gitlite auth refresh [<profile>]
gitlite auth logout [<profile>]
gitlite auth scopes add <scope>      # 追加 scope，触发重授权
gitlite auth scopes list <profile>
```

### repo

```bash
gitlite repo create <name> [--private] [--description "..."] [--auto-init]
gitlite repo list [--owner <name>] [--limit 50]
gitlite repo info <owner>/<repo>
gitlite repo delete <owner>/<repo>   # 二次确认
gitlite repo clone <owner>/<repo>    # 用 token 克隆到本地（普通 git clone 不带 token）
```

### schema

```bash
gitlite schema create <collection> --file ./users.schema.jsonc
gitlite schema list
gitlite schema show <collection>
gitlite schema update <collection> --file ./users.v2.schema.jsonc
gitlite schema diff <collection>    # 对比本地 schema 与远端
gitlite schema migrate <collection> --field <name> --type int --default 0
```

### data

```bash
# 单条
gitlite data insert <collection> --doc '{"email":"a@x.com","name":"A"}'
gitlite data find <collection> --filter '{"email":"a@x.com"}'
gitlite data update <collection> --filter '{...}' --update '{"$set":{...}}'
gitlite data delete <collection> --filter '{...}'

# 列表
gitlite data list <collection> [--filter '{...}'] [--sort createdAt:-1] [--limit 20] [--skip 0]
gitlite data count <collection> --filter '{...}'

# 复杂查询
gitlite data aggregate <collection> --pipeline '[{"$match":{...}},{"$group":{...}}]'

# 文件直接读写（高级）
gitlite data read <collection>/<id>           # 输出原始 JSON
gitlite data write <collection>/<id> --file ./doc.json
```

### sync

```bash
gitlite sync status
gitlite sync push
gitlite sync pull
gitlite sync sync
gitlite sync flush
gitlite sync log [--limit 20]
gitlite sync conflicts                       # 列出未解决冲突
gitlite sync resolve <conflictId> --strategy local|remote|merge
```

### indexes

```bash
gitlite indexes list [--collection <name>]
gitlite indexes create <collection> --fields email --unique
gitlite indexes drop <collection> <indexName>
gitlite indexes rebuild [<collection> [<indexName>]]
gitlite indexes rebuild --all
gitlite indexes stats [--collection <name>]
gitlite indexes suggest                       # 基于慢查询日志建议
```

### import / export

```bash
# 从 JSON 数组导入
gitlite import <collection> --file ./data.json --format json-array

# 从 CSV 导入
gitlite import <collection> --file ./data.csv --format csv --map 'name,email,age'

# 从另一个 collection 导入
gitlite import <collection> --from-collection <other> --filter '{...}'

# 导出
gitlite export <collection> --filter '{...}' --file ./out.json --format json-array
gitlite export <collection> --file ./out.csv --format csv
gitlite export --all --file ./backup.tar.gz   # 全库备份
```

### codegen

```bash
gitlite codegen [--schema ./_schema] [--out ./generated] [--watch]
```

### repl

```bash
$ gitlite repl --db gitlite://github:alice-gh@alice/my-app-db
gitlite> db.users.find({ age: { $gte: 18 } })
[ { _id: '01H8X...', email: 'a@x.com', age: 30 }, ... ]

gitlite> db.users.insertOne({ email: 'new@x.com', name: 'New' })
"01H90..."

gitlite> db.transaction(async tx => { ... })
committed: abc1234

gitlite> .schema users
email: string (unique, indexed)
age: int
...

gitlite> .exit
```

REPL 支持自动补全（collection 名、字段名、操作符）、历史记录、多行输入。

### config

```bash
gitlite config set defaultProvider github
gitlite config set defaultProfile alice-gh
gitlite config set sync.batchSize 20
gitlite config get sync.batchSize
gitlite config list
gitlite config edit            # 打开编辑器
```

配置文件：`~/.gitlite/config.jsonc`。

## 五、CLI 全局选项

```bash
--db <uri>                  # 连接字符串，覆盖 config
--profile <name>            # 指定 profile
--provider <name>
--json                      # 输出 JSON（便于脚本管道）
--quiet / -q
--verbose / -v
--dry-run                   # 只打印将执行的操作
--no-color
--help / -h
--version
```

## 六、React Hooks（@gitlite/react）

```tsx
import { useGitLite, useCollection, useFind, useDoc } from '@gitlite/react';

function App() {
  const db = useGitLite({ provider: 'github', repo: { owner: 'alice', repo: 'db' }, auth: { type: 'stored', profile: 'alice-gh' } });

  return <UserList db={db} />;
}

function UserList({ db }) {
  const { data, loading, error, refetch } = useFind(db.users, { age: { $gte: 18 } }, { sort: { name: 1 }, limit: 20 });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  return (
    <ul>
      {data.items.map(u => <li key={u._id}>{u.name} ({u.email})</li>)}
    </ul>
  );
}

function UserEditor({ db, id }) {
  const { data: user, loading } = useDoc(db.users, id);

  const [update] = useUpdate(db.users);
  return (
    <form onSubmit={e => { e.preventDefault(); update({ _id: id }, { $set: { name: 'New' } }) }}>
      {/* ... */}
    </form>
  );
}
```

Hooks 自动：

- 订阅 `remoteChange` 事件，远端变更自动 refetch。
- 写操作后乐观更新本地缓存。
- 配合 Suspense / Concurrent 渲染。

## 七、跨运行时适配与打包发行

GitLite 的定位是**可嵌入基座**：作为纯前端库嵌入其他 app，可打包为 dmg（macOS）、exe（Windows）、apk（Android）发行。这由三个选型保证：isomorphic-git 纯 JS 内核（无 native 依赖）、TypeScript 单代码库、RuntimeAdapter 注入运行时能力。

```ts
// @gitlite/core 定义接口
export interface RuntimeAdapter {
  fs: FsAdapter;          // 文件读写
  http: HttpAdapter;      // 网络请求
  crypto: CryptoAdapter;  // hash / random
  credential: CredentialAdapter;  // 凭据存储
  logger: LoggerAdapter;
}

// Node.js 适配
import { NodeRuntime } from '@gitlite/adapters/node';
const db = await GitLite.connect({ ..., runtime: new NodeRuntime() });

// 浏览器适配
import { BrowserRuntime } from '@gitlite/adapters/browser';
const db = await GitLite.connect({ ..., runtime: new BrowserRuntime() });

// Bun 适配
import { BunRuntime } from '@gitlite/adapters/bun';

// Electron 适配（renderer 进程）
import { ElectronRuntime } from '@gitlite/adapters/electron';
const db = await GitLite.connect({ ..., runtime: new ElectronRuntime() });

// Tauri 适配（WebView + Rust 壳）
import { TauriRuntime } from '@gitlite/adapters/tauri';

// Capacitor 适配（Android/iOS WebView）
import { CapacitorRuntime } from '@gitlite/adapters/capacitor';
```

### 运行时能力矩阵

| 能力 | Node | Browser | Bun | Deno | Electron | Tauri | Capacitor | RN |
|---|---|---|---|---|---|---|---|---|
| fs | fs/promises | IndexedDB | Bun.file | Deno.readFile | IndexedDB/主进程fs | IndexedDB/插件fs | IndexedDB | AsyncStorage |
| http | fetch/undici | fetch | fetch | fetch | fetch（无CORS） | fetch/Rust代理 | 原生HTTP（无CORS） | fetch |
| crypto | node:crypto | WebCrypto | node:crypto | WebCrypto | WebCrypto | WebCrypto | WebCrypto | expo-crypto |
| credential | keytar | IndexedDB+WebCrypto | keytar | OS keychain | safeStorage | stronghold/keyring | Keystore/Keychain | SecureStore |

### 打包发行矩阵

| 目标 | 壳 | adapter | Gitee CORS | OAuth 回调 | 产物 |
|---|---|---|---|---|---|
| macOS 桌面 | Electron | electron | 无此问题（主进程可代理） | loopback / Device Flow | `.dmg` |
| macOS 桌面 | Tauri | tauri | 走 Rust HTTP 插件 | loopback / Device Flow | `.dmg` |
| Windows 桌面 | Electron | electron | 无此问题 | loopback / Device Flow | `.exe` / `.msi` |
| Windows 桌面 | Tauri | tauri | 走 Rust HTTP 插件 | loopback / Device Flow | `.exe` / `.msi` |
| Android | Capacitor | capacitor | 走 capacitor-http 原生层 | 深链 `gitlite://callback` | `.apk` / `.aab` |
| Android | React Native | react-native | 无 WebView 无 CORS | 深链 | `.apk` |
| iOS | Capacitor / RN | capacitor / rn | 同上 | 深链 | `.ipa` |
| 纯 Web | — | browser | **需 broker 代理**（见下） | loopback（仅 localhost） | 静态站点 |
| Node 服务端 | — | node | 无此问题 | Device Flow / PAT | npm 包 |

### CORS 说明（关键差异）

- **GitHub API**：官方支持浏览器 CORS，带 token 直连可用，所有壳与纯 Web 均无障碍。
- **Gitee API**：文档未承诺 CORS 响应头。影响与对策：
  - Electron / Tauri / Capacitor / RN：HTTP 走原生层（主进程 / Rust 插件 / capacitor-http / RN fetch），**不受 CORS 约束**，直连即可。
  - 纯浏览器页面：可能被浏览器拦截。对策是经 `api.gitlite.dev` broker 转发（可自建），或接受「Gitee 仅打包形态可用」的降级。
  - Provider 层暴露 `requiresCorsProxy` capability，SDK 据此自动路由：`browser runtime + gitee provider + no proxy configured` → 启动时给出明确告警。

### 嵌入示例（Electron）

```ts
// renderer 进程
import { GitLite } from '@gitlite/sdk';
import { ElectronRuntime } from '@gitlite/adapters/electron';

const db = await GitLite.connect({
  provider: 'gitee',
  repo: { owner: 'me', repo: 'app-db' },
  auth: { type: 'oauth', flow: 'pkce' },
  runtime: new ElectronRuntime()      // safeStorage 存 token，主进程 fs 做 L3
});
```

打包：`electron-builder` 正常打 dmg/exe，GitLite 无 native 依赖（keytar 可替换为 safeStorage 以实现零 native 模块，简化打包）。

### 嵌入示例（Capacitor → apk）

```ts
import { GitLite } from '@gitlite/sdk';
import { CapacitorRuntime } from '@gitlite/adapters/capacitor';

const db = await GitLite.connect({
  provider: 'github',
  repo: { owner: 'me', repo: 'app-db' },
  auth: { type: 'oauth', flow: 'device' },   // Device Flow 免深链；PKCE 则走深链
  runtime: new CapacitorRuntime()
});
```

## 八、错误处理与重试

```ts
import { GitLiteError, ConflictError, RateLimitError, NetworkError } from '@gitlite/sdk';

try {
  await users.updateOne(filter, update);
} catch (e) {
  if (e instanceof ConflictError) {
    // OCC 冲突，重试或人工处理
  } else if (e instanceof RateLimitError) {
    await sleep(e.retryAfter);
    // 重试
  } else if (e instanceof NetworkError) {
    // 离线，进入队列
  } else if (e instanceof GitLiteError) {
    // 其他 GitLite 错误
  }
}
```

SDK 默认重试策略：`['CONFLICT', 'NETWORK', 'RATE_LIMIT']` 自动重试，其他错误抛出。

## 九、插件机制

```ts
interface GitLitePlugin {
  name: string;
  install(db: GitLiteDb, opts?: any): void;
}

// 自定义 Provider
const GiteaPlugin: GitLitePlugin = {
  name: 'gitea',
  install(db, opts) {
    db.providers.register('gitea', new GiteaProvider(opts));
  }
};

GitLite.use(GiteaPlugin, { baseUrl: 'https://gitea.example.com' });

// 自定义索引后端
GitLite.use(PostgresIndexPlugin, { connectionString: '...' });

// 自定义同步钩子
GitLite.use(WebhookPlugin, {
  onChange: (event) => fetch('https://my-app.com/webhook', { method: 'POST', body: JSON.stringify(event) })
});
```

## 十、示例：完整应用

```ts
// app.ts
import { connect } from './generated/gitlite.client';

const db = await connect({
  provider: 'gitee',
  repo: { owner: 'myteam', repo: 'task-tracker' },
  auth: { type: 'stored', profile: 'me-gitee' },
  sync: { mode: 'auto' },
  consistency: 'cache'
});

// 创建任务
await db.tasks.insertOne({
  title: 'Design logo',
  assigneeId: '01H8X...',
  status: 'todo',
  dueAt: '2026-09-01T00:00:00Z'
});

// 查询待办
const todos = await db.tasks.find(
  { status: 'todo', assigneeId: '01H8X...' },
  { sort: { dueAt: 1 }, include: ['assignee'] }
);

// 完成任务（事务）
await db.transaction(async (tx) => {
  await tx.tasks.updateOne({ _id: taskId }, { $set: { status: 'done', completedAt: new Date() } });
  await tx.users.updateOne({ _id: userId }, { $inc: { doneCount: 1 } });
});

// 监听远端变更（多人协作）
db.on('remoteChange', (e) => {
  if (e.collection === 'tasks') io.emit('task:changed', e.doc);
});
```

```bash
# 一次性操作
$ gitlite auth login --provider gitee
$ gitlite repo create task-tracker --private --auto-init
$ gitlite schema create tasks --file ./tasks.schema.jsonc
$ gitlite codegen --schema ./_schema --out ./generated
$ gitlite data import tasks --file ./seed.json
```

这一层把 GitLite 的全部能力包装成开发者熟悉的样子：SDK 像 ORM，CLI 像数据库 shell，Codegen 像类型魔法师，Hooks 像 React 数据流。
