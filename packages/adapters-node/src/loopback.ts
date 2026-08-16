// loopback OAuth 回调接收（docs/04：Gitee 授权码流 redirect_uri=http://127.0.0.1:<port>/callback）。
// 仅 adapters-node（node:http）；一次性服务：收到回调 → 回执 HTML → 关服。
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export const GITLITE_LOOPBACK_PORT = 18365; // docs/04 固定 loopback 端口（OAuth App 需预注册回调地址）

/** 起一次性 loopback 服务等待 OAuth 回调。
 *  @param onListening 实际监听端口就绪回调（port=0 时用于取随机端口的确定值）
 *  @returns 回调完整 URL（含 query）；超时/端口占用拒绝 */
export function waitForRedirect(opts?: {
  port?: number;
  path?: string;
  timeoutMs?: number;
  onListening?: (port: number) => void;
}): Promise<{ url: URL; port: number }> {
  const port = opts?.port ?? GITLITE_LOOPBACK_PORT;
  const path = opts?.path ?? '/callback';
  const timeoutMs = opts?.timeoutMs ?? 15 * 60_000;
  return new Promise((resolve, reject) => {
    let boundPort = port;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h3>GitLite 登录成功，可关闭此页返回终端。</h3></body></html>');
      clearTimeout(timer);
      server.close();
      server.closeIdleConnections?.(); // 释放 keep-alive 连接，不阻塞进程退出
      resolve({ url, port: boundPort });
    });
    const timer = setTimeout(() => {
      server.close();
      server.closeIdleConnections?.();
      reject(new Error(`loopback receiver timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    server.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`loopback receiver error: ${e.code ?? e.message}`));
    });
    server.listen(port, '127.0.0.1', () => {
      boundPort = (server.address() as AddressInfo).port;
      opts?.onListening?.(boundPort);
    });
  });
}
