# 02 · Git 供应商抽象层（Provider Abstraction Layer）

> 统一抽象屏蔽 GitHub/Gitee 等 Git 托管平台的 API 差异。首先支持 GitHub 和 Gitee，未来扩展 GitLab、Gitea、Bitbucket。

## 0. 调研结论速览

| 维度 | GitHub REST API v3 | Gitee API v5 | GitLab API v4（对照） |
|---|---|---|---|
| API 基址 | `https://api.github.com` | `https://gitee.com/api/v5` | `https://gitlab.com/api/v4`（可自托管） |
| 认证 | `Authorization: Bearer <token>`（强制头） | `access_token` 查询参数 / Basic Auth / Bearer | `PRIVATE-TOKEN` 或 `Authorization: Bearer` |
| 令牌粒度 | 精细（Fine-grained PAT / GitHub App） | 粗（默认关联账户全部权限） | `api` / `read_api` / `read_repository` / `write_repository` |
| 速率限制（认证） | 5000/h；二级：内容创建 80/min、500/h；push 6/min/仓 | 5000/h（认证）；60/h（未认证） | 300/min（认证，可配） |
| 文件 Contents | `GET/PUT/DELETE /repos/{o}/{r}/contents/{path}`（create 与 update 同走 PUT，靠 `sha` 区分；单文件 ≤1MB） | `GET`/`POST`(create) / `PUT`(update,需 `sha`) / `DELETE`；**文件名必须带扩展名** | `GET/POST/PUT/DELETE /projects/:id/repository/files/:file_path`（base64，`ref` 必填） |
| 批量提交 | Git DB API：`blobs`→`trees`→`commits`→`refs` 四步原子 | **无等价 Git DB API**，多文件需多次 contents 调用 | `POST /projects/:id/repository/commits` 带 `actions[]` 数组 |
| 树/Blob | `/repos/{o}/{r}/git/trees` | 无 | `/projects/:id/repository/tree`、`/blobs/:sha` |
| Ref 操作 | `GET/POST/PATCH /repos/{o}/{r}/git/refs` | 无等价低层 refs 端点（用 branches 接口） | `GET/POST /projects/:id/repository/branches` |
| 创建仓库 | `POST /user/repos`、`POST /orgs/{org}/repos` | `POST /user/repos`、`POST /orgs/{org}/repos`、`POST /enterprises/{e}/repos` | `POST /projects` |
| OAuth | Authorization Code + PKCE；GitHub App 优先 | OAuth2 授权码（无 PKCE 文档化主流用法） | OAuth2 + PKCE |

> 关键不对称：**Gitee 缺少 Git DB（trees/blobs/refs/commits）低层 API**。这决定「批量提交」在 GiteeProvider 上只能降级为多次单文件调用或切 isomorphic-git。

## 1. 统一 Provider 接口定义（TypeScript）

