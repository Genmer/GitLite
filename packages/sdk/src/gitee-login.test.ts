// sdk giteeLogin 全流程集成：真 loopback（随机端口）+ mock 换 token fetch + 内存 runtime 凭据库
import { describe, expect, it } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { giteeLogin } from './index.js';
import type { RuntimeAdapter } from '@gitlite/core';

/** sdk 包内最小测试 runtime（跨包导入 core 测试助手会违反 rootDir） */
function createTestRuntime(): RuntimeAdapter & { creds: Map<string, string> } {
  const creds = new Map<string, string>();
  return {
    creds,
    fs: {
      readFile: async p => { throw new Error(`ENOENT ${p}`); },
      writeFile: async () => {},
      appendFile: async () => {},
      exists: async () => false,
      mkdir: async () => {}
    },
    crypto: {
      randomBytes: n => new Uint8Array(nodeCrypto.randomBytes(n)),
      sha1hex: s => nodeCrypto.createHash('sha1').update(s).digest('hex')
    },
    credential: {
      set: async (k, v) => { creds.set(k, v); },
      get: async k => creds.get(k) ?? null,
      delete: async k => { creds.delete(k); }
    },
    fetch: (() => { throw new Error('network disabled'); }) as any,
    now: () => Date.now(),
    onExit: () => {}
  };
}

function mockExchange(body: any): typeof fetch & { calls: any[] } {
  const calls: any[] = [];
  const fn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  fn.calls = calls;
  return fn;
}

describe('giteeLogin（OAuth 授权码 + loopback 全流程）', () => {
  it('授权 URL → 回调 → 换 token → 存凭据库', async () => {
    const runtime = createTestRuntime();
    const fetchFn = mockExchange({ access_token: 'gitee-at', refresh_token: 'gitee-rt', expires_in: 86400 });

    const login = giteeLogin({
      clientId: 'cid', port: 0, runtime, fetchFn,
      onCode: (url, { port }) => {
        // 宿主拿到授权 URL：解析出 state，模拟浏览器回调
        const state = new URL(url).searchParams.get('state')!;
        void fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=${state}`);
      }
    });
    const token = await login;
    expect(token).toBe('gitee-at');
    expect(await runtime.credential.get('gitlite:gitee:default')).toBe('gitee-at');
    // 换 token 请求形态
    expect(fetchFn.calls[0]!.url).toBe('https://gitee.com/api/v5/oauth/token');
    const body = new URLSearchParams(fetchFn.calls[0]!.init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('state 不符（CSRF）→ 拒绝且不换 token', async () => {
    const runtime = createTestRuntime();
    const fetchFn = mockExchange({ access_token: 'evil' });
    const login = giteeLogin({
      clientId: 'cid', port: 0, runtime, fetchFn,
      onCode: (url, { port }) => {
        void fetch(`http://127.0.0.1:${port}/callback?code=stolen&state=tampered`);
      }
    });
    await expect(login).rejects.toThrow(/state mismatch/);
    expect(fetchFn.calls.length).toBe(0);
  });
});
