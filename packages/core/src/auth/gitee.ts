// Gitee OAuth2 授权码 + loopback（docs/04，FR B1 对位）：
// core 只放纯逻辑（授权 URL / 换 token / 刷新，fetch 注入零 node 依赖）；
// loopback HTTP 回调服务由宿主提供（adapters-node waitForRedirect）。
// PKCE：Gitee 无官方文档化支持（docs/02 §0 差异表）→ code_challenge/code_verifier 作可选参数保留；
// state 必传（CSRF 防护，由调用方生成）。
import { AuthError, NetworkError } from '../errors.js';

export const GITEE_AUTHORIZE_URL = 'https://gitee.com/oauth/authorize';
export const GITEE_TOKEN_URL = 'https://gitee.com/api/v5/oauth/token';

// 开发期与 GitHub Device Flow 同模式：优先读环境变量，正式发布注册 GitLite 官方 App 后替换占位
export const GITLITE_GITEE_CLIENT_ID = 'gitlite-placeholder';

export function resolveGiteeClientId(): string {
  return process.env.GITLITE_GITEE_CLIENT_ID
    ?? process.env.GITLITE_CLIENT_ID
    ?? GITLITE_GITEE_CLIENT_ID;
}

export interface GiteeTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
}

/** 授权 URL（授权码流 + state；scope/code_challenge 可选） */
export function giteeAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
  codeChallenge?: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    state: opts.state
  });
  if (opts.scope) q.set('scope', opts.scope);
  if (opts.codeChallenge) {
    q.set('code_challenge', opts.codeChallenge);
    q.set('code_challenge_method', 'S256');
  }
  return `${GITEE_AUTHORIZE_URL}?${q.toString()}`;
}

/** 授权码换 token（Gitee token 端点：POST 表单，JSON 响应） */
export async function exchangeGiteeCode(fetchFn: typeof fetch, opts: {
  clientId: string;
  code: string;
  redirectUri: string;
  clientSecret?: string;
  codeVerifier?: string;
}): Promise<GiteeTokens> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri
  };
  if (opts.clientSecret) params.client_secret = opts.clientSecret;
  if (opts.codeVerifier) params.code_verifier = opts.codeVerifier;
  return await tokenRequest(fetchFn, params);
}

/** refresh_token 续期（Gitee access_token 默认 1 天，需续期） */
export async function refreshGiteeToken(fetchFn: typeof fetch, opts: {
  clientId: string;
  refreshToken: string;
  clientSecret?: string;
  redirectUri?: string;
}): Promise<GiteeTokens> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId
  };
  if (opts.clientSecret) params.client_secret = opts.clientSecret;
  if (opts.redirectUri) params.redirect_uri = opts.redirectUri;
  return await tokenRequest(fetchFn, params);
}

async function tokenRequest(fetchFn: typeof fetch, params: Record<string, string>): Promise<GiteeTokens> {
  let res: Response;
  try {
    res = await fetchFn(GITEE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString()
    });
  } catch (e) {
    throw new NetworkError(`gitee oauth unreachable: ${String(e)}`);
  }
  const data: any = await res.json().catch(() => null);
  if (!data?.access_token) {
    throw new AuthError(`gitee oauth token error: ${data?.error ?? 'unknown'}${data?.error_description ? ` (${data.error_description})` : ''}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? null,
    scope: data.scope ?? null
  };
}
