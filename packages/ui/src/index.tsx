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

/** 平台显示名与徽标（gl-* 类名供宿主主题化；库自身不携带样式） */
const PLATFORM_NAME: Record<WizardProvider, string> = { github: 'GitHub', gitee: 'Gitee' };

const GithubMark = () => (
  <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const GiteeMark = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <rect width="24" height="24" rx="5.5" fill="#C71D23" />
    <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">G</text>
  </svg>
);

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
  /** 登录进行中（等待授权）：锁重复点击防「新登录取代旧任务」误触 */
  const [waiting, setWaiting] = useState(false);

  const choose = (p: WizardProvider): void => {
    setProvider(p);
    setStep('login');
  };

  const doLogin = async (): Promise<void> => {
    setError('');
    setHint('登录中…');
    setWaiting(true);
    try {
      const t = await flows.login(provider, info => setHint(info));
      setToken(t);
      const login = await flows.identity(provider, t).catch(() => null);
      if (login) setOwner(login);
      setStep('config');
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setStep('error');
    } finally {
      setWaiting(false);
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
        <div className="gl-card" data-testid="wizard-provider">
          <h3 className="gl-title">选择平台</h3>
          <p className="gl-sub">数据库将存放在你账号下的私有仓库中。</p>
          <div className="gl-choices">
            <button className="gl-choice" onClick={() => choose('github')}>
              <span className="gl-mark gl-mark-github"><GithubMark /></span> GitHub
            </button>
            <button className="gl-choice" onClick={() => choose('gitee')}>
              <span className="gl-mark gl-mark-gitee"><GiteeMark /></span> Gitee
            </button>
          </div>
        </div>
      );
    case 'login': {
      // 提示中出现的授权/验证链接 → 给可点击的大按钮（新标签页），不让用户复制 URL
      const authUrl = hint.match(/https?:\/\/[^\s，。]+/)?.[0];
      return (
        <div className="gl-card" data-testid="wizard-login">
          <h3 className="gl-title">登录 {PLATFORM_NAME[provider]}</h3>
          {hint && (
            <p className="gl-hintbox" data-testid="wizard-hint">{hint}</p>
          )}
          {authUrl ? (
            <>
              <a className="gl-btn gl-btn-primary gl-auth-open" href={authUrl} target="_blank" rel="noreferrer" data-testid="wizard-open-auth">打开授权页面 →</a>
              <p className="gl-wait">在新打开的页面完成授权后，本页会自动继续…</p>
              <div className="gl-actions">
                <button className="gl-btn gl-btn-ghost" onClick={() => void doLogin()} disabled={!waiting}>重新发起登录</button>
              </div>
            </>
          ) : (
            <div className="gl-actions">
              <button className="gl-btn gl-btn-primary" onClick={() => void doLogin()} disabled={waiting}>
                {waiting ? '登录中…' : '登录'}
              </button>
              <button className="gl-btn gl-btn-ghost" onClick={() => setStep('provider')} disabled={waiting}>返回</button>
            </div>
          )}
        </div>
      );
    }
    case 'config':
      return (
        <div className="gl-card" data-testid="wizard-config">
          <h3 className="gl-title">仓库配置</h3>
          <p className="gl-sub">owner 是你的平台用户名；仓库不存在会自动创建（私有）。</p>
          <label className="gl-field">owner <input className="gl-input" value={owner} onChange={e => setOwner(e.target.value)} data-testid="wizard-owner" /></label>
          <label className="gl-field">repo <input className="gl-input" value={repo} onChange={e => setRepo(e.target.value)} data-testid="wizard-repo" /></label>
          <div className="gl-actions">
            <button className="gl-btn gl-btn-primary" data-testid="wizard-connect" onClick={() => void doConnect()}>连接</button>
          </div>
        </div>
      );
    case 'connecting':
      return (
        <div className="gl-card gl-center" data-testid="wizard-connecting">
          <span className="gl-spinner" aria-hidden /> 连接中…
          {progress && <p className="gl-progress">{progress}</p>}
        </div>
      );
    case 'done':
      return <div className="gl-card gl-center gl-done" data-testid="wizard-done">✓ 连接成功</div>;
    case 'error':
      return (
        <div className="gl-card gl-error" data-testid="wizard-error">
          <h3 className="gl-title">出错了</h3>
          <p className="gl-errmsg">{error}</p>
          <div className="gl-actions">
            <button className="gl-btn gl-btn-primary" onClick={() => setStep(token ? 'config' : 'login')}>重试</button>
          </div>
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
    <span className={`gl-pill ${ok ? 'gl-pill-ok' : 'gl-pill-no'}`}>{ok ? '✅' : '⬜'} {label}</span>
  );

  switch (phase) {
    case 'detecting':
      return (
        <div className="gl-card gl-center" data-testid="setup-detecting">
          <span className="gl-spinner" aria-hidden /> 正在检测本机配置…
        </div>
      );
    case 'choose':
      return (
        <div className="gl-card" data-testid="setup-choose">
          <h3 className="gl-title">引导配置</h3>
          <p className="gl-sub">绑定一个平台即可开始——登记 OAuth 应用（浏览器点一下登录）或粘贴私人令牌；登记一次全机生效。</p>
          {(['github', 'gitee'] as const).map(p => (
            <div key={p} className="gl-platform" data-testid={`setup-status-${p}`}>
              <div className="gl-platform-head">
                <span className={`gl-mark gl-mark-${p}`}>{p === 'github' ? <GithubMark /> : <GiteeMark />}</span>
                <b className="gl-platform-name">{PLATFORM_NAME[p]}</b>
                {status && (
                  <span className="gl-pills">
                    {badge(status[p].token, '已登录')}
                    {badge(status[p].oauthApp, 'OAuth 应用')}
                  </span>
                )}
              </div>
              <div className="gl-actions">
                {status && status[p].oauthApp && !status[p].token ? (
                  <>
                    <button className="gl-btn gl-btn-primary" data-testid={`setup-login-${p}`} onClick={() => { setWizardInit({ provider: p }); setPhase('wizard'); }}>登录 {PLATFORM_NAME[p]}</button>
                    <button className="gl-btn gl-btn-secondary" data-testid={`setup-pat-${p}`} onClick={() => { setProvider(p); setPat(''); setPhase('pat'); }}>使用私人令牌</button>
                    <button className="gl-btn gl-btn-ghost" data-testid={`setup-oauth-${p}`} onClick={() => { setProvider(p); setClientId(''); setClientSecret(''); setCopied(false); setPhase('oauth'); }}>重新登记</button>
                  </>
                ) : (
                  <>
                    <button className="gl-btn gl-btn-primary" data-testid={`setup-oauth-${p}`} onClick={() => { setProvider(p); setClientId(''); setClientSecret(''); setCopied(false); setPhase('oauth'); }}>登记 OAuth 应用</button>
                    <button className="gl-btn gl-btn-secondary" data-testid={`setup-pat-${p}`} onClick={() => { setProvider(p); setPat(''); setPhase('pat'); }}>使用私人令牌</button>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="gl-foot">
            <button className="gl-btn gl-btn-ghost" data-testid="setup-skip" onClick={() => { setWizardInit({}); setPhase('wizard'); }}>
              跳过，直接连接（已登录过）→
            </button>
          </div>
        </div>
      );
    case 'oauth':
      return (
        <div className="gl-card" data-testid="setup-oauth">
          <h3 className="gl-title">登记 {PLATFORM_NAME[provider]} OAuth 应用</h3>
          <p className="gl-sub">约 1 分钟，一次即可——保存后本机所有 GitLite 入口自动使用。</p>
          <ol className="gl-steps">
            <li>
              打开注册页：
              <a className="gl-link" href={OAUTH_GUIDE[provider].registerUrl} target="_blank" rel="noreferrer" data-testid="setup-register-link">
                {OAUTH_GUIDE[provider].registerUrl}
              </a>
            </li>
            {OAUTH_GUIDE[provider].callbackCopyable ? (
              <li>
                回调地址（必须一字不差）：
                <div className="gl-callback">
                  <code>{OAUTH_GUIDE[provider].callback}</code>
                  <button className="gl-btn gl-btn-mini" data-testid="setup-copy" onClick={() => void copy()}>{copied ? '✓ 已复制' : '复制'}</button>
                </div>
              </li>
            ) : (
              <li>回调地址：{OAUTH_GUIDE[provider].callback}</li>
            )}
            <li>{OAUTH_GUIDE[provider].scopes}</li>
            <li>创建后把凭据粘贴到下面并保存</li>
          </ol>
          <div className="gl-form">
            <label className="gl-field">Client ID <input className="gl-input" data-testid="setup-client-id" value={clientId} onChange={e => setClientId(e.target.value)} placeholder="粘贴 Client ID" /></label>
            {provider === 'gitee' && (
              <label className="gl-field">Client Secret <input className="gl-input" data-testid="setup-client-secret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="粘贴 Client Secret" /></label>
            )}
          </div>
          <div className="gl-actions">
            <button className="gl-btn gl-btn-primary" data-testid="setup-save-oauth" onClick={() => void saveOauth()}>保存并继续</button>
            <button className="gl-btn gl-btn-ghost" onClick={() => setPhase('choose')}>返回</button>
          </div>
        </div>
      );
    case 'pat':
      return (
        <div className="gl-card" data-testid="setup-pat">
          <h3 className="gl-title">使用 {PLATFORM_NAME[provider]} 私人令牌</h3>
          <p className="gl-sub">跳过 OAuth：在令牌页创建后粘贴，自动校验并识别你的账号。</p>
          <p className="gl-hintbox">
            打开令牌页创建（{provider === 'gitee' ? '勾选 projects 与 user_info' : '勾选 repo'}）：
            <a className="gl-link" href={OAUTH_GUIDE[provider].tokenUrl} target="_blank" rel="noreferrer" data-testid="setup-token-link">
              {OAUTH_GUIDE[provider].tokenUrl}
            </a>
          </p>
          <div className="gl-form">
            <label className="gl-field">Token <input className="gl-input" data-testid="setup-pat-input" value={pat} onChange={e => setPat(e.target.value)} placeholder="粘贴私人令牌" /></label>
          </div>
          <div className="gl-actions">
            <button className="gl-btn gl-btn-primary" data-testid="setup-save-pat" onClick={() => void savePatFlow()}>校验并保存</button>
            <button className="gl-btn gl-btn-ghost" onClick={() => setPhase('choose')}>返回</button>
          </div>
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
        <div className="gl-card gl-error" data-testid="setup-error">
          <h3 className="gl-title">出错了</h3>
          <p className="gl-errmsg">{error}</p>
          <div className="gl-actions">
            <button className="gl-btn gl-btn-primary" onClick={() => void refresh()}>重试检测</button>
            <button className="gl-btn gl-btn-ghost" data-testid="setup-error-back" onClick={() => setPhase(backTo)}>返回</button>
          </div>
        </div>
      );
  }
}
