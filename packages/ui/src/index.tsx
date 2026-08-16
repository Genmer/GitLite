// @gitlite/ui（docs/04/09）：内置向导 GitLiteWizard——选平台 → 登录 → 身份/仓库 → 连接。
// GitLiteSetup（引导配置模块）——环境检测 → OAuth 应用登记引导 / PAT 粘贴校验 → 进入连接向导。
// flows 可注入：默认 nodeFlows/nodeSetupFlows 走 sdk + adapters-node（桌面/Electron 宿主）；
// 浏览器宿主注入自己的 flows（避免打包 node 内置）。
import { useEffect, useState } from 'react';
import { connect as sdkConnect, interactiveLogin, giteeLogin, saveOAuthApp, authStatus } from '@gitlite/sdk';
import type { GitLiteClient, RuntimeAdapter } from '@gitlite/sdk';
import { GitHubProvider, GiteeProvider } from '@gitlite/core';
import { createNodeRuntime } from '@gitlite/adapters-node';

export type WizardStep = 'provider' | 'login' | 'config' | 'connecting' | 'done' | 'error';
export type WizardProvider = 'github' | 'gitee';

export interface WizardFlows {
  /** 登录：onCode 展示验证码/授权 URL；返回 token */
  login(provider: WizardProvider, onCode: (info: string) => void): Promise<string>;
  /** 用 token 识别 owner（无法识别返回 null，用户手填） */
  identity(provider: WizardProvider, token: string): Promise<string | null>;
  /** 建立连接 */
  connect(provider: WizardProvider, opts: {
    token: string; owner: string; repo: string; database: string;
    onProgress: (step: string) => void;
  }): Promise<GitLiteClient>;
}

/** 默认流程（Node/桌面宿主）：GitHub Device Flow / Gitee OAuth loopback + sdk connect */
export const nodeFlows: WizardFlows = {
  async login(provider, onCode) {
    const runtime = createNodeRuntime();
    if (provider === 'gitee') {
      return await giteeLogin({ runtime, onCode: url => onCode(`浏览器打开并授权: ${url}`) });
    }
    return await interactiveLogin(runtime, (code, uri) => onCode(`打开 ${uri} 输入代码: ${code}`));
  },
  async identity(provider, token) {
    const p = provider === 'gitee'
      ? new GiteeProvider(token, globalThis.fetch)
      : new GitHubProvider(token, globalThis.fetch);
    try {
      if (!p.getUser) return null;
      return (await p.getUser()).login;
    } catch {
      return null;
    }
  },
  async connect(provider, { token, owner, repo, database, onProgress }) {
    return await sdkConnect({ provider, token, owner, repo, database, onProgress: onProgress as any });
  }
};

const STEP_LABELS: Record<string, string> = {
  'probe-repo': '探测仓库…', 'create-repo': '创建仓库…',
  'probe-branch': '探测分支…', 'create-branch': '创建分支…',
  'check-repo': '检查仓库…', 'startup': '启动同步…', 'ready': '就绪'
};

export function GitLiteWizard(props: {
  onReady: (db: GitLiteClient) => void;
  flows?: WizardFlows;
  database?: string;
  /** 已有 token（如 PAT / 引导配置模块已校验）→ 跳过选平台与登录，直接仓库配置 */
  initialProvider?: WizardProvider;
  initialToken?: string;
  initialOwner?: string;
}) {
  const flows = props.flows ?? nodeFlows;
  const [step, setStep] = useState<WizardStep>(
    props.initialToken ? 'config' : props.initialProvider ? 'login' : 'provider'
  );
  const [provider, setProvider] = useState<WizardProvider>(props.initialProvider ?? 'github');
  const [token, setToken] = useState(props.initialToken ?? '');
  const [owner, setOwner] = useState(props.initialOwner ?? '');
  const [repo, setRepo] = useState('gitlite-repo');
  const [hint, setHint] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const choose = (p: WizardProvider): void => {
    setProvider(p);
    setStep('login');
  };

  const doLogin = async (): Promise<void> => {
    setError('');
    setHint('登录中…');
    try {
      const t = await flows.login(provider, info => setHint(info));
      setToken(t);
      const login = await flows.identity(provider, t).catch(() => null);
      if (login) setOwner(login);
      setStep('config');
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setStep('error');
    }
  };

  const doConnect = async (): Promise<void> => {
    if (!owner.trim()) { setError('owner 不能为空'); setStep('error'); return; }
    setStep('connecting');
    try {
      const db = await flows.connect(provider, {
        token, owner: owner.trim(), repo: repo.trim() || 'gitlite-repo',
        database: props.database ?? 'default',
        onProgress: s => setProgress(STEP_LABELS[s] ?? s)
      });
      setStep('done');
      props.onReady(db);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setStep('error');
    }
  };

  switch (step) {
    case 'provider':
      return (
        <div data-testid="wizard-provider">
          <h3>选择平台</h3>
          <button onClick={() => choose('github')}>GitHub</button>
          <button onClick={() => choose('gitee')}>Gitee</button>
        </div>
      );
    case 'login':
      return (
        <div data-testid="wizard-login">
          <h3>登录 {provider === 'github' ? 'GitHub' : 'Gitee'}</h3>
          {hint && <p data-testid="wizard-hint">{hint}</p>}
          <button onClick={() => void doLogin()}>登录</button>
          <button onClick={() => setStep('provider')}>返回</button>
        </div>
      );
    case 'config':
      return (
        <div data-testid="wizard-config">
          <h3>仓库配置</h3>
          <label>owner <input value={owner} onChange={e => setOwner(e.target.value)} data-testid="wizard-owner" /></label>
          <label>repo <input value={repo} onChange={e => setRepo(e.target.value)} data-testid="wizard-repo" /></label>
          <button data-testid="wizard-connect" onClick={() => void doConnect()}>连接</button>
        </div>
      );
    case 'connecting':
      return <div data-testid="wizard-connecting">连接中…{progress && <p>{progress}</p>}</div>;
    case 'done':
      return <div data-testid="wizard-done">✓ 连接成功</div>;
    case 'error':
      return (
        <div data-testid="wizard-error">
          <h3>出错了</h3>
          <p>{error}</p>
          <button onClick={() => setStep(token ? 'config' : 'login')}>重试</button>
        </div>
      );
  }
}