```ts
export type ProviderId = 'github' | 'gitee' | 'gitlab' | 'gitea' | 'bitbucket';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RepoInfo {
  id: number | string;
  ref: RepoRef;
  fullName: string;       // "owner/repo"
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  size: number;            // KB
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  raw?: Record<string, unknown>;
}

export interface CreateRepoInput {
  name: string;
  description?: string;
  private?: boolean;
  autoInit?: boolean;
  defaultBranch?: string;
  extra?: Record<string, unknown>;
}

export type FileType = 'file' | 'dir' | 'symlink' | 'submodule';

export interface FileContent {
  path: string;
  name: string;
  type: FileType;
  size: number;
  sha: string;             // blob sha（更新文件必需）
  content?: string;        // base64
  encoding?: 'base64' | 'utf-8' | 'none';
  ref: string;
  raw?: Record<string, unknown>;
}

export interface DirEntry {
  name: string; path: string; type: FileType; sha: string; size: number; mode?: string;
}

export interface TreeEntry {
  path: string;
  mode?: '100644' | '100755' | '040000' | '160000' | '120000';
  type?: 'blob' | 'tree' | 'commit';
  sha?: string;
  content?: string;        // 与 sha 互斥
  base64?: boolean;
}

export interface BatchCommitInput {
  ref: string;
  message: string;
  entries: TreeEntry[];
  baseTreeSha?: string;
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
}

export interface BatchCommitResult {
  commitSha: string; treeSha: string; ref: string; newRefSha: string; filesChanged: number;
}

export interface PageResult<T> { items: T[]; page: number; perPage: number; hasNext: boolean; totalCount?: number; }

export type AuthMethod =
  | { kind: 'pat'; token: string }
  | { kind: 'oauth'; accessToken: string }
  | { kind: 'app'; installationId: number; jwt: string; cachedInstallationToken?: string };

export interface ProviderConfig {
  id: ProviderId;
  baseUrl?: string;
  auth: AuthMethod;
  userAgent: string;
  requestTimeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export interface GitProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  // —— 仓库 CRUD ——
  listRepos(opts?: ListOptions): Promise<PageResult<RepoInfo>>;
  getRepo(ref: RepoRef): Promise<RepoInfo>;
  createRepo(input: CreateRepoInput, owner?: string): Promise<RepoInfo>;
  deleteRepo(ref: RepoRef): Promise<void>;

  // —— 文件读写 ——
  readFile(ref: RepoRef, path: string, opts?: { ref?: string }): Promise<FileContent>;
  writeFile(ref: RepoRef, path: string, content: string, message: string,
            opts?: { ref?: string; sha?: string; base64?: boolean; author?: { name: string; email: string } }): Promise<FileContent>;
  deleteFile(ref: RepoRef, path: string, message: string, opts?: { ref?: string; sha?: string }): Promise<void>;
  listDir(ref: RepoRef, path: string, opts?: { ref?: string }): Promise<DirEntry[]>;

  // —— 批量提交（跨平台能力差异最大） ——
  createCommit(ref: RepoRef, input: BatchCommitInput): Promise<BatchCommitResult>;

  // —— 分支 / Ref ——
  createBranch(ref: RepoRef, branch: string, fromShaOrRef: string): Promise<RefInfo>;
  getRef(ref: RepoRef, refName: string): Promise<RefInfo>;
  updateRef(ref: RepoRef, refName: string, sha: string, opts?: { force?: boolean }): Promise<RefInfo>;

  // —— Git DB（可选能力：Gitee 不支持） ——
  getTree(ref: RepoRef, treeSha: string, opts?: { recursive?: boolean }): Promise<TreeInfo>;
  createBlob(ref: RepoRef, content: string, opts?: { base64?: boolean }): Promise<BlobInfo>;

  // —— 限流与探活 ——
  getRateLimit(): Promise<RateLimitInfo>;
  testAuth(): Promise<{ user: string; scopes: string[] }>;
}

export interface ProviderCapabilities {
  batchCommitViaGitDb: boolean;   // Gitee=false
  supportsTrees: boolean;         // Gitee=false
  supportsBlobs: boolean;         // Gitee=false
  supportsRefUpdate: boolean;     // Gitee=false（仅 branches）
  maxContentBytes: number;        // GitHub 1_000_000
  maxDirEntries: number;          // GitHub 1000
  createRepoSupported: boolean;
  repoNameRequiresExtension: boolean; // Gitee=true
}

export interface RateLimitInfo {
  limit: number; remaining: number; resetAt: string; platform: ProviderId;
}

export type ProviderErrorCode =
  | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED'
  | 'CONFLICT' | 'RESOURCE_NOT_READY' | 'UNSUPPORTED' | 'NETWORK' | 'UNKNOWN';

export class ProviderError extends Error {
  constructor(
    public platform: ProviderId,
    public code: ProviderErrorCode,
    message: string,
    public status?: number,
    public retryAfter?: number,
    public raw?: unknown,
  ) { super(`[${platform}] ${code}: ${message}`); }
}
```

设计要点：
- `RepoRef` 统一 `owner/repo`，GitLabProvider 内部做 `namespace%2Fproject` URL 编码。
- `createCommit` 是「批量」抽象：GitHub 走 blobs→trees→commits→updateRef 四步原子；Gitee `batchCommitViaGitDb=false` 降级为循环 contents + 幂等重试。
- `capabilities` 让上层运行时判断能否走 Git DB 快车道。
- `ProviderError` 带 `retryAfter` 便于令牌桶退避。

## 2. GitHubProvider 与 GiteeProvider 适配要点

