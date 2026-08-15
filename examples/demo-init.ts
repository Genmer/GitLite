// GitLite initDB 初始化演示（memory provider 模拟远端 Git，零外部依赖，开箱即跑）
// 运行：npx tsx examples/demo-init.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDB } from '@gitlite/sdk';
import { MemoryProvider } from '@gitlite/core';

// 演示环境隔离：bindings/队列写入临时目录，不污染真实 ~/.gitlite
const demoHome = mkdtempSync(join(tmpdir(), 'gitlite-demo-'));
process.env.USERPROFILE = demoHome;
process.env.HOME = demoHome;

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const c = (s: string) => `\x1b[36m${s}\x1b[0m`;
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

const LABELS: Record<string, string> = {
  'start': '启动初始化',
  'probe-repo': '检查仓库',
  'create-repo': '仓库不存在，自动创建（私有）',
  'probe-branch': '检查数据库分支',
  'create-branch': '创建数据库分支',
  'check-repo': '仓库三态检查（空 / GitLite / 外来）',
  'startup': '写入系统文件（bootstrap）并同步',
  'ready': '连接就绪',
};

async function main(): Promise<void> {
  console.log(b('\n══════════ GitLite initDB 初始化演示 ══════════'));
  console.log(`演示环境目录（隔离，不碰真实 ~/.gitlite）：${c(demoHome)}\n`);

  // 共享同一个 MemoryProvider —— 相当于"远端 Git 一直在那"
  const remote = new MemoryProvider();
  const base = {
    provider: 'memory' as const,
    owner: 'demo-user',
    repo: 'gitlite-repo',
    database: 'demo-db',
    providerInstance: remote
  };

  // ─── 第 1 次：首次 initDB() → 触发完整初始化 ───
  console.log(b('[第 1 次] 首次调用 initDB() —— 应触发完整初始化\n'));
  const db = await initDB({
    ...base,
    onProgress: (step, detail) => {
      const extra = detail?.ref ? ` → ${c(`${detail.ref.owner}/${detail.ref.repo}`)}`
        : detail?.branch ? ` → ${c(String(detail.branch))}` : '';
      console.log(`  ${g('✓')} ${LABELS[step] ?? step}${extra}`);
    }
  });

  // 写一条数据 + 读回，证明数据库可用
  const users = db.collection('users');
  const id = await users.insertOne({ email: 'alice@demo.dev', name: 'Alice', age: 30 });
  const back: any = await users.findOne({ email: 'alice@demo.dev' });
  console.log(`\n  ${g('✓')} 写入并读回：${back.name} <${back.email}>`);
  console.log(`  ${g('✓')} 自动生成 ULID 主键：${id}`);
  await db.close(); // 退出强制同步（推送到"远端"）

  // 看看"远端仓库"被铺成了什么样
  const files = await remote.getFiles({ owner: 'demo-user', repo: 'gitlite-repo' }, 'gitlite/demo-db');
  console.log(`\n  ${b('远端仓库文件布局（bootstrap 产物 + 数据）：')}`);
  for (const k of [...files!.keys()].sort()) console.log(`    ${c(k)}`);

  // ─── 第 2 次：再次 initDB() → 幂等静默直连 ───
  console.log(b('\n[第 2 次] 再次调用 initDB() —— 应静默直连（幂等，不再触发初始化）\n'));
  const db2 = await initDB({
    ...base,
    onProgress: (step) => {
      if (step === 'reconnect') console.log(`  ${g('✓')} 检测到本地绑定记录 → 跳过初始化向导，直接连接`);
      if (step === 'create-repo' || step === 'create-branch') {
        console.log(`  ✗ 意外触发了初始化步骤：${step}（幂等性失败）`);
        process.exitCode = 1;
      }
    }
  });
  const still: any = await db2.collection('users').findOne({ email: 'alice@demo.dev' });
  const count = await db2.collection('users').count();
  console.log(`  ${g('✓')} 数据完好：${still?.name ?? '(丢失!)'}（共 ${count} 条）`);
  await db2.close();

  console.log(`\n${g(b('✅ 初始化成功'))} —— 首次自动建仓/建分支/写系统文件；二次静默直连、数据完好\n`);
}

main().catch(e => {
  console.error('初始化失败:', e);
  process.exit(1);
});
