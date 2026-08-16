// Gitee OAuth 纯逻辑测试：授权 URL / 换 token（表单体）/ 刷新 / client_id 解析
import { describe, expect, it, afterEach } from 'vitest';
import {
  giteeAuthorizeUrl, exchangeGiteeCode, refreshGiteeToken, resolveGiteeClientId, resolveGiteeClientSecret
} from './gitee.js';
import { AuthError } from '../errors.js';

/** 记录 (url, init) 的 mock fetch */
function mockFetch(body: any, status = 200): typeof fetch & { last: { url: string; init: any } } {
  const last = { url: '', init: undefined as any };
  const fn = (async (url: any, init?: any) => {
    last.url = String(url);
    last.init = init;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as any;
  fn.last = last;
  return fn;
}

describe('giteeAuthorizeUrl', () => {
  it('必选参数 + scope；PKCE 可选时附 method', () => {
    const base = giteeAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:18365/callback', state: 's1', scope: 'projects user_info' });
    const u = new URL(base);
    expect(u.origin + u.pathname).toBe('https://gitee.com/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('s1');
    expect(u.searchParams.get('scope')).toBe('projects user_info');
    expect(u.searchParams.get('code_challenge')).toBeNull();

    const pkce = new URL(giteeAuthorizeUrl({
      clientId: 'cid', redirectUri: 'http://x/cb', state: 's', codeChallenge: 'chal'
    }));
    expect(pkce.searchParams.get('code_challenge')).toBe('chal');
    expect(pkce.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('exchangeGiteeCode / refreshGiteeToken', () => {
  it('表单体换 token；成功映射字段；secret/verifier 可选透传', async () => {
    const f = mockFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 86400, scope: 'projects' });
    const t = await exchangeGiteeCode(f, {
      clientId: 'cid', code: 'c1', redirectUri: 'http://127.0.0.1:18365/callback'
    });
    expect(t).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 86400, scope: 'projects' });
    expect(f.last.url).toBe('https://gitee.com/api/v5/oauth/token');
    expect(f.last.init.method).toBe('POST');
    expect(f.last.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(f.last.init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('c1');
    expect(body.get('client_secret')).toBeNull();

    const f2 = mockFetch({ access_token: 'at2' });
    await exchangeGiteeCode(f2, {
      clientId: 'cid', code: 'c', redirectUri: 'http://x/cb', clientSecret: 'sec', codeVerifier: 'vf'
    });
    const b2 = new URLSearchParams(f2.last.init.body);
    expect(b2.get('client_secret')).toBe('sec');
    expect(b2.get('code_verifier')).toBe('vf');
  });

  it('刷新走 refresh_token grant', async () => {
    const f = mockFetch({ access_token: 'at3', refresh_token: 'rt3' });
    const t = await refreshGiteeToken(f, { clientId: 'cid', refreshToken: 'rt-old', clientSecret: 'sec' });
    expect(t.accessToken).toBe('at3');
    expect(t.refreshToken).toBe('rt3');
    const body = new URLSearchParams(f.last.init.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-old');
  });

  it('失败响应 → AuthError（含 error 描述）', async () => {
    const f = mockFetch({ error: 'invalid_grant', error_description: 'code expired' });
    await expect(exchangeGiteeCode(f, { clientId: 'cid', code: 'bad', redirectUri: 'http://x/cb' }))
      .rejects.toBeInstanceOf(AuthError);
    await expect(exchangeGiteeCode(f, { clientId: 'cid', code: 'bad', redirectUri: 'http://x/cb' }))
      .rejects.toThrow(/invalid_grant/);
  });
});

describe('resolveGiteeClientId / resolveGiteeClientSecret', () => {
  const keys = ['GITLITE_GITEE_CLIENT_ID', 'GITLITE_CLIENT_ID', 'GITLITE_GITEE_CLIENT_SECRET'];
  afterEach(() => { for (const k of keys) delete process.env[k]; });
  it('环境变量优先，缺省占位常量；secret 可缺省', () => {
    expect(resolveGiteeClientId()).toBe('gitlite-placeholder');
    expect(resolveGiteeClientSecret()).toBeUndefined();
    process.env.GITLITE_GITEE_CLIENT_ID = 'env-specific';
    expect(resolveGiteeClientId()).toBe('env-specific');
    process.env.GITLITE_GITEE_CLIENT_SECRET = 'sec';
    expect(resolveGiteeClientSecret()).toBe('sec');
  });
});
