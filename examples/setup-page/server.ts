// GitLite 引导配置演示页服务：静态页面（esbuild 打包 React 页）+ /api 能力端点（服务端执行）。
// 启动：npx tsx examples/setup-page/server.ts   →  http://127.0.0.1:4173
// 页面流程与 gitlite setup / <GitLiteSetup> 完全一致；token 只存服务端凭据库，页面拿不到。
import * as http from 'node:http';
import { exec } from 'node:child_process';
import * as esbuild from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authStatus, saveOAuthApp, interactiveLogin, giteeLogin,
  connect as sdkConnect, GitHubProvider, GiteeProvider
} from '@gitlite/sdk';
import { createNodeRuntime } from '@gitlite/adapters-node';
import type { RuntimeAdapter } from '@gitlite/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
const runtime: RuntimeAdapter = createNodeRuntime();

// ---------- 登录任务（页面轮询拿 hint/完成态） ----------
interface Job { status: 'pending' | 'done' | 'error'; hint?: string; error?: string }
const jobs = new Map<string, Job>();
let jobSeq = 0;
/** 每平台当前登录的取消器：重试/新登录前中止旧 loopback 接收器（防 18365 占用 EADDRINUSE） */
const loginAbort = new Map<'github' | 'gitee', AbortController>();

const startJob = (run: (job: Job) => Promise<void>): string => {
  const id = `j${++jobSeq}`;
  const job: Job = { status: 'pending' };
  jobs.set(id, job);
  void run(job).catch(e => { job.status = 'error'; job.error = String(e?.message ?? e); });
  return id;
};

// ---------- API ----------
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const send = (data: unknown, status = 200): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data ?? {}));
  };
  const body = async (): Promise<any> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
  };
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const provider = seg[2] === 'gitee' ? 'gitee' : seg[2] === 'github' ? 'github' : null;

  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(await authStatus(runtime));
    }
    if (req.method === 'POST' && seg[1] === 'oauth' && provider) {
      const { clientId, clientSecret } = await body();
      if (!clientId) return send({ error: 'clientId required' }, 400);
      await saveOAuthApp(runtime, provider, { clientId, clientSecret });
      return send({ ok: true });
    }
    if (req.method === 'POST' && seg[1] === 'pat' && provider) {
      const { token } = await body();
      if (!token) return send({ error: 'token required' }, 400);
      const p = provider === 'gitee'
        ? new GiteeProvider(token, runtime.fetch)
        : new GitHubProvider(token, runtime.fetch);
      const { login } = await p.getUser!(); // 校验失败抛错 → 下方 catch 回给页面
      await runtime.credential.set(`gitlite:${provider}:default`, token);
      return send({ login });
    }
    if (req.method === 'POST' && seg[1] === 'login' && provider) {
      loginAbort.get(provider)?.abort(); // 中止旧接收器（上一次失败/放弃的登录仍占着 18365）
      const controller = new AbortController();
      loginAbort.set(provider, controller);
      const id = startJob(async job => {
        try {
          if (provider === 'gitee') {
            await giteeLogin({
              runtime, signal: controller.signal,
              onCode: u => { job.hint = `浏览器打开并授权：${u}`; }
            });
          } else {
            await interactiveLogin(runtime, (code, uri) => {
              job.hint = `打开 ${uri} 并输入代码：${code}`;
            });
          }
          job.status = 'done';
        } catch (e: any) {
          job.status = 'error';
          job.error = /EADDRINUSE/.test(String(e?.message ?? e))
            ? '回调端口 18365 被占用（可能仍有残留登录进程）——请稍候几秒重试'
            : /aborted/.test(String(e?.message ?? e)) ? '已取消（被新的登录尝试取代）'
            : String(e?.message ?? e);
        }
      });
      return send({ jobId: id });
    }
    if (req.method === 'GET' && seg[1] === 'login') {
      const job = jobs.get(seg[2] ?? '');
      if (!job) return send({ error: 'no such job' }, 404);
      return send(job);
    }
    if (req.method === 'GET' && seg[1] === 'whoami' && provider) {
      const token = await runtime.credential.get(`gitlite:${provider}:default`);
      if (!token) return send({ login: null });
      const p = provider === 'gitee'
        ? new GiteeProvider(token, runtime.fetch)
        : new GitHubProvider(token, runtime.fetch);
      try { return send({ login: (await p.getUser!()).login }); }
      catch { return send({ login: null }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      const { provider: pv, owner, repo, database, allowForeignRepo } = await body();
      if (!pv || !owner) return send({ error: 'provider/owner required' }, 400);
      const token = await runtime.credential.get(`gitlite:${pv}:default`);
      if (!token) return send({ error: `请先绑定 ${pv}（登录或 PAT）` }, 400);
      const db = await sdkConnect({
        provider: pv, token, owner, repo: repo ?? 'gitlite-repo', database: database ?? 'demo-db',
        allowForeignRepo: !!allowForeignRepo
      } as any);
      await db.close(); // 演示页：真实连接在服务端完成（建仓/分支/bootstrap）后即关
      return send({ ok: true });
    }
    return send({ error: 'not found' }, 404);
  } catch (e: any) {
    return send({ error: String(e?.message ?? e) }, 400);
  }
}