// ---------- 引导配置模块（GitLiteSetup）：检测 → OAuth 登记/PAT → 连接 ----------

export interface SetupFlows extends WizardFlows {
  /** 环境检测：两平台各自就绪状态（OAuth 应用是否登记 / 是否已有 token） */
  detect(): Promise<Record<WizardProvider, { oauthApp: boolean; token: boolean }>>;
  /** 保存 OAuth 应用凭据（登记一次全机生效，~/.gitlite/app-config.json） */
  saveOAuth(provider: WizardProvider, creds: { clientId: string; clientSecret?: string }): Promise<void>;
  /** PAT：getUser 校验 → 存凭据库；返回 owner；校验失败抛错 */
  savePat(provider: WizardProvider, token: string): Promise<string>;
}

/** 默认引导流程（Node/桌面宿主） */
export const nodeSetupFlows: SetupFlows = {
  ...nodeFlows,
  async detect() {
    return await authStatus(createNodeRuntime()) as any;
  },
  async saveOAuth(provider, creds) {
    await saveOAuthApp(createNodeRuntime(), provider, creds);
  },
  async savePat(provider, token) {
    const p = provider === 'gitee'
      ? new GiteeProvider(token, globalThis.fetch)
      : new GitHubProvider(token, globalThis.fetch);
    const { login } = await p.getUser!(); // 校验失败自然抛错（UI 显示）
    const runtime = createNodeRuntime();
    await runtime.credential.set(`gitlite:${provider}:default`, token);
    return login;
  }
};

const OAUTH_GUIDE: Record<WizardProvider, {
  registerUrl: string; callback: string; callbackCopyable: boolean; scopes: string; tokenUrl: string;
}> = {
  github: {
    registerUrl: 'https://github.com/settings/applications/new',
    callback: 'http://localhost（Device Flow 不使用回调地址，可随意填）',
    callbackCopyable: false,
    scopes: '无需勾选权限；创建后进入应用详情页勾选 Enable Device Flow',
    tokenUrl: 'https://github.com/settings/tokens/new'
  },
  gitee: {
    registerUrl: 'https://gitee.com/oauth/applications/new',
    callback: 'http://127.0.0.1:18365/callback',
    callbackCopyable: true,
    scopes: '权限勾选 projects 与 user_info',
    tokenUrl: 'https://gitee.com/profile/personal_access_tokens/new'
  }
};

