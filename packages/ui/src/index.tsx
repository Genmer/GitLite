// @gitlite/ui（docs/04/09）：内置向导 GitLiteWizard——选平台 → 登录 → 身份/仓库 → 连接。
// flows 可注入：默认 nodeFlows 走 sdk + adapters-node（桌面/Electron 宿主）；
// 浏览器宿主注入自己的 flows（避免打包 node 内置）。
import { useState } from 'react';
import { connect as sdkConnect, interactiveLogin, giteeLogin } from '@gitlite/sdk';
import type { GitLiteClient } from '@gitlite/sdk';
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
}) {
  const flows = props.flows ?? nodeFlows;
  const [step, setStep] = useState<WizardStep>('provider');
  const [provider, setProvider] = useState<WizardProvider>('github');
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
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
