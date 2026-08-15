# 04 · 鉴权与登录流程

> 让用户「点一下就能登录、拿权限、用仓库」。鉴权模块是横切关注点，为 Provider 层提供统一的 token 注入与多账号隔离能力。

## 0. 设计目标

1. **零配置登录**：用户不申请 OAuth App，开箱即用。
2. **最小权限**：默认只申请必要 scope，建仓/删仓按需追加。
3. **凭据安全**：token 不进代码、不进明文配置、不进日志；存系统凭据库。
4. **多账号隔离**：同一台机器可登录多个 GitHub/Gitee 账号，按 profile 切换。
5. **跨环境**：CLI、SDK、桌面端、浏览器端登录流程统一抽象。

## 一、OAuth App 预置策略

GitLite 官方预置一对 OAuth App，client_id 公开（编译进 binary / 写死在 SDK），client_secret 仅服务端组件持有。

| 平台 | 流程 | client_secret 暴露面 | 备注 |
|---|---|---|---|
| GitHub | **Device Flow**（首选） | **无需 secret** | 只需公开 client_id；用户在浏览器输 8 位码即可；CLI/桌面端首选。回退：Authorization Code + PKCE |
| GitHub | Authorization Code + PKCE | 需 secret（仅交换 token 时） | 浏览器端 / 需重定向时用；secret 通过 GitLite 官方 broker 服务中转（可选自建） |
| Gitee | Authorization Code + Loopback + PKCE | **必须 secret** | Gitee 无 Device Flow；强制 client_secret，需 broker 或本地内嵌 secret |

### 关于「secret 内嵌 binary」的取舍

- **风险**：反编译可提取 secret，被滥用冒充 GitLite App。
- **缓解**：secret 仅用于换取 token，不发普通用户；Gitee 侧限制 redirect_uri 为 `http://localhost:<port>/callback`；异常流量会被 Gitee 限流封禁。
- **更优解**：GitLite 官方提供一个轻量 broker（`auth.gitlite.dev`），SDK 走 broker 交换 token，secret 不下沉到客户端。MVP 阶段为降低运维先用内嵌，v1.0 切 broker。

## 二、GitHub 登录流程

### A. Device Flow（首选）

```
┌──────────┐                  ┌──────────┐                ┌──────────┐
│  Client  │                  │ GitLite  │                │  GitHub  │
│ (CLI/SDK)│                  │  Broker  │                │   OAuth  │
└─────┬────┘                  └─────┬────┘                └─────┬────┘
      │  1. POST /login/device/code     │                        │
      │ ───────────────────────────────>│ ──────────────────────>│
      │                                 │   (client_id only)     │
      │  2. device_code + user_code     │                        │
      │     verification_uri            │                        │
      │ <───────────────────────────────│ <──────────────────────│
      │                                 │                        │
      │  3. 显示 user_code，打开浏览器    │                        │
      │     https://github.com/login/device                      │
      │                                 │                        │
      │  4. 轮询 POST /login/oauth/access_token (device_code)     │
      │ ───────────────────────────────>│ ──────────────────────>│
      │                                 │   (slow_down /         │
      │                                 │    authorization_pending)│
      │  5. access_token (+ refresh?)   │                        │
      │ <───────────────────────────────│ <──────────────────────│
      │                                 │                        │
      │  6. 存入系统凭据库               │                        │
      │     getAuthenticatedUser() 校验  │                        │
```

要点：

- Device Flow 不需要 client_secret，**适合所有客户端**。
- 轮询间隔由 GitHub 响应的 `interval`（默认 5s）控制；遇到 `slow_down` 自增 5s。
- user_code 自动复制到剪贴板并打开浏览器；用户授权后客户端拿到 token。
- token 类型：GitHub PAT v2（fine-grained）或 OAuth token；**默认走 fine-grained PAT scope**。

### B. Authorization Code + PKCE（浏览器/需要重定向时）

```
1. 生成 code_verifier (随机 43-128 字符) 与 code_challenge = SHA256(verifier)
2. 打开浏览器：
   https://github.com/login/oauth/authorize?
     client_id=<GITLITE_GH_CLIENT_ID>
     &redirect_uri=http://localhost:<port>/callback
     &scope=repo%20read:user%20user:email
     &state=<random>
     &code_challenge_method=S256
     &code_challenge=<challenge>
3. 启动临时本地 HTTP 服务监听 localhost:<port>
4. 用户授权后 GitHub 回调：http://localhost:<port>/callback?code=...&state=...
5. 校验 state，POST /login/oauth/access_token：
   { client_id, code, grant_type=authorization_code,
     redirect_uri, code_verifier }
   （Device Flow 不需要 secret；PKCE 流程 GitHub 同样不强制 secret）
6. 拿到 access_token，存凭据库
```