### 2.1 GitHubProvider
- 认证：`Authorization: Bearer <token>`；`X-GitHub-Api-Version: 2022-11-28`。
- `writeFile` → `PUT /repos/{o}/{r}/contents/{path}`（create 不传 `sha`，update 必传，冲突 409）。
- `createCommit`（快车道）：`createBlob`×N → `POST /git/trees`（`base_tree`）→ `POST /git/commits`（`parents`）→ `PATCH /git/refs/heads/{branch}`。一次 HTTP 往返完成 N 文件原子提交。
- 分页：解析 `Link` 头，`per_page` 上限 100。
- 推荐 **GitHub App + installation token**：速率限制随仓库数/用户数线性提升（最高 12500/h，企业云 15000/h），不挤占用户个人 5000/h 配额。

### 2.2 GiteeProvider
- 认证：优先 `Authorization: Bearer`；个别端点降级 `access_token` 进 body（禁止默认放 query）。
- **create 用 `POST`，update 用 `PUT`**（与 GitHub 关键差异：GitHub 都用 PUT）。调用方传 `sha` 则 PUT，否则 POST。
- `createCommit`（降级）：逐条调 contents POST/PUT/DELETE，每条一个 commit；`commitSha` 取最后一条，**无法保证原子**（中途失败需幂等重试或回滚清单）。
- `getRef`/`updateRef` → Gitee 无 `git/refs`，映射为 branches 接口；`updateRef` 属 `UNSUPPORTED`，应改用「新分支 + PR」或 isomorphic-git。
- `getTree`/`createBlob` → `UNSUPPORTED`。
- **文件名必须带扩展名**：无扩展名路径抛 `UNSUPPORTED` 或自动补 `.txt`。
- 令牌粒度粗，PAT 默认关联账户全部权限，**务必最小化与轮换**。

### 2.3 核心差异对照表

| 抽象能力 | GitHub | Gitee | 适配策略 |
|---|---|---|---|
| 认证头 | `Authorization: Bearer`（强制） | Bearer 可用，文档以参数为主 | 统一 Bearer 头；Gitee 个别端点降级 body |
| 创建文件方法 | `PUT`（create+update 同端点） | `POST`(create) / `PUT`(update) | Provider 内按 `sha` 有无选方法 |
| 更新文件所需 | `sha`（必传，否则 409/422） | `sha`（必传） | 未传则先 `readFile` 取 `sha` 再回写 |
| 批量原子提交 | ✅ 四步 | ❌ 仅逐文件 | `capabilities.batchCommitViaGitDb` 决定 |
| 树对象 / Blob API | ✅ | ❌ | Gitee 抛 `UNSUPPORTED`，用 `listDir`+`readFile` 模拟 |
| Ref 低层操作 | ✅ | ❌ 仅 branches | Gitee 走「新分支+PR」或 isomorphic-git |
| 文件名扩展名 | 无要求 | **必须带扩展名** | GiteeProvider 校验/补全 |
| 单文件大小 | Contents ≤1MB | 未明确硬限 | 统一 `maxContentBytes`，超限走 isomorphic-git/LFS |
| 分页 | Link 头，30/页 | 响应体，20/页 | 统一 `PageResult` |
| 速率限制 | 5000/h，头规整 | 5000/h，头不规整 | 各自解析；统一退避 |
| 创建仓库 scope | `repo` | 仓库管理权限 | `createRepo` 前调 `testAuth` |
| 删除仓库 scope | 显式 `delete_repo` | 删除权限 | 缺权限抛 `FORBIDDEN` |
| OAuth token → git push | `oauth2format: 'github'` | 无原生 format，用 Basic Auth | isomorphic-git 适配器按平台分支 |

## 3. 「软件里直接创建仓库」可行性评估

**结论：可以，GitHub 与 Gitee 都支持通过 REST API 在软件内直接创建仓库。**

### GitHub
- API：`POST /user/repos`（个人）/ `POST /orgs/{org}/repos`（组织）。
- scope：Classic PAT `repo`；Fine-grained PAT / GitHub App「Administration: write」+「Contents: write」；OAuth App scope `repo`。
- 限制：账户级仓库总数到 50,000 告警；二级速率内容创建 ≤80/min、≤500/h。
- 推荐 `auto_init=true` 生成初始 commit，避免空仓库 ref 操作报错。

