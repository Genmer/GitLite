// GitHub Device Flow（FR B1）：无 client_secret、免回调；UI 交互经回调注入（sdk/CLI 决定怎么展示）
import { AuthError, NetworkError } from '../errors.js';

const DEVICE_ENDPOINT = 'https://github.com/login/device/code';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';

// GitLite 官方预置 OAuth App（Device Flow 只需公开 client_id，见 04 §一）
// 正式发布：注册 GitLite 官方 App 后替换此常量。
// 当前（开发期）：优先读环境变量 GITLITE_DEVICE_CLIENT_ID / GITLITE_CLIENT_ID，便于真实链路测试。
export const GITLITE_GITHUB_CLIENT_ID = 'gitlite-placeholder';

/** Device Flow 请求超时：墙/网络不通时尽快失败，避免登录卡死（Host 层再给可执行提示） */
const REQUEST_TIMEOUT_MS = 15_000;

/** 带超时的 fetch：超时中止并抛普通 Error（避免出现误导性的 "aborted" 文案） */
async function request(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (ctrl.signal.aborted) throw new Error(`connect timeout (${REQUEST_TIMEOUT_MS / 1000}s 无响应): ${url} 不可达，请检查网络/代理`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export function resolveDeviceClientId(): string {
  return process.env.GITLITE_DEVICE_CLIENT_ID
    ?? process.env.GITLITE_CLIENT_ID
    ?? GITLITE_GITHUB_CLIENT_ID;
}

export interface DeviceFlowCallbacks {
  /** 展示 user_code 与验证链接（CLI 打印 / GUI 弹窗） */
  onCode(userCode: string, verificationUri: string): void;
}

export async function deviceFlowLogin(
  fetchFn: typeof fetch,
  cb: DeviceFlowCallbacks,
  opts?: { clientId?: string; scope?: string; sleep?: (ms: number) => Promise<void> }
): Promise<{ token: string }> {
  const clientId = opts?.clientId ?? resolveDeviceClientId();
  const scope = opts?.scope ?? 'repo read:user';
  const sleep = opts?.sleep ?? defaultSleep;
  const res = await request(fetchFn, DEVICE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope })
  }).catch(e => { throw new NetworkError(String(e)); });
  const code: any = await res.json();
  if (!code.device_code) throw new AuthError(`device code request failed: ${JSON.stringify(code)}`);

  cb.onCode(code.user_code, code.verification_uri);

  let interval = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const tokenRes = await request(fetchFn, TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    }).catch(e => { throw new NetworkError(String(e)); });
    const data: any = await tokenRes.json();
    if (data.access_token) return { token: data.access_token };
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval += 5000; continue; }
    if (data.error === 'expired_token') throw new AuthError('device code expired, retry login');
    throw new AuthError(`device flow error: ${data.error ?? 'unknown'}`);
  }
  throw new AuthError('device flow timeout');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
