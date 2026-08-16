// GitLite 真实初始化演示（真实 Gitee OAuth 授权码 + loopback，零 mock）
// 用户只需做一次登记（约 1 分钟）：在 Gitee 注册一个 OAuth 应用并复制 ClientID/Secret
// 运行：npx tsx examples/demo-gitee-oauth.ts <client_id> <client_secret>
//      （或设环境变量 GITLITE_GITEE_CLIENT_ID / GITLITE_GITEE_CLIENT_SECRET）
import { exec } from 'node:child_process';
import { giteeLogin, initDB } from '@gitlite/sdk';

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const c = (s: string) => `\x1b[36m${s}\x1b[0m`;
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* 打开失败无妨，手动复制链接即可 */ });
}

const LABELS: Record<string, string> = {
  'start': '启动初始化',
  'identity': '登录成功，自动识别账号',
  'probe-repo': '检查仓库',
  'create-repo': '仓库不存在 → 自动创建（私有）',
  'probe-branch': '检查数据库分支',
  'create-branch': '创建数据库分支',
  'check-repo': '仓库三态检查',
  'startup': '写入系统文件（bootstrap）并同步',
  'ready': '连接就绪',
};

async function main(): Promise<void> {
  const clientId = process.argv[2] ?? process.env.GITLITE_GITEE_CLIENT_ID;
  const clientSecret = process.argv[3] ?? process.env.GITLITE_GITEE_CLIENT_SECRET;

  console.log(b('\n════════ GitLite 真实初始化演示（真实 Gitee，无 mock）════════\n'));

  if (!clientId || !clientSecret) {
    console.log(`缺少 OAuth 应用凭据。${y('登记一次即可（约 1 分钟，网页操作无法 API 代做）')}：

  1. 打开 ${c('https://gitee.com/oauth/applications/new')}
     （或 gitee.com → 设置 → 第三方应用 → 创建应用）
  2. 表单填：
       应用名称   gitlite（随意）
       回调地址   ${b('http://127.0.0.1:18365/callback')}   ${y('（必须一字不差）')}
       权限       勾选 ${b('projects')} 和 ${b('user_info')}
  3. 创建后复制 ${b('Client ID')} 和 ${b('Client Secret')}

然后运行：
  ${c('npx tsx examples/demo-gitee-oauth.ts <ClientID> <ClientSecret>')}

之后会自动：弹浏览器授权 → 换 token → 识别账号 → 建仓 gitlite-repo → 建分支
gitlite/demo-db → bootstrap → 写入并读回 → push 到你的 Gitee。
`);
    process.exit(2);
  }

  // ── 1. OAuth 登录（loopback 自动接回执，浏览器自动打开）──
  console.log(`  ${y('⣿ 登录')} 弹出浏览器授权页（已尝试自动打开；未弹出请手动复制下面的链接）`);
  const token = await giteeLogin({
    clientId, clientSecret,
    onCode: url => { console.log(`        ${c(url)}\n`); openBrowser(url); }
  });
  console.log(`  ${g('✓')} OAuth 登录成功，token 已存本地凭据库（gitlite:gitee:default）`);

  // ── 2. 全自动初始化：识别账号 → 建仓 → 建分支 → bootstrap ──
  const db = await initDB({
    provider: 'gitee',
    token,
    repo: 'gitlite-repo',
    database: 'demo-db',
    onProgress: (step, detail) => {
      const extra = detail?.ref ? ` → ${c(`${detail.ref.owner}/${detail.ref.repo}`)}`
        : detail?.branch ? ` → ${c(String(detail.branch))}`
        : detail?.login ? ` → ${c(`@${detail.login}`)}` : '';
      console.log(`  ${g('✓')} ${LABELS[step] ?? step}${extra}`);
    }
  });

  // ── 3. 写入并读回 → 退出强制同步（真实 push）──
  const users = db.collection('users');
  const id = await users.insertOne({ email: 'hello@gitee-test.dev', name: 'GiteeRealTest' });
  const back: any = await users.findOne({ email: 'hello@gitee-test.dev' });
  console.log(`\n  ${g('✓')} 写入并读回：${back.name} <${back.email}>（ULID: ${id}）`);
  await db.close();

  console.log(`\n${g(b('✅ Gitee 全链路初始化成功（OAuth → 建仓 → 建分支 → bootstrap → 写入 → push）'))}`);
  console.log(`   打开 https://gitee.com/<你的用户名>/gitlite-repo （分支 gitlite/demo-db）即可看到数据库文件\n`);
}

main().catch(e => {
  console.error('\n初始化失败:', e.message ?? e);
  process.exit(1);
});