### Gitee
- API：`POST /user/repos`（个人）/ `POST /orgs/{org}/repos` / `POST /enterprises/{e}/repos`。
- 权限：token 含仓库管理能力（PAT 默认覆盖）。
- 限制：个人账户有免费私有仓库数量上限；速率 5000/h；`access_token` 放 body 而非 query；`private` 与 `type/visibility` 不要混用。

### 落地建议
1. 建仓前调 `testAuth()` 校验 scope；
2. 优先 GitHub App installation token（速率更高）；
3. 对 Gitee 做私有仓配额预检；
4. 默认 `autoInit=true`；
5. 失败的 `403/422` 区分「配额/命名冲突/scope 不足」给明确提示。

## 4. 两种实现路径取舍

| 维度 | A（REST） | B（isomorphic-git） |
|---|---|---|
| 跨平台一致性 | 低（差异大） | 高（git 协议通用） |
| 批量原子提交 | GitHub/GitLab ✅，Gitee ❌ | 全平台 ✅ |
| 速率友好度 | 中（5000/h，二级限流） | 高（push 6/min/仓，无请求级限流） |
| 大文件支持 | 差（≤1MB Contents） | 好（受 push 2GB 限制） |
| 浏览器可用性 | ✅（CORS 友好） | ❌（需 CORS 代理） |
| 创建/删除仓库 | ✅ | ❌（仍需 REST） |
| 首次延迟 | 低（按需请求） | 高（clone 全量/shallow） |
| 历史完整性 | 仅当前快照 + commit 链 | ✅ 完整 |

## 5. 推荐的混合策略

**以 REST 为主干（元数据 + 单文件 CRUD + GitHub/GitLab 快车道批量），以 isomorphic-git 为可选「批量写后端」与「大文件/跨平台一致性」兜底。**

理由：GitLite 核心是「仓库当数据库」，绝大部分操作是单文件读写、目录列举、偶尔批量提交，REST Contents + Git DB API 覆盖 95% 场景。Gitee 能力缺口（无批量原子）恰是 isomorphic-git 强项：`capabilities.batchCommitViaGitDb=false` 且批量条目 ≥ 阈值（如 ≥5）时自动切 isomorphic-git。

路由决策：

| 操作 | 能力满足时 | 能力不足/超限/大文件时 |
|---|---|---|
| 单文件 read/write/delete | REST Contents | — |
| 批量提交 | `batchCommitViaGitDb=true` → Git DB | 条目多或 Gitee → IsoGit |
| getTree/createBlob | `supportsTrees` | 降级 `listDir`+`readFile` |
| updateRef | `supportsRefUpdate` | 新建分支 + PR / IsoGit |
| createRepo/deleteRepo | REST（唯一） | — |
| 大文件 (>1MB) | LFS 或 IsoGit | IsoGit push |

回退：触发 `RATE_LIMITED` → 读 `retryAfter` 令牌桶排队；队列积压超阈值切 IsoGit。IsoGit push non-fast-forward → fetch+rebase 重试，最多 N 次。

## 6. Provider 注册与自动发现

```ts
export interface ProviderFactory {
  id: ProviderId;
  create: (config: ProviderConfig) => GitProvider;
  detect: (input: { url?: string; token?: string; hint?: string }) => ProviderId | null;
  capabilities: ProviderCapabilities;
}
```

自动发现信号（优先级递减）：
1. URL host：`github.com`→github；`gitee.com`→gitee；`gitlab.com` 或 `/api/v4/projects`→gitlab。
2. token 前缀：`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`→github；`glpat-`→gitlab；Gitee 无前缀作回退。
3. 配置 hint：用户显式选默认平台。

生命周期：贴 URL/Token → detect → create(config) → testAuth → getRateLimit → 写入配置 → 后续业务调用。

## 7. 落地优先级

1. **MVP**：`GitHubProvider` + `GiteeProvider` REST 后端，覆盖 listRepos/createRepo/getRepo/deleteRepo/readFile/writeFile/listDir/deleteFile/createBranch/getRef；`createCommit` GitHub 走 Git DB 快车道、Gitee 逐文件降级。
2. **第二步**：补 `getTree/createBlob/updateRef`（GitHub），`capabilities` 正确暴露；UI 提示 Gitee 不支持的能力。
3. **第三步**：引入 `IsoGitBackend` 作「批量写后端」与「大文件」兜底，浏览器配套 CORS 代理。
4. **后续**：基于同一接口加 `GitLabProvider`、`GiteaProvider`。
