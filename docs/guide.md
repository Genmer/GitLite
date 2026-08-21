# GitLite 用户使用手册与产品介绍

> 像 SQLite 一样嵌入在本地，但原生连通云端 Git 仓库。  
> 无需购买服务器、无需配置数据库，把每个人都有的 GitHub / Gitee 私有仓库变成你的免运维云端数据库。

---

## 1. 认识 GitLite

### 1.1 核心痛点与背景
当你开发一款独立软件、桌面端应用（Electron / Tauri / dmg / exe）、个人知识库、配置中心、博客或原型 Demo 时，经常面临两难选择：
1. **纯本地数据库（如普通 SQLite / localStorage）**：无法多设备、多端跨网络自动同步。
2. **云服务器 + 云数据库（如 MySQL / MongoDB / 云 RDS）**：每年要花数百上千元续费，运维成本高，配置繁琐，对个人项目极易闲置浪费。
3. **第三方 BaaS 云平台**：数据存放在第三方服务器，存在隐私顾虑、导出困难和平台锁定风险。

### 1.2 GitLite 的解法
GitLite 是一段直接编译进你应用程序的**嵌入式数据库引擎**（零独立进程、零中间服务器）：
- **数据物理存放在用户自己的 GitHub / Gitee 私有仓库**：没有中间服务器，GitLite 项目方不经手、看不到任何用户数据。
- **本地一线毫秒级读写**：读写直接走本地内存镜像与持久化日志，后台自动低频批量打包成 Git Commit 进行增量同步。
- **零服务器、零费用、防锁定**：断网照常可用，联网自动补推；直接 `git clone` 仓库即可全量导出数据。

---

## 2. 多设备跨端工作流（同账号自动打通）

你在 **Mac、Windows、Android 手机端** 登录同一个 GitHub 或 Gitee 账号，SDK 自动解析身份并绑定到同一个远端数据库分支，无需手动复制连接串或迁移文件：

```
                     ┌──────────────────────────────────────────────┐
                     │            你的 GitHub / Gitee 账号          │
                     │          github.com/alice/gitlite-repo       │
                     │               分支: gitlite/myapp             │
                     └──────────────────────┬───────────────────────┘
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               ▼                            ▼                            ▼
     【Mac 电脑端 App】            【Windows 电脑端 App】         【Android 手机端 App】
    登录 GitHub 账号: alice        登录 GitHub 账号: alice        登录 GitHub 账号: alice
               │                            │                            │
   自动识别为 alice 的 myapp 库   自动识别为 alice 的 myapp 库   自动识别为 alice 的 myapp 库
               │                            │                            │
     本地毫秒读写 ⇄ 自动同步        本地毫秒读写 ⇄ 自动同步        本地毫秒读写 ⇄ 自动同步
```

- 🔄 **自动拉取与响应式刷新**：任何一端写入数据，远端生成 Commit 后，其他端后台拉取并自动派发 `remoteChange` 事件触发 UI 自动刷新。
- 🛡️ **离线可用与断网抗性**：无网络时读写本地镜像与持久化日志；恢复联网后自动补推并执行**字段级三路合并（Three-way Merge）**。

---

## 3. 性能基准与加速指标

GitLite 采用 **L0/L1/L2 行级存储分层** 与 **SQLite 索引后端**，读写延迟与资源消耗指标如下：

### 核心读写延迟基准

| 操作类型 | 数据规模 | 纯内存镜像 (默认) | 本地 SQLite 索引后端 (可选) | 全表扫描对比 | 加速比 |
|---|---|---|---|---|---|
| **单条主键/等值查询** | 10,000 docs | **< 0.1 ms** | **0.5 ~ 2 ms** | 15 ~ 30 ms | **15x ~ 300x** |
| **范围查询 ($gte / $lt)** | 10,000 docs | **< 1 ms** | **1 ~ 5 ms** | 20 ~ 50 ms | **20x ~ 50x** |
| **聚合统计 ($group / $sum)** | 10,000 docs | **1 ~ 5 ms** | **5 ~ 20 ms** | 50 ~ 200 ms | **10x ~ 40x** |
| **本地写操作 (WAL 即时落盘)** | 单条写入 | **< 1 ms** | **< 2 ms** | — | — |
| **增量 Pull 同步** | 变更 1 个文件 | **仅拉取 1 个 Blob** | 树比对精准定位 | 全量下载 | **节省 >95% 流量** |
| **增量 Commit Diff** | 10 张表修改 1 表 | **仅比对脏集合** | 零扫描干净表 | 全表比对 | **减少 >90% I/O** |

### 读写与同步流水线