## 三、Gitee 登录流程

Gitee **无 Device Flow**，且 token 交换**强制 client_secret**。采用 Authorization Code + Loopback Redirect + PKCE。

```
1. 生成 code_verifier / code_challenge
2. 打开浏览器：
   https://gitee.com/oauth/authorize?
     client_id=<GITLITE_GITEE_CLIENT_ID>
     &redirect_uri=http://localhost:<port>/callback
     &response_type=code
     &scope=user_info%20projects%20pull_requests%20groups
     &state=<random>
     &code_challenge_method=S256
     &code_challenge=<challenge>
3. 临时本地 HTTP 服务接收 callback?code=...&state=...
4. POST https://gitee.com/oauth/token:
   { grant_type=authorization_code,
     code, client_id, client_secret, redirect_uri,
     code_verifier }
5. 拿到 access_token + refresh_token + expires_in
6. 存凭据库（含 refresh_token 与过期时间）
```

要点：

- Gitee token **有过期**（默认 7 天），必须支持 refresh。
- `client_secret` 通过 GitLite broker 中转，或 MVP 阶段内嵌 binary（带前面提到的风险）。
- Scope `projects` 含建仓/删仓；`pull_requests` 用于分支同步；`groups` 可选用于组织仓库。

### 回调地址的分形态适配（打包发行场景）

GitLite 定位为可嵌入基座，登录流程必须覆盖桌面（dmg/exe）与移动（apk/ipa）打包形态。loopback redirect 只在「有 localhost 的环境」可用，因此按壳选择回调方式：

| 壳 | 回调方式 | 说明 |
|---|---|---|
| CLI / Node | loopback（`http://localhost:<port>/callback`） | 默认；临时本地 HTTP 服务 |
| Electron / Tauri（dmg/exe） | loopback 或深链（`gitlite://callback`） | loopback 首选；注册自定义协议后深链亦可 |
| Capacitor / RN（apk/ipa） | **深链**（`gitlite://callback`） | 移动端无 localhost；app 注册 URL scheme，系统浏览器授权后拉起 app |
| 纯浏览器页面 | loopback（仅 localhost 开发）或 broker 托管页 | 生产纯 Web 用 broker 中转 |
| 任意形态 | **Device Flow（GitHub）** | 免回调：用户在浏览器输 8 位码，app 轮询拿 token，打包形态最省事 |

移动端深链流程（Gitee / GitHub PKCE on apk）：

```
1. App 启动时注册 URL scheme：gitlite://
2. 生成 code_verifier / code_challenge / state
3. 打开系统浏览器（Custom Tabs / SFSafariViewController）：
   https://gitee.com/oauth/authorize?...&redirect_uri=gitlite://callback
4. 用户授权 → 浏览器跳转 gitlite://callback?code=...&state=...
5. OS 拉起 App，深链事件携带 query 参数
6. App 校验 state，用 code + code_verifier 换 token
```

注意事项：

- 深链回调依赖 OS 拉起，用户可能停留在浏览器 → app 需在前台恢复时轮询「登录是否已完成」（共享 pending 状态）。
- `redirect_uri` 必须与 OAuth App 预注册值完全一致；GitLite 官方 App 同时注册 `http://localhost:*` 与 `gitlite://callback`。
- Android 12+ 需声明 `android:exported` 与 intent-filter；iOS 需 `CFBundleURLTypes`。
- Gitee 的 redirect_uri 匹配规则较严格（不支持通配端口）→ loopback 端口固定为预注册的具体端口，而非随机端口。

## 四、Scope 与权限矩阵

### GitHub scopes

| Scope | 用途 | 何时申请 |
|---|---|---|
| `repo`（含 private） | 读写私有仓库内容、提交、分支 | 默认 |
| `read:user` + `user:email` | 取用户信息与邮箱 | 默认 |
| `delete_repo` | 删仓库 | 仅用户显式触发「删除仓库」操作时追加 |
| `workflow` | 触发 GitHub Actions | 可选，未来集成 CI |
| `gist` | 读写 Gist | 可选 |

