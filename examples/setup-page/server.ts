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
      const id = startJob(async job => {
        if (provider === 'gitee') {
          await giteeLogin({
            runtime,
            onCode: u => { job.hint = `浏览器打开并授权：${u}`; }
          });
        } else {
          await interactiveLogin(runtime, (code, uri) => {
            job.hint = `打开 ${uri} 并输入代码：${code}`;
          });
        }
        job.status = 'done';
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
      const { provider: pv, owner, repo, database } = await body();
      if (!pv || !owner) return send({ error: 'provider/owner required' }, 400);
      const token = await runtime.credential.get(`gitlite:${pv}:default`);
      if (!token) return send({ error: `请先绑定 ${pv}（登录或 PAT）` }, 400);
      const db = await sdkConnect({
        provider: pv, token, owner, repo: repo ?? 'gitlite-repo', database: database ?? 'demo-db'
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
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
  h2, h3 { margin: 0.4em 0; }
  button { cursor: pointer; margin: 2px 6px 2px 0; padding: 6px 14px; border-radius: 8px;
           border: 1px solid #8886; background: #4f7cff1a; font-size: 14px; }
  button:hover { background: #4f7cff33; }
  input { padding: 6px 10px; border-radius: 8px; border: 1px solid #8888; font-size: 14px;
          width: min(340px, 70vw); }
  a { color: #4f7cff; word-break: break-all; }
  code { background: #8882; padding: 2px 6px; border-radius: 6px; }
  ol { padding-left: 1.2em; }
  label { display: block; margin: 8px 0; }
</style>
<script>
  window.addEventListener('error', function (e) {
    var r = document.getElementById('root');
    if (r && !r.children.length) r.textContent = '页面脚本出错：' + (e.message || e.error);
  });
</script>
</head>
<body><div id="root">加载中…</div><script type="module" src="/app.js"></script></body></html>`;

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
