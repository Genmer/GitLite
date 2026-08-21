import {
  Collection, ForeignRepoError, GitHubProvider, GiteeProvider, GitLiteClient, MemoryProvider,
  deviceFlowLogin, exchangeGiteeCode, giteeAuthorizeUrl, resolveGiteeClientId, resolveGiteeClientSecret,
  GITLITE_GITHUB_CLIENT_ID, GITLITE_GITEE_CLIENT_ID,
  IndexedDbFsAdapter, IndexedDbCredentialStore, createBrowserRuntime, type BrowserRuntimeOptions,
  GitLiteError, ValidationError, UniqueConstraintError, NotFoundError, ConflictError,
  QuotaExceededError, RateLimitError, AuthError, NetworkError, FormatVersionError, OAuthAppNotConfiguredError,
  SYS, type GitProvider, type RepoRef, type SyncPolicy, type SyncState, POLICIES, type SqliteAdapterFactory, type SqliteDb
} from '@gitlite/core';
import {
  createNodeRuntime, createNodeSqlite, waitForRedirect, GITLITE_LOOPBACK_PORT, renderOAuthSuccessHtml,
  createOsCredentialStore, FileCredentialStore, type Runner, type ExecResult
} from '@gitlite/adapters-node';

import { getOAuthApp } from './app-config.js';
export * from './app-config.js';
import type { RuntimeAdapter } from '@gitlite/core';

export interface SdkConnectOptions {
  provider: 'github' | 'gitee' | 'memory';
  owner: string;
  repo?: string;             // 缺省 gitlite-repo（A2 默认仓库）
  database?: string;         // 缺省 default（gitlite/default 分支）
  token?: string;            // PAT（B2）
  profile?: string;          // 凭据键 gitlite:github:<profile>
  policy?: SyncPolicy | 'economy' | 'balanced' | 'realtime';
  runtime?: RuntimeAdapter;
  queuePath?: string;
  allowForeignRepo?: boolean;
  /** 索引后端（P4）：'memory'（默认）/ 'sqlite'（本地缓存 ~/.gitlite/cache/<指纹>/index.db） */
  indexBackend?: 'memory' | 'sqlite';
  /** 自定义 API 代理基地址（用于 Cloudflare Worker / Vite Proxy / 本地网关） */
  baseUrl?: string;
  /** 初始化后是否自动拉取远端最新状态（默认 true） */
  autoPullOnInit?: boolean;
  /** 高级：直接注入 Provider 实例（嵌入/测试/演示共用同一"远端"） */
  providerInstance?: GitProvider;
  /** 初始化进度回调（自建向导 UI 用；步骤见 core ConnectStep） */
  onProgress?: (step: string, detail?: any) => void;
}

const BINDINGS_PATH = '~/.gitlite/bindings.json';
const CRED_PREFIX = 'gitlite:github';

