// @gitlite/sdk：connect（URI/对象）、initDB（headless 幂等）、databases、profiles
import {
  ForeignRepoError, GitHubProvider, GitLiteClient, MemoryProvider,
  deviceFlowLogin, SYS, type GitProvider, type RepoRef, type SyncPolicy, POLICIES
} from '@gitlite/core';
import { createNodeRuntime } from '@gitlite/adapters-node';
import type { RuntimeAdapter } from '@gitlite/core';

export interface SdkConnectOptions {
  provider: 'github' | 'memory';
  owner: string;
  repo?: string;             // 缺省 gitlite-repo（A2 默认仓库）
  database?: string;         // 缺省 default（gitlite/default 分支）
  token?: string;            // PAT（B2）
  profile?: string;          // 凭据键 gitlite:github:<profile>
  policy?: SyncPolicy | 'economy' | 'balanced' | 'realtime';
  runtime?: RuntimeAdapter;
  queuePath?: string;
  allowForeignRepo?: boolean;
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
  const runtime = opts.runtime ?? createNodeRuntime();
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

// ---------- databases（分支模式库管理，FR C1）----------

export const databases = {
  async create(name: string, ctx: { owner: string; token?: string; repo?: string; runtime?: RuntimeAdapter }): Promise<void> {
    const provider = new GitHubProvider(ctx.token ?? '', globalThis.fetch);
    const ref = { owner: ctx.owner, repo: ctx.repo ?? 'gitlite-repo' };
    await ensureRepo(provider, ref);
    const mainHead = await provider.getHead(ref, 'main');
    await provider.createBranch(ref, `${SYS.dbBranchPrefix}${name}`, mainHead ? 'main' : 'main');
  },

  async list(ctx: { owner: string; token?: string; repo?: string }): Promise<string[]> {
    const provider = new GitHubProvider(ctx.token ?? '', globalThis.fetch);
    const branches = await provider.listBranches({ owner: ctx.owner, repo: ctx.repo ?? 'gitlite-repo' });
    return branches
      .filter(b => b.startsWith(SYS.dbBranchPrefix))
      .map(b => b.slice(SYS.dbBranchPrefix.length));
  },

  async drop(name: string, ctx: { owner: string; token?: string; repo?: string }): Promise<void> {
    // GitHub REST：DELETE /repos/{o}/{r}/git/refs/heads/<branch>（v0.1 经 provider 通用接口暂缺，SDK 直调）
    const provider = new GitHubProvider(ctx.token ?? '', globalThis.fetch);
    const ref = { owner: ctx.owner, repo: ctx.repo ?? 'gitlite-repo' };
    // 简化：通过 createBranch 幂等 + commit 空? —— v0.1 诚实降级：抛未实现，列入 M9 待办
    void provider; void ref;
    throw new Error('databases.drop: branch deletion lands with provider.deleteBranch in M9 (tracked)');
  }
};

async function ensureRepo(provider: GitProvider, ref: RepoRef): Promise<void> {
  const existing = await provider.getRepo(ref);
  if (!existing) await provider.createRepo(ref, { private: true, autoInit: true });
}

async function buildProvider(opts: SdkConnectOptions, runtime: RuntimeAdapter): Promise<GitProvider> {
  if (opts.providerInstance) return opts.providerInstance;
  if (opts.provider === 'memory') return new MemoryProvider();
  const token = opts.token
    ?? (opts.profile
        ? await runtime.credential.get(`${CRED_PREFIX}:${opts.profile}`)
        : await runtime.credential.get(`${CRED_PREFIX}:default`));
  if (!token) throw new Error('no github token: pass token, login first, or set profile');
  return new GitHubProvider(token, runtime.fetch);
}

export { GitLiteClient, MemoryProvider, GitHubProvider, POLICIES, SYS };
export type { GitProvider, SyncPolicy, RuntimeAdapter };
