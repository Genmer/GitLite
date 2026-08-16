// loopback 回调接收测试：真实本地 socket（127.0.0.1 + 随机端口），不 mock
import { describe, expect, it } from 'vitest';
import { waitForRedirect, GITLITE_LOOPBACK_PORT } from './loopback.js';

describe('waitForRedirect（loopback 接收器）', () => {
  it('接收回调：回执 200 + 解析 query + 端口透出', async () => {
    let settle!: (v: { url: URL; port: number }) => void;
    const done = new Promise<{ url: URL; port: number }>(r => { settle = r; });
    const port = await new Promise<number>(res => {
      void waitForRedirect({ port: 0, onListening: res }).then(settle);
    });
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('GitLite');

    const hit = await done;
    expect(hit.url.searchParams.get('code')).toBe('abc');
    expect(hit.url.searchParams.get('state')).toBe('xyz');
    expect(hit.port).toBe(port);
  });

  it('无回调 → 超时拒绝', async () => {
    await expect(waitForRedirect({ port: 0, timeoutMs: 80 })).rejects.toThrow(/timeout/);
  });

  it('AbortSignal：监听后中止 → 关服拒绝并释放端口', async () => {
    const controller = new AbortController();
    const ready = new Promise<number>(res => {
      void waitForRedirect({ port: 0, signal: controller.signal, onListening: res })
        .catch(() => undefined); // 拒绝由下方显式断言验证
    });
    const port = await ready;
    const receiver = waitForRedirect({ port: 0, signal: controller.signal, onListening: () => {} });
    controller.abort();
    await expect(receiver).rejects.toThrow(/aborted/);
    // 端口已释放：同端口可立即重新监听
    const rebind = waitForRedirect({ port, timeoutMs: 300 });
    rebind.catch(() => undefined);
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=x`);
    expect(res.status).toBe(200);
    await rebind; // 不抛即通过
  });

  it('已中止的 signal → 立即拒绝', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForRedirect({ port: 0, signal: controller.signal })).rejects.toThrow(/aborted/);
  });

  it('默认端口常量存在（docs/04 固定 loopback 端口）', () => {
    expect(GITLITE_LOOPBACK_PORT).toBe(18365);
  });
});