```
写操作 (insertOne) ──▶ ① 内存镜像写入 (<0.1ms) ──▶ ② 本地 WAL 日志落盘 (<1ms, 崩溃不丢)
                             │
                             ▼
                 [离线缓冲队列 CommitQueue] ──(每10分钟或满100条)──▶ 打包成 1 次 Git Commit ──▶ 批量 Push 到云端
                             ▲
                             │
读操作 (find/findOne) ───────┴─▶ 本地内存镜像直接返回 (<0.1ms，零网络延迟)
```

### 平台配额安全边际

```
GitHub API 官方限额:  ████████████████████████████████████████ 5000 次/小时
GitLite Economy 档:   ▍ < 8 次/小时 (安全边际 > 99.8%，彻底远离封号与限流风险)
```

---

## 4. 数据安全与隐私模型

| 参与方 | 能看到什么 | 看不到什么 |
|---|---|---|
| **GitLite 官方** | **—（完全看不到，无服务器、无数据通道）** | 一切用户数据、Token、使用记录 |
| **GitHub / Gitee** | 仓库内容（本来就是用户的私有仓库，与用户手动提交文件无异） | 用户设备上的本地数据 |
| **应用开发者** | 用户授权给该应用的特定私有仓库 | 用户的其他仓库、用户密码（OAuth 拿不到密码） |
| **终端用户** | **全部数据（数据就在他自己的私有仓库里）** | — |

- **Token 安全**：通过 OAuth（GitHub Device Flow / Gitee 授权码）获取的访问令牌直接保存在本地系统凭据库（macOS Keychain / Linux Secret Service / 本地受限文件），**永不上传、永不入日志**。
- **字段级加密**：支持 AES-256-GCM 字段级加密（仅在 Commit / Pull 边界加解密），远端 Git 仓库即使被他人查看也无法解密敏感字段。

---

## 5. 快速上手（3 分钟接入）

### 5.1 安装 SDK
GitLite 提供了统一的面向开发者主包：

```bash
npm install @gitlite/sdk
```

### 5.2 首次连接与使用

> [!IMPORTANT]
> **🚨 关于鉴权方式的特别说明**：强烈**不推荐**在面向用户的产品中使用 Personal Access Token (PAT) 方式（对终端用户极不友好，需用户手动到后台配置且容易泄露权限）。业务应用与客户端一律使用 `initDB()` 进行全自动无感 OAuth / Device Flow 登录。

```ts
import { initDB } from '@gitlite/sdk';

// 首次调用：自动弹窗引导登录（GitHub Device Flow / Gitee OAuth）并自动建仓建库
// 二次调用：自动读取本地绑定记录，静默直连（幂等）
const db = await initDB({ database: 'myapp' });


// 1. 插入数据（自动生成 ULID 递增主键与 ISO 时间戳，写操作即时落盘）
const userId = await db.collection('users').insertOne({
  email: 'alice@example.com',
  name: 'Alice',
  age: 25,
  role: 'admin'
});

// 2. 丰富查询（Mongo 风格 Filter）
const users = await db.collection('users').find({
  age: { $gte: 18 },
  role: { $in: ['admin', 'user'] }
}, {
  sort: { createdAt: -1 },
  limit: 20
});

// 3. 更新数据（支持 $set, $inc, $push, $unset 等操作符）
await db.collection('users').updateOne(
  { _id: userId },
  { $inc: { age: 1 }, $set: { updatedAt: new Date().toISOString() } }
);

// 4. 事务操作（要么全成要么全弃，打包成一次原子 Commit）
await db.transaction(async (tx) => {
  await tx.collection('users').updateOne({ _id: userId }, { $inc: { balance: -100 } });
});

// 退出前同步（已自动注册进程退出钩子，通常无需手动调用）
await db.close();
```

### 5.3 生态统一规范与授权应用登记教程

为了避免不同 App 各自起名导致混乱，也为了让用户在 GitHub/Gitee 的「已授权的第三方应用」列表中一目了然，GitLite 制定了**全生态统一命名与登记规范**：

#### 📋 统一登记参数规范

| 配置项 | 统一填写规范 | 说明 |
|---|---|---|
| **应用名称** | `GitLite` 或 `GitLite 应用授权` | 避免各 App 自行起名，统一标识更正规好找 |
| **应用主页** | `http://127.0.0.1:18365` | 本地 Loopback 回调基座地址 |
| **应用回调地址** | `http://127.0.0.1:18365/callback` | OAuth 授权完成后的本地安全重定向接口 |
| **权限范围 (Scope)** | **Gitee**：`projects` + `user_info`<br>**GitHub**：`repo` + `read:user` | 仅用于用户识别与私有数据库仓库管理 |
| **默认存储仓库** | `gitlite-repo` | 所有 App 默认共用此仓库，按 `gitlite/<dbname>` 分支隔离 |

#### 🛠️ 一次登记，全机生效（只需 1 分钟）

登记后获取到 Client ID 与 Client Secret，通过以下任一方式保存，本机开发的所有 GitLite App 均自动通用：

