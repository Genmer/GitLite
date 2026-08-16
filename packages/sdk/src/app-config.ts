// 应用级配置（sdk）：~/.gitlite/app-config.json
// 存 OAuth 应用凭据（ClientID/Secret——登记一次全机生效）；用户 token 一律走凭据库，不落此文件。
import type { RuntimeAdapter } from '@gitlite/core';

const CONFIG_PATH = '~/.gitlite/app-config.json';

export interface AppConfig {
  oauth?: {
    github?: { clientId: string };
    gitee?: { clientId: string; clientSecret?: string };
  };
}

export type SetupProvider = 'github' | 'gitee';

export async function readAppConfig(runtime: RuntimeAdapter): Promise<AppConfig> {
  try {
    const parsed = JSON.parse(await runtime.fs.readFile(CONFIG_PATH));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 按 provider 级合并写入（保留其他平台的配置） */
export async function writeAppConfig(runtime: RuntimeAdapter, next: AppConfig): Promise<void> {
  const cur = await readAppConfig(runtime);
  const merged: AppConfig = { oauth: { ...cur.oauth, ...next.oauth } };
  const data = JSON.stringify(merged, null, 2);
  // Windows 下防病毒/瞬时占用写文件会间歇抛 EPERM：就地重试几次再放弃
  for (let i = 0; i < 5; i++) {
    try {
      await runtime.fs.writeFile(CONFIG_PATH, data);
      return;
    } catch (e: any) {
      if (e?.code !== 'EPERM' || i === 4) throw e;
      await new Promise(r => setTimeout(r, 150 * (i + 1)));
    }
  }
}

/** 保存 OAuth 应用凭据（引导配置模块调用） */
export async function saveOAuthApp(
  runtime: RuntimeAdapter,
  provider: SetupProvider,
  creds: { clientId: string; clientSecret?: string }
): Promise<void> {
  await writeAppConfig(runtime, {
    oauth: provider === 'gitee'
      ? { gitee: { clientId: creds.clientId, clientSecret: creds.clientSecret } }
      : { github: { clientId: creds.clientId } }
  });
}

/** 读取某平台的 OAuth 应用凭据（未配置返回空对象） */
export async function getOAuthApp(
  runtime: RuntimeAdapter,
  provider: SetupProvider
): Promise<{ clientId?: string; clientSecret?: string }> {
  const cfg = await readAppConfig(runtime);
  return (cfg.oauth?.[provider] as any) ?? {};
}

export interface ProviderAuthStatus {
  /** OAuth 应用已登记（ClientID 已配置） */
  oauthApp: boolean;
  /** 已有登录 token（凭据库） */
  token: boolean;
}

/** 引导配置首页的环境检测：两平台各自的就绪状态 */
export async function authStatus(runtime: RuntimeAdapter): Promise<Record<SetupProvider, ProviderAuthStatus>> {
  const cfg = await readAppConfig(runtime);
  const ghToken = await runtime.credential.get('gitlite:github:default');
  const geToken = await runtime.credential.get('gitlite:gitee:default');
  return {
    github: { oauthApp: !!cfg.oauth?.github?.clientId, token: !!ghToken },
    gitee: { oauthApp: !!cfg.oauth?.gitee?.clientId, token: !!geToken }
  };
}