export function GitLiteSetup(props: {
  onReady: (db: GitLiteClient) => void;
  flows?: SetupFlows;
  database?: string;
}) {
  const flows = props.flows ?? nodeSetupFlows;
  const [phase, setPhase] = useState<'detecting' | 'choose' | 'oauth' | 'pat' | 'wizard' | 'error'>('detecting');
  const [status, setStatus] = useState<Record<WizardProvider, { oauthApp: boolean; token: boolean }> | null>(null);
  const [provider, setProvider] = useState<WizardProvider>('github');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [pat, setPat] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  /** 出错前所在步：错误页「返回」回到来源表单（而非总回选择页） */
  const [backTo, setBackTo] = useState<'choose' | 'oauth' | 'pat'>('choose');
  const [wizardInit, setWizardInit] = useState<{ provider?: WizardProvider; token?: string; owner?: string }>({});

  const fail = (msg: string, from: 'choose' | 'oauth' | 'pat'): void => {
    setError(msg);
    setBackTo(from);
    setPhase('error');
  };

  const refresh = async (): Promise<void> => {
    setPhase('detecting');
    try {
      setStatus(await flows.detect());
      setPhase('choose');
    } catch (e: any) {
      fail(String(e?.message ?? e), 'choose');
    }
  };
  useEffect(() => { void refresh(); }, []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(OAUTH_GUIDE[provider].callback);
      setCopied(true);
    } catch { /* 无剪贴板权限：地址已完整展示，可手动选择 */ }
  };

  const saveOauth = async (): Promise<void> => {
    if (!clientId.trim()) { fail('Client ID 不能为空', 'oauth'); return; }
    try {
      await flows.saveOAuth(provider, { clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined });
      setWizardInit({ provider });
      await refresh();
      setPhase('wizard');
    } catch (e: any) {
      fail(String(e?.message ?? e), 'oauth');
    }
  };

  const savePatFlow = async (): Promise<void> => {
    if (!pat.trim()) { fail('令牌不能为空', 'pat'); return; }
    try {
      const owner = await flows.savePat(provider, pat.trim());
      setWizardInit({ provider, token: pat.trim(), owner });
      await refresh();
      setPhase('wizard');
    } catch (e: any) {
      fail(`令牌校验失败：${e?.message ?? e}`, 'pat');
    }
  };

  const badge = (ok: boolean, label: string) => (
    <span>{ok ? '✅' : '⬜'} {label}</span>
  );

  switch (phase) {
    case 'detecting':
      return <div data-testid="setup-detecting">正在检测本机配置…</div>;
    case 'choose':
      return (
        <div data-testid="setup-choose">
          <h3>引导配置</h3>
          {(['github', 'gitee'] as const).map(p => (
            <div key={p} data-testid={`setup-status-${p}`}>
              <b>{p === 'github' ? 'GitHub' : 'Gitee'}</b>
              {status && <>　{badge(status[p].oauthApp, 'OAuth 应用已登记')}　{badge(status[p].token, '已登录')}</>}
              <button data-testid={`setup-oauth-${p}`} onClick={() => { setProvider(p); setClientId(''); setClientSecret(''); setCopied(false); setPhase('oauth'); }}>登记 OAuth 应用</button>
              <button data-testid={`setup-pat-${p}`} onClick={() => { setProvider(p); setPat(''); setPhase('pat'); }}>使用私人令牌</button>
            </div>
          ))}
          <button data-testid="setup-skip" onClick={() => { setWizardInit({}); setPhase('wizard'); }}>
            跳过，直接连接（已登录过）
          </button>
        </div>
      );
    case 'oauth':
      return (
        <div data-testid="setup-oauth">
          <h3>登记 {provider === 'github' ? 'GitHub' : 'Gitee'} OAuth 应用（约 1 分钟，一次即可）</h3>
          <ol>
            <li>
              打开注册页：
              <a href={OAUTH_GUIDE[provider].registerUrl} target="_blank" rel="noreferrer" data-testid="setup-register-link">
                {OAUTH_GUIDE[provider].registerUrl}
              </a>
            </li>
            <li>
              回调地址：{OAUTH_GUIDE[provider].callback}
              {OAUTH_GUIDE[provider].callbackCopyable && (
                <button data-testid="setup-copy" onClick={() => void copy()}>{copied ? '✓ 已复制' : '复制'}</button>
              )}
            </li>
            <li>{OAUTH_GUIDE[provider].scopes}</li>
            <li>创建后把凭据粘贴到下面并保存</li>
          </ol>
          <label>Client ID <input data-testid="setup-client-id" value={clientId} onChange={e => setClientId(e.target.value)} /></label>
          {provider === 'gitee' && (
            <label>Client Secret <input data-testid="setup-client-secret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} /></label>
          )}
          <button data-testid="setup-save-oauth" onClick={() => void saveOauth()}>保存</button>
          <button onClick={() => setPhase('choose')}>返回</button>
        </div>
      );
    case 'pat':
      return (
        <div data-testid="setup-pat">
          <h3>使用 {provider === 'github' ? 'GitHub' : 'Gitee'} 私人令牌（跳过 OAuth）</h3>
          <p>
            打开令牌页创建后粘贴：
            <a href={OAUTH_GUIDE[provider].tokenUrl} target="_blank" rel="noreferrer" data-testid="setup-token-link">
              {OAUTH_GUIDE[provider].tokenUrl}
            </a>
            （{provider === 'gitee' ? '勾选 projects 与 user_info' : '勾选 repo'}）
          </p>
          <label>Token <input data-testid="setup-pat-input" value={pat} onChange={e => setPat(e.target.value)} /></label>
          <button data-testid="setup-save-pat" onClick={() => void savePatFlow()}>校验并保存</button>
          <button onClick={() => setPhase('choose')}>返回</button>
        </div>
      );
    case 'wizard':
      return (
        <GitLiteWizard
          onReady={props.onReady}
          flows={flows}
          database={props.database}
          initialProvider={wizardInit.provider}
          initialToken={wizardInit.token}
          initialOwner={wizardInit.owner}
        />
      );
    case 'error':
      return (
        <div data-testid="setup-error">
          <h3>出错了</h3>
          <p>{error}</p>
          <button onClick={() => void refresh()}>重试检测</button>
          <button data-testid="setup-error-back" onClick={() => setPhase(backTo)}>返回</button>
        </div>
      );
  }
}