1. **方式 1：终端命令行一键绑定（推荐）**
   ```bash
   npx gitlite setup
   # 按照交互提示选择平台，粘贴 Client ID 与 Client Secret，自动落盘
   ```
2. **方式 2：浏览器可视化向导绑定**
   ```bash
   npx tsx examples/setup-page/server.ts
   # 打开 http://127.0.0.1:4173 页面，一键检测、登记并保存
   ```
3. **方式 3：环境变量注入（CI/容器环境）**
   ```bash
   export GITLITE_GITEE_CLIENT_ID="你的ClientID"
   export GITLITE_GITEE_CLIENT_SECRET="你的ClientSecret"
   ```



---

## 6. 三大使用形态

### 形态 1：CLI 命令行交互与 REPL

无需编写代码，直接使用命令行管理和交互：

```bash
# 1. 引导配置：检测环境并登记 OAuth 应用或粘贴私人令牌（一次登记，全机生效）
npx gitlite setup

# 2. 打开交互式数据库 REPL
npx gitlite repl --db gitlite://github:default@me/gitlite-repo/myapp
```

在 REPL 中支持 Tab 补全字段与方法、表达式直接求值：
```javascript
gitlite> await db.users.find({ age: { $gte: 18 } })
[ { _id: '01M0...', name: 'Alice', age: 26 } ]

gitlite> await db.users.insertOne({ name: 'Bob', age: 30 })
"01M0CBMP09..."

gitlite> .sync    # 手动触发同步
gitlite> .exit    # 退出 REPL
```

---

### 形态 2：Schema 代码生成强类型 Client

定义表结构 `users.schema.jsonc`：
```jsonc
{
  "collection": "users",
  "fields": {
    "email": { "type": "string", "required": true },
    "age": { "type": "int" }
  }
}
```

运行生成器：
```bash
npx gitlite codegen --schema ./_schema --out ./src/generated
```

业务代码即可享有完整的类型检查与自动补全：
```ts
import { connect } from './generated/gitlite.client';

const db = await connect({ /* 配置 */ });
// db.users.find({ age: 'twenty' }) // ❌ 编译期直接报错：类型不匹配
```

---

### 形态 3：React 前端与向导组件

```bash
npm install @gitlite/sdk @gitlite/react @gitlite/ui
```

```tsx
import React, { useState } from 'react';
import { useGitLite, useFind } from '@gitlite/react';
import { GitLiteSetup } from '@gitlite/ui';

export function MyApp() {
  const [ready, setReady] = useState(false);
  const { db } = useGitLite('gitlite://github:default@me/gitlite-repo/myapp');

  // 未连接时展示开箱即用的配置向导
  if (!db) {
    return <GitLiteSetup onReady={() => setReady(true)} />;
  }

  return <UserList db={db} />;
}

function UserList({ db }: { db: any }) {
  // 远端仓库有新数据时自动响应并 Refetch
  const { items, loading } = useFind(db, 'users', { age: { $gte: 18 } });

  if (loading) return <div>加载中...</div>;
  return (
    <ul>
      {items.map(u => <li key={u._id}>{u.name} ({u.email})</li>)}
    </ul>
  );
}
```

---

### 形态 4：桌面端与 Vue 3 / Tauri 实战架构（以 Memex 为例）

