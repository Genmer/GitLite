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

/** 登录任务：发起后轮询，hint（验证码/授权链接）变化时经 onCode 推给向导显示。
 *  只处理「最新一次」登录任务——重试后旧任务的轮询自动退出，不串台更新提示。 */
let latestLoginJob: string | null = null;
async function loginViaApi(provider: 'github' | 'gitee', onCode: (info: string) => void): Promise<string> {
  const { jobId } = await api<{ jobId: string }>(`/api/login/${provider}`, { method: 'POST' });
  latestLoginJob = jobId;
  let lastHint = '';
  for (;;) {
    const job = await api<{ status: string; hint?: string; error?: string }>(`/api/login/${jobId}`);
    if (latestLoginJob !== jobId) throw new Error('已发起新的登录，本次尝试作废');
    if (job.hint && job.hint !== lastHint) {
      lastHint = job.hint;
      onCode(job.hint);
    }
    if (job.status === 'done') return 'stored-in-server-credential-store';
    if (job.status === 'error') throw new Error(job.error ?? 'login failed');
    await new Promise(r => setTimeout(r, 700));
  }
}

/** 页面内确认弹窗（window.confirm 在内嵌浏览器可能被静默拦截，自绘更可靠） */
function pageConfirm(text: string): Promise<boolean> {
  return new Promise(resolve => {
    const done = (ok: boolean): void => {
      overlay.remove();
      resolve(ok);
    };
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:#0009;display:flex;align-items:center;justify-content:center;z-index:99';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#fff);color:var(--text,#111);border:1px solid var(--border,#e5e7eb);border-radius:16px;padding:24px 26px;max-width:460px;margin:20px;box-shadow:0 12px 40px #0006;font:14px/1.65 system-ui';
    const p = document.createElement('p');
    p.style.cssText = 'white-space:pre-line;margin:0 0 18px';
    p.textContent = text;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
    const mkBtn = (label: string, primary: boolean, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `cursor:pointer;font:inherit;font-size:13.5px;padding:9px 18px;border-radius:10px;border:1px solid ${
        primary ? 'transparent' : 'var(--border,#e5e7eb)'};background:${
        primary ? 'var(--accent,#4f46e5)' : 'transparent'};color:${primary ? '#fff' : 'var(--muted,#6b7280)'}`;
      b.onclick = fn;
      return b;
    };
    actions.append(
      mkBtn('换个仓库', false, () => done(false)),
      mkBtn('确认初始化', true, () => done(true))
    );
    box.append(p, actions);
    overlay.append(box);
    document.body.append(overlay);
  });
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
    const post = (allowForeignRepo: boolean): Promise<unknown> =>
      api('/api/connect', {
        method: 'POST',
        body: JSON.stringify({
          provider, owner: opts.owner, repo: opts.repo, database: opts.database, allowForeignRepo
        })
      });
    try {
      await post(false);
    } catch (e) {
      // FR A4 安全闸：仓库已有非 GitLite 文件 → 页面内弹窗显式确认（只添加系统文件，绝不删除）
      const msg = String((e as Error)?.message ?? e);
      if (/explicit confirmation required/.test(msg)) {
        const ok = await pageConfirm(
          `该仓库已有非 GitLite 文件。\n\nGitLite 只会添加自己的系统文件（_schema/_indexes 等）与数据文件，绝不修改或删除现有内容（additive-only，ADR-002）。\n\n确认在这个仓库初始化 GitLite？`
        );
        if (!ok) throw new Error('已取消：未在该仓库初始化（可换个空仓库，或让向导新建 gitlite-repo）');
        await post(true);
      } else {
        throw e;
      }
    }
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
