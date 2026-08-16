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

  it('默认端口常量存在（docs/04 固定 loopback 端口）', () => {
    expect(GITLITE_LOOPBACK_PORT).toBe(18365);
  });
});
