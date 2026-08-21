// loopback OAuth 回调接收（docs/04：Gitee 授权码流 redirect_uri=http://127.0.0.1:<port>/callback）。
// 仅 adapters-node（node:http）；一次性服务：收到回调 → 回执 HTML → 关服。
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export const GITLITE_LOOPBACK_PORT = 18365; // docs/04 固定 loopback 端口（OAuth App 需预注册回调地址）

export function renderOAuthSuccessHtml(opts?: { code?: string; appName?: string; redirectUrl?: string }): string {
  const rawCode = opts?.code ?? '';
  const safeCode = rawCode.replace(/[^\w-]/g, '');
  const appName = opts?.appName ?? 'GitLite';
  const rawRedirectUrl = opts?.redirectUrl ?? '';
  const safeRedirectUrl = rawRedirectUrl.replace(/[^\w-.:/?&=#%]/g, '');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>授权成功 - ${appName}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px; background: #0b0d13; color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
      display: flex; align-items: center; justify-content: center; min-height: 100vh;
    }
    .card {
      background: #151822; border: 1px solid #2d3348; border-radius: 24px;
      padding: 36px 28px; max-width: 440px; width: 100%; text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 30px rgba(16, 185, 129, 0.15);
    }
    .icon-badge {
      width: 52px; height: 52px; border-radius: 16px; margin: 0 auto 16px;
      background: linear-gradient(135deg, #10b981, #059669);
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 10px 20px -5px rgba(16, 185, 129, 0.4);
    }
    .icon-badge svg { width: 26px; height: 26px; fill: none; stroke: #fff; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .status-tag {
      display: inline-block; padding: 3px 10px;
      background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399; border-radius: 9999px; font-size: 11px; font-weight: 600; margin-bottom: 10px;
    }
    h2 { margin: 0 0 6px 0; font-size: 20px; font-weight: 700; color: #ffffff; }
    p.desc { margin: 0 0 18px 0; font-size: 13px; color: #9ca3af; line-height: 1.5; }
    .code-box {
      background: #090b10; border: 1px solid #312e81; border-radius: 12px;
      padding: 10px 14px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px;
      font-weight: 700; color: #a5b4fc; word-break: break-all; margin-bottom: 16px; user-select: all;
    }
    .btn-primary {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 12px 0; background: linear-gradient(135deg, #10b981, #059669);
      color: #ffffff; border: none; border-radius: 12px; font-size: 13px; font-weight: 700;
      cursor: pointer; text-decoration: none; transition: all 0.2s; box-shadow: 0 6px 16px -4px rgba(16, 185, 129, 0.4);
      margin-bottom: 10px;
    }
    .btn-primary:hover { opacity: 0.95; transform: translateY(-1px); }
    .btn-secondary {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 10px 0; background: #1e2433; border: 1px solid #2d3348;
      color: #d1d5db; border-radius: 12px; font-size: 12.5px; font-weight: 600;
      cursor: pointer; text-decoration: none; transition: all 0.2s;
    }
    .btn-secondary:hover { background: #283044; color: #ffffff; }
    .tips { font-size: 12px; color: #6b7280; line-height: 1.6; border-top: 1px solid #242938; padding-top: 16px; margin-top: 16px; text-align: left; }
    .tips b { color: #d1d5db; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-badge">
      <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
    </div>
    <div class="status-tag">网页授权已通过</div>
    <h2>🎉 授权成功！</h2>
    <p class="desc">您的账号已成功授权给 ${appName} 数据库引擎。</p>
    ${safeCode ? `<div class="code-box" id="codeText">${safeCode}</div>
    <button class="btn-primary" id="copyBtn" onclick="copyCode()">
      <span id="btnText">📋 点击复制授权码 (自动写入已就绪)</span>
    </button>` : ''}
    <div id="returnBox" style="display:none;margin-top:10px;">
      <a id="returnLink" href="#" class="btn-primary">👉 正在返回应用页面…</a>
    </div>
    <div class="tips">
      💡 <b>操作指引</b>：<br>
      • 本地客户端已自动捕获授权结果，您可以直接关闭此标签页；<br>
      • 如客户端未自动响应，可复制上方授权码在应用中粘贴注入。
    </div>
  </div>
  <script>
    const code = '${safeCode}';
    let targetRedirect = '${safeRedirectUrl}';

    // 尝试从当前 URL 参数或 referrer 获取真实应用域名/返回地址
    if (!targetRedirect) {
      try {
        const q = new URLSearchParams(window.location.search);
        const ret = q.get('return_to') || q.get('redirect_uri');
        if (ret && (ret.startsWith('http://') || ret.startsWith('https://') || ret.startsWith('/'))) {
          targetRedirect = ret;
        } else if (document.referrer && !document.referrer.includes('/callback')) {
          targetRedirect = document.referrer;
        }
      } catch(e) {}
    }

    if (code) {
      try { navigator.clipboard.writeText(code); } catch(e) {}
    }

    function copyCode() {
      if (!code) return;
      navigator.clipboard.writeText(code).then(() => {
        const btn = document.getElementById('btnText');
        if (btn) btn.innerText = '✓ 已复制！返回客户端即可';
      });
    }

    // 跨窗口通信与自动返回
    if (window.opener) {
      try {
        window.opener.postMessage({ type: 'gitlite:oauth:success', code }, '*');
        setTimeout(() => { try { window.close(); } catch(e) {} }, 1200);
      } catch(e) {}
    }

    if (targetRedirect) {
      const box = document.getElementById('returnBox');
      const link = document.getElementById('returnLink');
      if (box && link) {
        box.style.display = 'block';
        link.href = targetRedirect;
        link.innerText = '👉 返回应用页面 (' + targetRedirect.split('/')[2] + ')';
        setTimeout(() => {
          try { window.location.href = targetRedirect; } catch(e) {}
        }, 1500);
      }
    }
  </script>
</body>
</html>`;
}

/** 起一次性 loopback 服务等待 OAuth 回调。
 *  @param onListening 实际监听端口就绪回调（port=0 时用于取随机端口的确定值）
 *  @param signal 取消信号：中止即关服拒绝（重试登录前取消旧接收器，防端口占用 EADDRINUSE）
 *  @returns 回调完整 URL（含 query）；超时/端口占用/取消拒绝 */
export function waitForRedirect(opts?: {
  port?: number;
  host?: string;
  path?: string;
  redirectUrl?: string;
  timeoutMs?: number;
  onListening?: (port: number) => void;
  signal?: AbortSignal;
}): Promise<{ url: URL; port: number }> {
  const port = opts?.port ?? GITLITE_LOOPBACK_PORT;
  const host = opts?.host ?? '127.0.0.1';
  const path = opts?.path ?? '/callback';
  const timeoutMs = opts?.timeoutMs ?? 15 * 60_000;
  return new Promise((resolve, reject) => {
    let boundPort = port;
    let settled = false;
    const server = http.createServer((req, res) => {
      const hostHeader = req.headers.host ?? `${host}:${boundPort}`;
      const url = new URL(req.url ?? '/', `http://${hostHeader}`);
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code') || undefined;
      const redirectUrl = url.searchParams.get('return_to') || url.searchParams.get('redirect_uri') || opts?.redirectUrl;
      const html = renderOAuthSuccessHtml({ code, redirectUrl });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'connection': 'close'
      });
      res.end(html);
      settle(undefined, { url, port: boundPort });
    });

    const timer = setTimeout(() => settle(new Error(`loopback receiver timeout after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    server.once('error', (e: NodeJS.ErrnoException) => {
      settle(new Error(`loopback receiver error: ${e.code ?? e.message}`));
    });
    const settle = (err: Error | undefined, hit?: { url: URL; port: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      server.close();
      server.closeIdleConnections?.(); // 释放 keep-alive 连接，不阻塞进程退出
      if (err) reject(err);
      else resolve(hit!);
    };
    const onAbort = (): void => settle(new Error('loopback receiver aborted'));
    if (opts?.signal?.aborted) {
      onAbort();
      return;
    }
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    server.listen(port, host, () => {
      boundPort = (server.address() as AddressInfo).port;
      opts?.onListening?.(boundPort);
    });
  });
}