// ---------- 页面打包与静态服务 ----------
async function main(): Promise<void> {
  const built = await esbuild.build({
    entryPoints: [join(HERE, 'page.tsx')],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    write: false,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'stub-node-adapters',
      setup(b) {
        // 浏览器包不含 node 运行时（页面不用它，能力全在 /api）；引用替换为抛错桩
        b.onResolve({ filter: /^@gitlite\/adapters-node$/ }, () => ({
          path: join(HERE, 'adapters-stub.ts')
        }));
      }
    }]
  });
  const js = built.outputFiles[0]!.text;

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GitLite · 引导配置</title>
<style>
  :root {
    --bg: #f4f5fa; --bg-grad: radial-gradient(1200px 500px at 50% -100px, #e4e9ff66, transparent);
    --card: #ffffff; --text: #16181d; --muted: #6b7280; --border: #e5e7eb; --border-soft: #eceef3;
    --accent: #4f46e5; --accent-2: #6366f1; --accent-weak: #eef0ff; --accent-ring: #4f46e533;
    --ok: #0a7d43; --ok-weak: #e7f7ef; --bad: #b42318; --bad-weak: #feeceb;
    --mono-bg: #f8f9fc; --shadow: 0 1px 2px #10182a0d, 0 8px 24px #10182a0f;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1015; --bg-grad: radial-gradient(1200px 500px at 50% -100px, #4f46e526, transparent);
      --card: #171a21; --text: #e8eaf0; --muted: #9aa1ad; --border: #262b36; --border-soft: #20242e;
      --accent: #818cf8; --accent-2: #a5b4fc; --accent-weak: #4f46e526; --accent-ring: #818cf844;
      --ok: #4ade80; --ok-weak: #0a7d4326; --bad: #f87171; --bad-weak: #b4231826;
      --mono-bg: #10131a; --shadow: 0 1px 2px #00000066, 0 8px 24px #00000066;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--bg); background-image: var(--bg-grad);
    color: var(--text); line-height: 1.65;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 680px; margin: 0 auto; padding: 40px 20px 80px; }

  /* 品牌头部 */
  .page-header { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
  .page-logo {
    width: 44px; height: 44px; border-radius: 12px; flex: none;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: #fff; font-weight: 800; font-size: 20px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 6px 16px var(--accent-ring);
  }
  .page-title { font-size: 22px; font-weight: 700; letter-spacing: .2px; margin: 0; }
  .page-tag { color: var(--muted); font-size: 13px; margin: 2px 0 0; }

  /* 卡片 */
  .gl-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 16px;
    padding: 26px 26px 22px; box-shadow: var(--shadow); margin-bottom: 18px;
  }
  .gl-title { margin: 0 0 6px; font-size: 17px; }
  .gl-sub { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
  .gl-center { text-align: center; padding: 44px 20px; color: var(--muted); }
  .gl-done { color: var(--ok); font-size: 18px; font-weight: 700; }

  /* 平台行 */
  .gl-platform { border: 1px solid var(--border-soft); border-radius: 14px; padding: 16px 18px; margin-bottom: 12px; }
  .gl-platform-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .gl-platform-name { font-size: 15.5px; }
  .gl-pills { display: inline-flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }
  .gl-mark { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px;
    border-radius: 10px; background: var(--mono-bg); color: var(--text); flex: none; }
  .gl-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 11px;
    border-radius: 999px; white-space: nowrap; }
  .gl-pill-ok { background: var(--ok-weak); color: var(--ok); }
  .gl-pill-no { background: var(--mono-bg); color: var(--muted); }

  /* 按钮 */
  .gl-btn {
    cursor: pointer; font: inherit; font-size: 13.5px; line-height: 1;
    padding: 10px 18px; border-radius: 10px; border: 1px solid transparent;
    transition: background .15s, border-color .15s, transform .05s;
  }
  .gl-btn:active { transform: translateY(1px); }
  .gl-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .gl-btn-primary { background: var(--accent); color: #fff; box-shadow: 0 4px 12px var(--accent-ring); }
  .gl-btn-primary:hover { background: var(--accent-2); }
  .gl-btn-secondary { background: var(--card); color: var(--accent); border-color: var(--accent); }
  .gl-btn-secondary:hover { background: var(--accent-weak); }
  .gl-btn-ghost { background: transparent; color: var(--muted); }
  .gl-btn-ghost:hover { color: var(--text); background: var(--mono-bg); }
  .gl-btn-mini { padding: 5px 12px; font-size: 12.5px; border-radius: 8px;
    background: var(--accent-weak); color: var(--accent); }
  .gl-btn-mini:hover { background: var(--accent); color: #fff; }
  .gl-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
  .gl-foot { margin-top: 6px; text-align: center; }

  /* 平台大选项 */
  .gl-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .gl-choice {
    cursor: pointer; font: inherit; font-size: 15px; font-weight: 600;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    padding: 22px 12px; border-radius: 14px; border: 1px solid var(--border);
    background: var(--card); color: var(--text);
  }
  .gl-choice:hover { border-color: var(--accent); background: var(--accent-weak); }

  /* 步骤列表 / 回调地址框 */
  .gl-steps { margin: 0 0 16px; padding: 0; list-style: none; counter-reset: step; }
  .gl-steps li { counter-increment: step; position: relative; padding: 0 0 14px 38px; font-size: 14px; }
  .gl-steps li::before {
    content: counter(step); position: absolute; left: 0; top: 1px;
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--accent-weak); color: var(--accent);
    font-size: 12.5px; font-weight: 700; display: flex; align-items: center; justify-content: center;
  }
  .gl-steps li:not(:last-child)::after {
    content: ""; position: absolute; left: 12px; top: 28px; bottom: 2px; width: 1px; background: var(--border);
  }
  .gl-callback {
    display: flex; align-items: center; gap: 10px; margin-top: 8px;
    background: var(--mono-bg); border: 1px dashed var(--accent); border-radius: 10px; padding: 9px 12px;
  }
  .gl-callback code { font-family: ui-monospace, Consolas, monospace; font-size: 13px; word-break: break-all; }
  .gl-link { color: var(--accent); word-break: break-all; text-decoration-color: var(--accent-ring); text-underline-offset: 3px; }
  .gl-link:hover { text-decoration: none; background: var(--accent-weak); }

  /* 表单 */
  .gl-form { display: grid; gap: 4px; }
  .gl-field { font-size: 13px; color: var(--muted); display: grid; gap: 6px; }
  .gl-input {
    font: inherit; font-size: 14px; padding: 10px 13px; width: 100%;
    border: 1px solid var(--border); border-radius: 10px; background: var(--card); color: var(--text);
  }
  .gl-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
  .gl-input::placeholder { color: var(--muted); opacity: .6; }

  /* 提示 / 错误 / 进度 */
  .gl-hintbox {
    background: var(--accent-weak); border-radius: 10px; padding: 12px 14px;
    font-family: ui-monospace, Consolas, monospace; font-size: 13px; word-break: break-all; margin: 0 0 4px;
  }
  .gl-auth-open { display: inline-block; margin-top: 12px; text-decoration: none; }
  .gl-wait { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
  .gl-error { border-color: var(--bad); }
  .gl-errmsg { color: var(--bad); font-size: 14px; margin: 0 0 4px; }
  .gl-progress { color: var(--muted); margin: 10px 0 0; font-size: 13.5px; }
  .gl-spinner {
    width: 18px; height: 18px; border-radius: 50%; display: inline-block; vertical-align: -4px; margin-right: 8px;
    border: 2.5px solid var(--accent-ring); border-top-color: var(--accent);
    animation: gl-spin .8s linear infinite;
  }
  @keyframes gl-spin { to { transform: rotate(360deg); } }
</style>
<script>
  window.addEventListener('error', function (e) {
    var r = document.getElementById('root');
    if (r && !r.children.length) r.textContent = '页面脚本出错：' + (e.message || e.error);
  });
</script>
</head>
<body>
<main>
  <header class="page-header">
    <div class="page-logo">G</div>
    <div>
      <h1 class="page-title">GitLite</h1>
      <p class="page-tag">引导配置 · GitHub / Gitee 绑定</p>
    </div>
  </header>
  <div id="root">加载中…</div>
</main>
<script type="module" src="/app.js"></script>
</body></html>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(js);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>(r => server.listen(PORT, '127.0.0.1', r));
  const u = `http://127.0.0.1:${PORT}`;
  console.log(`GitLite 引导配置演示页：${u}\n（GitHub Device Flow / Gitee OAuth loopback 均在本服务执行；Ctrl+C 退出）`);
  exec(process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`, () => {});
}

main().catch(e => { console.error('启动失败:', e); process.exit(1); });