export function parseUri(uri: string): SdkConnectOptions {
  const m = /^gitlite:\/\/([^:]+):([^@]+)@([^/]+)\/([^/?]+)(?:\/([^/?#]+))?/.exec(uri);
  if (!m) throw new Error(`invalid gitlite uri: ${uri}`);
  const [, provider, auth, owner, repo, database] = m;
  const a = auth!;
  const opts: SdkConnectOptions = {
    provider: provider as any, owner: owner!, repo: repo!, database
  };
  if (a.startsWith('pat-') || a.length > 40) opts.token = a;
  else opts.profile = a;
  return opts;
}

export async function connect(input: SdkConnectOptions | string): Promise<GitLiteClient> {
  const opts = typeof input === 'string' ? parseUri(input) : input;
  let runtime = opts.runtime ?? createNodeRuntime();
  // P4：sqlite 索引后端且宿主未注入 sqlite 能力 → 自动接 node:sqlite（不可用则 create 报清晰错误）
  if (opts.indexBackend === 'sqlite' && !runtime.sqlite) {
    const sqlite = createNodeSqlite();
    if (sqlite) runtime = { ...runtime, sqlite };
  }
  const provider = await buildProvider(opts, runtime);
  const ref: RepoRef = { owner: opts.owner, repo: opts.repo ?? 'gitlite-repo' };
  const policy: SyncPolicy = typeof opts.policy === 'string' || !opts.policy
    ? POLICIES[(opts.policy as keyof typeof POLICIES) ?? 'economy']
    : opts.policy;
  return GitLiteClient.create({
    provider, runtime, ref,
    database: opts.database,
    policy,
    allowForeignRepo: opts.allowForeignRepo,
    indexBackend: opts.indexBackend,
    autoPullOnInit: opts.autoPullOnInit,
    onProgress: opts.onProgress as any
  });
}

/** initDB（FR A1）：幂等——已有 bindings 静默直连；否则自动「登录→识别身份→建仓」并落 bindings */
export async function initDB(
  input?: Partial<SdkConnectOptions> & {
    force?: boolean;
    /** Device Flow 登录码回调（页面显示 user_code / 自动打开浏览器由宿主决定） */
    onLoginCode?: (code: string, uri: string) => void;
  }
): Promise<GitLiteClient> {
  const runtime = input?.runtime ?? createNodeRuntime();
  const emit = input?.onProgress;
  if (!input?.force && await runtime.fs.exists(BINDINGS_PATH)) {
    try {
      const saved = JSON.parse(await runtime.fs.readFile(BINDINGS_PATH));
      // 校验：旧记录非 memory 且请求 provider 与旧记录一致（或未传 provider）时复用
      if (saved && saved.provider && saved.provider !== 'memory' && (!input?.provider || input.provider === saved.provider)) {
        emit?.('reconnect', { bindingsPath: BINDINGS_PATH });
        const database = input?.database ?? saved.database;
        const repo = input?.repo ?? saved.repo;
        return connect({ ...saved, ...input, database, repo, runtime, providerInstance: input?.providerInstance, onProgress: emit });
      }
    } catch {
      // 损坏的 bindings 文件忽略并重新走初始化
    }
  }
  emit?.('start');
  const opts: SdkConnectOptions = {
    provider: input?.provider ?? 'github',
    owner: input?.owner ?? '',
    repo: input?.repo ?? 'gitlite-repo',
    database: input?.database ?? 'default',
    token: input?.token,
    profile: input?.profile,
    policy: input?.policy ?? 'economy',
    runtime,
    providerInstance: input?.providerInstance,
    onProgress: emit
  };

  // github：无 token 先检查凭据库缓存，若无才走 Device Flow 交互登录
  if (opts.provider === 'github' && !opts.token && !opts.providerInstance) {
    const credKey = opts.profile ? `${CRED_PREFIX}:${opts.profile}` : `${CRED_PREFIX}:default`;
    const cached = await runtime.credential.get(credKey).catch(() => null);
    if (cached) {
      opts.token = cached;
    } else {
      emit?.('login', { flow: 'device' });
      opts.token = await interactiveLogin(runtime, input?.onLoginCode);
    }
  }

  // gitee：无 token 先检查凭据库缓存，若无才走 Gitee OAuth loopback 交互登录
  if (opts.provider === 'gitee' && !opts.token && !opts.providerInstance) {
    const credKey = opts.profile ? `gitlite:gitee:${opts.profile}` : `gitlite:gitee:default`;
    const cached = await runtime.credential.get(credKey).catch(() => null);
    if (cached) {
      opts.token = cached;
    } else {
      emit?.('login', { flow: 'oauth' });
      opts.token = await giteeLogin({
        runtime,
        onCode: url => {
          if (input?.onLoginCode) input.onLoginCode(url, url);
          else console.log(`[gitlite] 浏览器打开并授权: ${url}`);
        }
      });
    }
  }

  // 模式 B 核心：登录后自动识别 owner（调 GET /user），用户无需手填用户名
  if (!opts.owner) {
    const provider = await buildProvider(opts, runtime);
    if (!provider.getUser) {
      throw new Error('initDB: owner required (provider cannot resolve current user)');
    }
    const { login } = await provider.getUser();
    opts.owner = login;
    emit?.('identity', { login });
  }

  let client: GitLiteClient;
  try {
    client = await connect(opts);
  } catch (e) {
    if (e instanceof ForeignRepoError && input?.allowForeignRepo) {
      client = await connect({ ...opts, allowForeignRepo: true });
    } else throw e;
  }
  // memory 临时模式不落盘 bindings.json；真实 provider 成功后持久化
  if (opts.provider !== 'memory') {
    const { provider, owner, repo, database, profile } = opts;
    await runtime.fs.writeFile(BINDINGS_PATH, JSON.stringify({ provider, owner, repo, database, profile }, null, 2));
  }
  return client;
}

/** GitHub Device Flow 登录 → token 存凭据库（B1/B3），返回裸 token。
 *  clientId 解析顺序：显式参数 > 环境变量 > ~/.gitlite/app-config.json（引导配置模块写入）> core 占位 */
export async function interactiveLogin(
  runtime: RuntimeAdapter,
  onCode?: (code: string, uri: string) => void,
  opts?: { clientId?: string }
): Promise<string> {
  const configured = (await getOAuthApp(runtime, 'github')).clientId;
  const envId = process.env.GITLITE_DEVICE_CLIENT_ID ?? process.env.GITLITE_CLIENT_ID;
  const clientId = opts?.clientId
    ?? (envId !== GITLITE_GITHUB_CLIENT_ID ? envId : undefined)
    ?? configured;
  if (!clientId || clientId === GITLITE_GITHUB_CLIENT_ID || clientId === 'gitlite-placeholder') {
    throw new OAuthAppNotConfiguredError('github');
  }
  const { token } = await deviceFlowLogin(runtime.fetch, {
    onCode: onCode ?? ((code, uri) => {
      console.log(`[gitlite] 打开 ${uri} 并输入代码: ${code}`);
    })
  }, { clientId });
  await runtime.credential.set(`${CRED_PREFIX}:default`, token);
  return token;
}

/** Gitee OAuth2 授权码 + loopback 登录（docs/04）：开本地回调 → 弹授权 URL → 换 token → 存凭据库。
 *  port=0 用随机端口（测试）；生产用固定端口（OAuth App 预注册回调）。
 *  @returns access_token（已存 gitlite:gitee:default） */
export async function giteeLogin(opts?: {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  port?: number;
  host?: string;
  redirectUrl?: string;
  runtime?: RuntimeAdapter;
  /** 换 token 用的 fetch（缺省 runtime.fetch；测试注入） */
  fetchFn?: typeof fetch;
  onCode?: (url: string, info: { port: number; state: string }) => void;
  /** 取消信号：中止即关闭 loopback 接收器（重试前取消旧登录，防端口占用） */
  signal?: AbortSignal;
}): Promise<string> {
  const runtime = opts?.runtime ?? createNodeRuntime();
  const configured = await getOAuthApp(runtime, 'gitee');
  const envId = resolveGiteeClientId();
  const clientId = opts?.clientId
    ?? (envId !== GITLITE_GITEE_CLIENT_ID && envId !== 'gitlite-placeholder' ? envId : undefined)
    ?? configured.clientId;
  if (!clientId || clientId === GITLITE_GITEE_CLIENT_ID || clientId === 'gitlite-placeholder') {
    throw new OAuthAppNotConfiguredError('gitee');
  }
  const clientSecret = opts?.clientSecret ?? resolveGiteeClientSecret() ?? configured.clientSecret;

  let state = '';
  const receiver = waitForRedirect({
    port: opts?.port,
    host: opts?.host,
    redirectUrl: opts?.redirectUrl,
    signal: opts?.signal,
    onListening: port => {
      const redirectHost = opts?.host ?? '127.0.0.1';
      const redirectUri = `http://${redirectHost}:${port}/callback`;
      state = Array.from(runtime.crypto.randomBytes(16), b => b.toString(16).padStart(2, '0')).join('');
      const url = giteeAuthorizeUrl({
        clientId, redirectUri, state,
        scope: opts?.scope ?? 'projects user_info'
      });
      (opts?.onCode ?? ((u: string) => console.log(`[gitlite] 浏览器打开并授权: ${u}`)))(url, { port, state });
    }
  });
  const { url: redirected } = await receiver;
  const q = redirected.searchParams;
  if (state && q.get('state') !== state) {
    throw new Error('gitee oauth state mismatch (possible CSRF)');
  }
  const code = q.get('code');
  if (!code) throw new Error(`gitee oauth denied: ${q.get('error') ?? 'no code in callback'}`);
  const redirectUri = `http://127.0.0.1:${redirected.port}/callback`;
  const { accessToken } = await exchangeGiteeCode(opts?.fetchFn ?? runtime.fetch, {
    clientId, clientSecret, code, redirectUri
  });
  await runtime.credential.set('gitlite:gitee:default', accessToken);
  return accessToken;
}

// ---------- databases（分支模式库管理，FR C1）----------

/** data-plane provider 构造（github 默认；gitee 走 Contents 降级，token 必传） */
function dataPlaneProvider(ctx: { provider?: 'github' | 'gitee'; token?: string }, fetchImpl: typeof fetch): GitProvider {
  return ctx.provider === 'gitee'
    ? new GiteeProvider(ctx.token ?? '', fetchImpl)
    : new GitHubProvider(ctx.token ?? '', fetchImpl);
}

export const databases = {
  async create(name: string, ctx: { owner: string; token?: string; repo?: string; provider?: 'github' | 'gitee' }): Promise<void> {
    const provider = dataPlaneProvider(ctx, globalThis.fetch);
    const ref = { owner: ctx.owner, repo: ctx.repo ?? 'gitlite-repo' };
    await ensureRepo(provider, ref);
    const mainHead = await provider.getHead(ref, 'main');
    await provider.createBranch(ref, `${SYS.dbBranchPrefix}${name}`, mainHead ? 'main' : 'main');
  },

  async list(ctx: { owner: string; token?: string; repo?: string; provider?: 'github' | 'gitee' }): Promise<string[]> {
    const provider = dataPlaneProvider(ctx, globalThis.fetch);
    const branches = await provider.listBranches({ owner: ctx.owner, repo: ctx.repo ?? 'gitlite-repo' });
    return branches
      .filter(b => b.startsWith(SYS.dbBranchPrefix))
      .map(b => b.slice(SYS.dbBranchPrefix.length));
  },

  async drop(name: string, ctx: { owner: string; token?: string; repo?: string; provider?: 'github' | 'gitee' }): Promise<void> {
    const provider = dataPlaneProvider(ctx, globalThis.fetch);
    if (!provider.deleteBranch) {
      throw new Error('databases.drop: provider does not support branch deletion');
    }
    await provider.deleteBranch(
      { owner: ctx.owner, repo: ctx.repo ?? 'gitlite-repo' },
      `${SYS.dbBranchPrefix}${name}`
    );
  }
};

async function ensureRepo(provider: GitProvider, ref: RepoRef): Promise<void> {
  const existing = await provider.getRepo(ref);
  if (!existing) await provider.createRepo(ref, { private: true, autoInit: true });
}

async function buildProvider(opts: SdkConnectOptions, runtime: RuntimeAdapter): Promise<GitProvider> {
  if (opts.providerInstance) return opts.providerInstance;
  if (opts.provider === 'memory') return new MemoryProvider();
  const isGitee = opts.provider === 'gitee';
  const prefix = isGitee ? 'gitlite:gitee' : CRED_PREFIX;
  const token = opts.token
    ?? (opts.profile
        ? await runtime.credential.get(`${prefix}:${opts.profile}`)
        : await runtime.credential.get(`${prefix}:default`));
  if (!token) throw new Error(`no ${opts.provider} token: pass token, login first, or set profile`);
  return isGitee
    ? new GiteeProvider(token, runtime.fetch, opts.baseUrl ? { baseUrl: opts.baseUrl } : undefined)
    : new GitHubProvider(token, runtime.fetch, opts.baseUrl ? { baseUrl: opts.baseUrl } : undefined);
}

// 统一导出适配器与核心能力
export {
  GitLiteClient, MemoryProvider, GitHubProvider, GiteeProvider, Collection, POLICIES, SYS,
  GITLITE_GITHUB_CLIENT_ID, GITLITE_GITEE_CLIENT_ID,
  IndexedDbFsAdapter, IndexedDbCredentialStore, createBrowserRuntime,
  createNodeRuntime, createNodeSqlite, waitForRedirect, GITLITE_LOOPBACK_PORT, renderOAuthSuccessHtml,
  createOsCredentialStore, FileCredentialStore,
  GitLiteError, ValidationError, UniqueConstraintError, NotFoundError, ConflictError,
  QuotaExceededError, RateLimitError, AuthError, NetworkError, FormatVersionError, OAuthAppNotConfiguredError
};

export type { GitProvider, SyncPolicy, SyncState, RuntimeAdapter, Runner, ExecResult, SqliteAdapterFactory, SqliteDb, BrowserRuntimeOptions };
