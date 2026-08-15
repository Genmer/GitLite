// GitLite 真实初始化演示（真实 GitHub Device Flow，零 mock）
// 用户只需要做一次准备：提供一个启用了 Device Flow 的 OAuth App client_id
// 运行：npx tsx examples/demo-real.ts <client_id>   （或设环境变量 GITLITE_CLIENT_ID）
import { exec } from 'node:child_process';
import { initDB } from '@gitlite/sdk';

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const c = (s: string) => `\x1b[36m${s}\x1b[0m`;
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* 打开失败无妨，用户可手动复制链接 */ });
}

const LABELS: Record<string, string> = {
  'start': '启动初始化',
  'login': '触发登录（GitHub Device Flow）',
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
  const clientId = process.argv[2] ?? process.env.GITLITE_CLIENT_ID;

  console.log(b('\n════════ GitLite 真实初始化演示（真实 GitHub，无 mock）════════\n'));

  if (!clientId) {
    console.log(`缺少 OAuth App ${y('client_id')}。准备一次即可（约 1 分钟）：

  1. 打开 ${c('https://github.com/settings/developers')} → ${b('OAuth Apps')} → ${b('New OAuth App')}
  2. 随便填名称（如 gitlite）/ Homepage URL（可填 http://localhost）
     Callback URL 可填 ${c('http://localhost')}（Device Flow 不会用到它）
  3. ${y('重要')}：创建后进入 App 详情页 → 勾选 ${b('Enable Device Flow')} → Save
  4. 复制 ${b('Client ID')}（公开的，不需要 Client Secret）

然后运行：
  ${c('npx tsx examples/demo-real.ts <你的ClientID>')}
`);
    process.exit(2);
  }

  // Device Flow client_id 经环境变量传给 core（core 不为此增加全局状态）
  process.env.GITLITE_DEVICE_CLIENT_ID = clientId;

  const db = await initDB({
    provider: 'github',
    repo: 'gitlite-repo',
    database: 'demo-db',
    onLoginCode: (code, uri) => {
      console.log(`\n  ${y('⣿ 登录')} 打开浏览器并输入一次性代码：${b(code)}`);
      console.log(`        ${c(uri)}（已尝试自动打开浏览器）\n`);
      openBrowser(uri);
    },
    onProgress: (step, detail) => {
      const extra = detail?.ref ? ` → ${c(`${detail.ref.owner}/${detail.ref.repo}`)}`
        : detail?.branch ? ` → ${c(String(detail.branch))}`
        : detail?.login ? ` → ${c(`@${detail.login}`)}` : '';
      console.log(`  ${g('✓')} ${LABELS[step] ?? step}${extra}`);
    }
  });

  // 全自动到这里：登录 ✓ 识别账号 ✓ 建仓 ✓ 建分支 ✓ bootstrap ✓
  const users = db.collection('users');
  const id = await users.insertOne({ email: 'hello@real-test.dev', name: 'RealTest' });
  const back: any = await users.findOne({ email: 'hello@real-test.dev' });
  console.log(`\n  ${g('✓')} 写入并读回：${back.name} <${back.email}>（ULID: ${id}）`);
  await db.close(); // 退出强制同步 → 真实 push 到你 GitHub 账号

  console.log(`\n${g(b('✅ 初始化成功（真实链路）'))}`);
  console.log(`   打开 https://github.com/<你的用户名>/gitlite-repo （分支 gitlite/demo-db）即可看到数据库文件\n`);
}

main().catch(e => {
  console.error('\n初始化失败:', e.message ?? e);
  process.exit(1);
});
