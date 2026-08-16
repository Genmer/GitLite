// GitLite 引导配置演示页：真实双平台绑定状态 + OAuth 登记/PAT 页面引导 + 登录 + 连接。
// 页面只负责交互；凭据存储/Device Flow/OAuth loopback/校验/连接全部经 /api 在服务端执行
//（token 永不出服务端凭据库，页面拿不到也无需拿到）。
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { GitLiteSetup, type SetupFlows } from '@gitlite/ui';

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(data?.error ?? `${res.status} ${path}`);
  return data as T;
};

/** 登录任务：发起后轮询，hint（验证码/授权链接）变化时经 onCode 推给向导显示 */
async function loginViaApi(provider: 'github' | 'gitee', onCode: (info: string) => void): Promise<string> {
  const { jobId } = await api<{ jobId: string }>(`/api/login/${provider}`, { method: 'POST' });
  let lastHint = '';
  for (;;) {
    const job = await api<{ status: string; hint?: string; error?: string }>(`/api/login/${jobId}`);
    if (job.hint && job.hint !== lastHint) {
      lastHint = job.hint;
      onCode(job.hint);
    }
    if (job.status === 'done') return 'stored-in-server-credential-store';
    if (job.status === 'error') throw new Error(job.error ?? 'login failed');
    await new Promise(r => setTimeout(r, 700));
  }
}

const remoteFlows: SetupFlows = {
  async detect() {
    return await api('/api/status');
  },
  async saveOAuth(provider, creds) {
    await api(`/api/oauth/${provider}`, { method: 'POST', body: JSON.stringify(creds) });
  },
  async savePat(provider, token) {
    const { login } = await api<{ login: string }>(`/api/pat/${provider}`, {
      method: 'POST', body: JSON.stringify({ token })
    });
    return login;
  },
  async login(provider, onCode) {
    return await loginViaApi(provider, onCode);
  },
  async identity(provider) {
    const { login } = await api<{ login: string | null }>(`/api/whoami/${provider}`);
    return login;
  },
  async connect(provider, opts) {
    await api('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ provider, owner: opts.owner, repo: opts.repo, database: opts.database })
    });
    return { demo: '真实连接在服务端已完成并关闭（演示页）' } as any;
  }
};

function App() {
  const [done, setDone] = useState<any>(null);
  if (done) {
    return (
      <div className="card">
        <h2>✅ 绑定并连接成功</h2>
        <p>OAuth/PAT 已绑定、token 在服务端凭据库、仓库已就绪（分支 gitlite/demo-db）。</p>
        <p>再次打开本页将显示两平台的绑定状态徽标；可点「跳过，直接连接」复验。</p>
      </div>
    );
  }
  return <GitLiteSetup onReady={() => setDone(true)} flows={remoteFlows} database="demo-db" />;
}

createRoot(document.getElementById('root')!).render(<App />);
