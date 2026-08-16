// @gitlite/sdk：connect（URI/对象）、initDB（headless 幂等）、databases、profiles
import {
  Collection, ForeignRepoError, GitHubProvider, GiteeProvider, GitLiteClient, MemoryProvider,
  deviceFlowLogin, exchangeGiteeCode, giteeAuthorizeUrl, resolveGiteeClientId, resolveGiteeClientSecret,
  SYS, type GitProvider, type RepoRef, type SyncPolicy, POLICIES
} from '@gitlite/core';
import { createNodeRuntime, createNodeSqlite, waitForRedirect } from '@gitlite/adapters-node';
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
    emit?.('reconnect', { bindingsPath: BINDINGS_PATH });
    const saved = JSON.parse(await runtime.fs.readFile(BINDINGS_PATH));
    return connect({ ...saved, runtime, providerInstance: input?.providerInstance, onProgress: emit });
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

  // github：无 token 则 Device Flow 登录（弹码/开浏览器由 onLoginCode 宿主处理）
  if (opts.provider === 'github' && !opts.token && !opts.profile) {
    emit?.('login', { flow: 'device' });
    opts.token = await interactiveLogin(runtime, input?.onLoginCode);
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
  const { provider, owner, repo, database, profile } = opts;
  await runtime.fs.writeFile(BINDINGS_PATH, JSON.stringify({ provider, owner, repo, database, profile }, null, 2));
  return client;
}

/** GitHub Device Flow 登录 → token 存凭据库（B1/B3），返回裸 token */
export async function interactiveLogin(
  runtime: RuntimeAdapter,
  onCode?: (code: string, uri: string) => void
): Promise<string> {
  const { token } = await deviceFlowLogin(runtime.fetch, {
    onCode: onCode ?? ((code, uri) => {
      console.log(`[gitlite] 打开 ${uri} 并输入代码: ${code}`);
    })
  });
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
  runtime?: RuntimeAdapter;
  /** 换 token 用的 fetch（缺省 runtime.fetch；测试注入） */
  fetchFn?: typeof fetch;
  onCode?: (url: string, info: { port: number; state: string }) => void;
}): Promise<string> {
  const runtime = opts?.runtime ?? createNodeRuntime();
  const clientId = opts?.clientId ?? resolveGiteeClientId();
  const clientSecret = opts?.clientSecret ?? resolveGiteeClientSecret();
  let state = '';
  const receiver = waitForRedirect({
    port: opts?.port,
    onListening: port => {
      const redirectUri = `http://127.0.0.1:${port}/callback`;
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
  return isGitee ? new GiteeProvider(token, runtime.fetch) : new GitHubProvider(token, runtime.fetch);
}

export { GitLiteClient, MemoryProvider, GitHubProvider, GiteeProvider, Collection, POLICIES, SYS };
export type { GitProvider, SyncPolicy, RuntimeAdapter };