在桌面端（Tauri / Electron）或 Vue 3 项目中，GitLite 同样具备极强的生产级适配能力。真实开源项目 [**Memex（大模型记忆与技能管理中枢）**](https://github.com/Genmer/Memex) 全面采用 GitLite 作为主存储与多端同步基座，总结出以下黄金实战范式：

#### 1. 跨环境 SmartFetch（彻底解决桌面端 CORS 限制）
桌面环境中的 WebView 发起 `https://gitee.com` 或 `https://api.github.com` 请求时常受 CORS 策略限制。通过注入自定义 `RuntimeAdapter` 将请求委托给 Tauri Rust 后端代理：

```ts
import { type RuntimeAdapter } from '@gitlite/core';
import { invoke } from '@tauri-apps/api/core';

// 优先走 Rust 原生 Reqwest 代理，零 CORS 限制
async function smartFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
  if (isTauri) {
    const res: any = await invoke('proxy_http_request', {
      options: {
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method || 'GET',
        headers: init?.headers,
        body: typeof init?.body === 'string' ? init?.body : undefined
      }
    });
    return new Response(res.body, { status: res.status });
  }
  return window.fetch(input, init);
}
```

#### 2. OAuth 授权多通道闭环（TCP 监听 + 剪贴板兜底）
在 Gitee OAuth 授权流程中，为了应对不同的系统环境与权限限制，设计**四通道并发捕获机制**：
- **通道 A**：Tauri 原生 TCP 监听 `18365` 端口，秒级接收回调并渲染内置的精美授权成功页；
- **通道 B**：授权成功页提供「📋 一键复制授权码 Code」按钮；
- **通道 C**：客户端弹窗支持「一键读取剪贴板」自动提取并注入 Code；
- **通道 D**：通过深链协议（如 `memex://oauth?code=xxx`）直接跳转唤醒客户端。

#### 3. 状态胶囊与主动双向同步（Capsule Pattern）
在顶部状态栏展示 **GitLite 状态胶囊**（显示连接状态、实时呼吸灯、当前库/分支），并提供一键双向主动同步：

```ts
// 主动双向同步（拉取最新变更 + 立即推送本地增量）
async function syncNow(client: GitLiteClient) {
  // 1. 主动拉取远端变更
  await (client as any).sync.pull();
  // 2. 主动推送本地变更
  await (client as any).sync.flush();
}
```

---

### 形态 5：PWA 移动端安装（iPhone / iPad / Android 免 App Store 极速安装）

无需购买每年 $99 的 Apple 开发者账号、无需经过漫长的应用商店审核，基于 GitLite 的纯前端应用可直接通过 **PWA（Progressive Web App）** 安装到 iPhone / Android 主屏幕，实现 **全屏沉浸、全离线可用、多端实时漫游**：

- 🚀 **完整手把手操作手册**：详见专项文档 [**《GitLite PWA 移动端安装与多端实战指南》**](./pwa.md)（涵盖局域网 Wi-Fi 2 分钟极速直连、免费云端一键发布与 iOS 底部安全区适配）。

---

## 7. 实战 Demo 与可视化向导演示


### 7.1 官方实战样例仓库
- 直接查看 [`GitLite-Demo 官方示例仓库`](https://github.com/Genmer/GitLite-Demo)：包含真实的完整应用接入代码与工程化模板，开箱即用。

### 7.2 本地可视化向导
仓库内置了完整的可视化 Web 演示页，支持环境检测、OAuth 登记指引、PAT 校验与建仓全流程：

```bash
# 启动本地演示服务
npx tsx examples/setup-page/server.ts
```
在浏览器打开 `http://127.0.0.1:4173` 即可体验自助绑定的全流程。

---


## 8. 技术选型与适用边界

| ✅ 强烈推荐适用 | ❌ 不适合适用 |
|---|---|
| 个人项目 / 个人知识库 / 笔记软件 | 高并发高频写入（超出 Git API 配额，例如每秒上千次写操作） |
| 独立软件（Electron/桌面应用/移动端） | 大数据量仓库（仓库体积建议 < 1GB，单表 ≤ 10 万行） |
| 静态博客 / Headless CMS 内容存储 | 金融级强一致（如秒杀、跨行转账） |
| 配置中心（天然享有 Git 版本历史与回滚） | 大尺寸二进制多媒体文件存储（建议搭配对象存储） |
| 原型开发 / Demo / 课程作业 | 多用户高频协同冲突编辑 |

---

## 9. 常见问题 (FAQ)

### Q1: GitLite 是怎么避免触发 GitHub / Gitee 的 API 限流的？
GitLite 默认运行在 **Economy 经济档** 同步策略下：
- 所有写操作在本地内存与磁盘日志中即时完成（毫秒级响应）。
- 增量数据每 10 分钟或累积 100 条操作才打包发起一次 Git Commit。
- 单台设备每小时 API 调用次数小于 8 次（远低于 GitHub 5000次/小时的限制）。

### Q2: 多个设备同时使用会发生冲突吗？
支持多设备使用。每台设备维护独立的本地镜像，定期拉取远端 Commit；发生同记录并发修改时，GitLite 引擎自动执行**字段级三路合并**（本地优先），并派发 `sync:conflict` 事件。

### Q3: 为什么说它是“零服务器”？
因为 GitLite 纯粹是一段前端/客户端库（由 `@gitlite/core`、`@gitlite/sdk` 等构成），所有数据传输仅发生在**用户运行环境 ↔ GitHub / Gitee 官方 API** 之间，没有任何中间服务器中转。

### Q4: 为什么强烈不推荐在业务 App 中使用 Personal Access Token (PAT)？
**因为 PAT 方式对终端用户极不友好**：
1. 需要普通用户自行注册开发者账号、去 GitHub/Gitee Settings 找到 Personal Access Tokens 页面；
2. 需要用户手动勾选正确的 `repo` / `projects` 权限（普通用户根本不知道该勾选什么）；
3. 需要用户手动复制一长串不可读密钥并粘贴到 App 中，且一旦泄露无法按应用隔离。

**GitLite 标准推荐的 `initDB()`** 采用 OAuth / Device Flow 流程：用户只需在系统浏览器中点击一次“确认授权”，SDK 便全自动完成身份识别、建仓、建库与凭据安全落盘，体验与常规 Google/微信登录一样顺畅。