推荐用 **fine-grained PAT** 限定到具体仓库与权限集（Contents R/W、Metadata R、Administration R/W for 建删仓）。

### Gitee scopes

| Scope | 用途 |
|---|---|
| `user_info` | 用户信息 |
| `projects` | 仓库 CRUD（含删仓） |
| `pull_requests` | PR 与分支操作 |
| `groups` | 组织仓库访问 |
| `emails` | 邮箱（可选） |
| `enterprises` | 企业版仓库（可选） |

### 动态 scope 提升

某些敏感操作（删仓、改 collaborator）需要更高权限。流程：

1. 检测当前 token scope 是否覆盖。
2. 不覆盖则触发「重新授权」流程，追加 scope（GitHub 用 `redirect` 重授权；Gitee 重新走 authorize）。
3. 用户确认后替换旧 token。

## 五、Token 存储与多账号隔离

### 凭据存储后端

| 平台 | 后端 | API |
|---|---|---|
| macOS | Keychain | `security add-generic-password` |
| Windows | Credential Manager | `wincred` / `keytar` |
| Linux | Secret Service (libsecret / GNOME Keyring / KWallet) | `keytar` / `secret-tool` |
| 跨平台 fallback | 加密本地文件（`~/.gitlite/credentials.enc`） | AES-256-GCM，密钥派生自 OS 用户态密钥（BestEffort） |
| 浏览器端 | IndexedDB + WebCrypto | 不持久 token，session 内持有；或走 broker session |

> 统一封装为 `CredentialStore` 接口，SDK 自动选择后端；CLI 提供 `gitlite auth status` 查看存储状态。

### Profile（多账号）

```
~/.gitlite/
├── profiles.json             # 不存 token，只存 profile 元数据
└── credentials.enc           # 加密文件 fallback（OS 凭据库不可用时）
```

`profiles.json` 示例：

```jsonc
{
  "current": "alice-gh",
  "profiles": {
    "alice-gh":   { "provider": "github", "login": "alice",   "scopes": ["repo","read:user"], "tokenKey": "gitlite:github:alice" },
    "bob-gh":     { "provider": "github", "login": "bob",     "scopes": ["repo"],             "tokenKey": "gitlite:github:bob" },
    "alice-gitee":{ "provider": "gitee",  "login": "alice",   "scopes": ["user_info","projects"], "tokenKey": "gitlite:gitee:alice" }
  }
}
```

- `tokenKey` 是凭据库里的查找键，凭据库中存实际 token（+ refresh_token + expires_at）。
- CLI 用 `--profile <name>` 切换；SDK `connect(uri, { profile: 'alice-gitee' })`。
- 默认 profile = `current`，可用 `gitlite auth use <name>` 切换。

## 六、登录 API 抽象

```ts
export interface AuthProvider {
  /** 启动登录流程，返回 profile 元数据（token 已写入凭据库） */
  login(opts?: LoginOptions): Promise<Profile>;

  /** 刷新 token（如支持） */
  refresh(profile: Profile): Promise<Profile>;

  /** 注销并删除凭据 */
  logout(profile: Profile): Promise<void>;

  /** 读取当前 token，必要时自动 refresh */
  getAccessToken(profile: Profile): Promise<AccessToken>;

  /** 校验 token 有效性与 scope */
  verify(profile: Profile): Promise<VerifyResult>;

  /** 检查 scope 是否覆盖，返回需追加的 scope 列表 */
  checkScopes(profile: Profile, required: string[]): Promise<ScopeCheck>;
}

export interface LoginOptions {
  profile?: string;          // 指定 profile 名
  scopes?: string[];         // 追加 scope
  flow?: 'device' | 'pkce';  // GitHub 优先 device
  openBrowser?: boolean;     // 默认 true
  redirectPort?: number;     // PKCE 时的本地端口
}
```

## 七、CLI 登录命令

