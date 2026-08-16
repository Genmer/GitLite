// gitlite setup（引导配置模块终端版）：检测 → OAuth 登记/PAT → 保存 → 可选立即登录。
// 页面版为 @gitlite/ui 的 <GitLiteSetup>；本命令供 CLI/SSH 场景同流程引导。
import * as readline from 'node:readline/promises';
import type { RuntimeAdapter } from '@gitlite/core';
import {
  authStatus, saveOAuthApp, getOAuthApp, giteeLogin, interactiveLogin,
  GitHubProvider, GiteeProvider
} from '@gitlite/sdk';

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const c = (s: string) => `\x1b[36m${s}\x1b[0m`;
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

const GUIDE = {
  github: {
    name: 'GitHub', registerUrl: 'https://github.com/settings/applications/new',
    callback: 'http://localhost（Device Flow 不使用回调，可随意填）',
    scopes: '无需勾权限；创建后进入应用详情页勾选 Enable Device Flow',
    tokenUrl: 'https://github.com/settings/tokens/new'
  },
  gitee: {
    name: 'Gitee', registerUrl: 'https://gitee.com/oauth/applications/new',
    callback: 'http://127.0.0.1:18365/callback',
    scopes: '权限勾选 projects 与 user_info',
    tokenUrl: 'https://gitee.com/profile/personal_access_tokens/new'
  }
} as const;

type Provider = keyof typeof GUIDE;

export async function setupCmd(args: Record<string, string>, runtime: RuntimeAdapter): Promise<number> {
  const status = await authStatus(runtime);

  if (args.check) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();
  try {
    console.log(b('\n════════ GitLite 引导配置 ════════'));
    for (const p of ['github', 'gitee'] as const) {
      const s = status[p];
      console.log(`  ${GUIDE[p].name}: ${s.oauthApp ? g('✅ OAuth 应用已登记') : y('⬜ OAuth 应用未登记')}  ${s.token ? g('✅ 已登录') : y('⬜ 未登录')}`);
    }

    const pv = await ask(`\n配置哪个平台？ ${b('1')} GitHub / ${b('2')} Gitee / 回车跳过：`);
    if (pv === '') { console.log('已跳过（可随时重跑 gitlite setup）'); return 0; }
    const provider: Provider = pv === '2' ? 'gitee' : 'github';
    const guide = GUIDE[provider];

    const way = await ask(`配置方式： ${b('1')} OAuth 应用登记（推荐，浏览器点一下登录） / ${b('2')} 粘贴私人令牌 PAT：`);
    if (way === '2') {
      console.log(`\n打开令牌页创建（${guide.scopes}）：\n  ${c(guide.tokenUrl)}\n`);
      const token = await ask('粘贴 Token：');
      if (!token) { console.error('✗ 令牌为空'); return 1; }
      const p = provider === 'gitee'
        ? new GiteeProvider(token, runtime.fetch)
        : new GitHubProvider(token, runtime.fetch);
      const { login } = await p.getUser!(); // 校验失败抛错
      await runtime.credential.set(`gitlite:${provider}:default`, token);
      console.log(`${g('✓')} 令牌有效，已登录为 ${c(`@${login}`)}（存入本地凭据库）`);
      return 0;
    }

    console.log(`\n登记一次即可（约 1 分钟）：
  1. 打开 ${c(guide.registerUrl)}
  2. 回调地址填 ${b(guide.callback)}
  3. ${guide.scopes}
  4. 创建后复制 Client ID${provider === 'gitee' ? ' 和 Client Secret' : ''}
`);
    const clientId = await ask('粘贴 Client ID：');
    if (!clientId) { console.error('✗ Client ID 为空'); return 1; }
    const clientSecret = provider === 'gitee' ? await ask('粘贴 Client Secret：') : '';
    if (provider === 'gitee' && !clientSecret) { console.error('✗ Client Secret 为空'); return 1; }

    await saveOAuthApp(runtime, provider, { clientId, clientSecret: clientSecret || undefined });
    console.log(`${g('✓')} 已保存到 ~/.gitlite/app-config.json（全机生效，之后登录/向导自动使用）`);

    const now = await ask('\n现在就登录连接吗？ y/N：');
    if (now.toLowerCase() !== 'y') { console.log('好的——之后任意入口（CLI/UI/initDB）会自动用这份配置'); return 0; }
    if (provider === 'gitee') {
      const app = await getOAuthApp(runtime, 'gitee');
      void app;
      await giteeLogin({
        runtime,
        clientId, clientSecret: clientSecret || undefined,
        onCode: url => console.log(`  ${y('⣿')} 浏览器打开并授权：\n        ${c(url)}`)
      });
    } else {
      await interactiveLogin(runtime, (code, uri) => {
        console.log(`  ${y('⣿')} 打开 ${c(uri)} 输入代码：${b(code)}`);
      }, { clientId });
    }
    console.log(`${g('✓')} 登录成功，token 已存本地凭据库。下一步即可 gitlite data/repl/initDB 直连`);
    return 0;
  } finally {
    rl.close();
  }
}