```bash
# 默认登录（GitHub Device Flow）
$ gitlite auth login
? Select provider: GitHub
Your device code: ABCD-1234
Opening https://github.com/login/device ...
✓ Logged in as alice (scopes: repo, read:user)
✓ Token saved to OS keychain (profile: alice-gh)

# Gitee 登录
$ gitlite auth login --provider gitee
Opening https://gitee.com/oauth/authorize ...
✓ Logged in as alice (scopes: user_info, projects)

# 列出账号
$ gitlite auth status
  alice-gh    github   alice   ✓ valid   scopes: repo, read:user
* alice-gitee gitee    alice   ✓ valid   scopes: user_info, projects
  bob-gh      github   bob     ✗ expired (run: gitlite auth refresh bob-gh)

# 切换
$ gitlite auth use alice-gh

# 追加 scope（如要删仓）
$ gitlite auth scopes add delete_repo
Re-authorizing with additional scope: delete_repo ...

# 登出
$ gitlite auth logout alice-gitee
```

## 八、SDK 登录示例

```ts
import { GitLite, GitHubProvider, GiteeProvider } from '@gitlite/sdk';

// 1. 触发登录（首次会打开浏览器/显示 device code）
const client = await GitLite.connect({
  provider: 'github',
  auth: { type: 'oauth', flow: 'device' }
});
// → 内部调用 AuthProvider.login()，token 自动存 OS keychain

// 2. 后续使用（自动从 keychain 取 token）
const client2 = await GitLite.connect({
  provider: 'github',
  auth: { type: 'stored', profile: 'alice-gh' }
});

// 3. 直接用 PAT（CI / 高级用户）
const client3 = await GitLite.connect({
  provider: 'github',
  auth: { type: 'pat', token: process.env.GH_TOKEN }
});

// 4. 切换 Gitee
const giteeClient = await GitLite.connect({
  provider: 'gitee',
  auth: { type: 'stored', profile: 'alice-gitee' }
});
```

## 九、Token 失效与刷新

| 触发场景 | 表现 | 处理 |
|---|---|---|
| GitHub token 过期（OAuth） | API 401 | 走 `refresh`（如配置了 refresh_token）或重新登录 |
| Gitee token 过期（7 天） | API 401 + `invalid_token` | 用 refresh_token 换新；refresh_token 也过期则重新登录 |
| Scope 不足 | API 403 + `insufficient_scope` | 提示用户追加 scope，触发重新授权 |
| Token 被撤销 | API 401 | 清除凭据，提示重新登录 |
| Rate limit | API 403 + `X-RateLimit-Remaining: 0` | 不当鉴权问题，由限流管理器处理（见 10） |

引擎对所有远端调用统一拦截 401/403，触发自动 refresh 或友好报错；refresh 失败累计 3 次后停止重试并通知用户。

## 十、安全注意点

1. **redirect_uri 校验**：本地 HTTP 服务只接受 `localhost` 与预注册端口段，防止恶意重定向。
2. **state 校验**：每次 PKCE 流程生成随机 state，回调严格比对，防 CSRF。
3. **PKCE 强制**：所有 Authorization Code 流程必须带 `code_challenge`，禁止 plain。
4. **凭据库优先**：禁止把 token 明文写 `~/.gitlite/profiles.json`；fallback 加密文件只在 OS 凭据库不可用时启用，并明确告警。
5. **日志脱敏**：任何 `Authorization: Bearer xxx` 在日志中替换为 `Bearer <redacted>`；token 永不出现在异常栈。
6. **broker 可选自建**：企业用户可部署自己的 broker，避免依赖官方服务；配置 `auth.brokerUrl`。

## 十一、软件内创建/删除仓库

登录拿到带 `repo`/`projects` scope 的 token 后：

```ts
// 创建仓库（GitHub & Gitee 接口一致抽象）
await client.repos.create({
  name: 'my-app-db',
  description: 'GitLite database for my app',
  private: true,
  autoInit: true                  // 初始化 README，确保有默认分支
});

// 列出我的仓库
const repos = await client.repos.list({ owner: 'alice' });

// 删除仓库（需 delete_repo / projects scope）
await client.repos.delete({ owner: 'alice', repo: 'my-app-db' });
```

详见 [02-provider-abstraction.md](./02-provider-abstraction.md) 的 `createRepo` / `deleteRepo` 接口定义。

CLI 命令：

```bash
$ gitlite repo create my-app-db --private --description "..." --auto-init
$ gitlite repo list
$ gitlite repo delete my-app-db   # 二次确认 + 检查 delete_repo scope
```

## 十二、未登录态的有限使用

支持「匿名只读」试用：未登录时可连接公开仓库的只读镜像，无需 token，但受未认证限流（GitHub 60/h、Gitee 60/h）。任何写操作强制要求登录。
