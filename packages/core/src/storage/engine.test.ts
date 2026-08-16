import { describe, expect, it } from 'vitest';
import { MemoryProvider } from '../provider/memory.js';
import { GitLiteClient } from '../client.js';
import { createTestRuntime } from '../test/runtime.js';
import { SYS, type Document } from '../types.js';

// 集成底座：client + MemoryProvider（P1 §5 测试策略）
export async function makeClient(opts?: { database?: string; allowForeignRepo?: boolean; provider?: MemoryProvider }) {
  const provider = opts?.provider ?? new MemoryProvider();
  const runtime = createTestRuntime();
  const client = await GitLiteClient.create({
    provider, runtime,
    ref: { owner: 'test', repo: 'gitlite-repo' },
    database: opts?.database ?? 'default',
    allowForeignRepo: opts?.allowForeignRepo
  });
  return { client, provider, runtime };
}

describe('存储引擎：行级分层 + diff（FR D3/A4）', () => {
  it('L0 inline：<50 行落单 jsonl 文件', async () => {
    const { client, provider, runtime } = await makeClient();
    const c = client.collection('cfg');
    await c.insertOne({ k: 1 });
    await client.sync.flush();
    const files = (await provider.getFiles({ owner: 'test', repo: 'gitlite-repo' }, 'gitlite/default'))!;
    expect(files.has('cfg.jsonl')).toBe(true);
    expect(files.has(SYS.configPath)).toBe(true);          // bootstrap（A5）
    expect(files.has(SYS.headPath)).toBe(true);            // 冻结结构
    expect(files.get(SYS.configPath)).toContain('"1.0.0"'); // 冻结格式版本（ADR-002）
    void runtime;
  });

  it('L1 doc-per-file：跨过 50 行后一行一文件，跨级读取一致', async () => {
    const { client, provider } = await makeClient();
    const c = client.collection('users');
    for (let i = 0; i < 55; i++) await c.insertOne({ n: i });
    await client.sync.flush();
    const files = (await provider.getFiles({ owner: 'test', repo: 'gitlite-repo' }, 'gitlite/default'))!;
    const perFile = [...files.keys()].filter(k => /^users\/.+\.json$/.test(k));
    expect(perFile.length).toBe(55);
    expect(files.has('users.jsonl')).toBe(false);
    // 跨级透明：重连读取全量
    const rt2 = createTestRuntime();
    const c2 = await GitLiteClient.create({
      provider, runtime: rt2,
      ref: { owner: 'test', repo: 'gitlite-repo' }, database: 'default'
    });
    expect(await c2.collection('users').count()).toBe(55);
    await c2.close();
  });

  it('L2 sharded：>5000 行转分片 jsonl，分片 ≤1000 行', async () => {
    const { client, provider } = await makeClient();
    const c = client.collection('events');
    await Promise.all(Array.from({ length: 5001 }, (_, i) => c.insertOne({ n: i })));
    await client.sync.flush();
    const files = (await provider.getFiles({ owner: 'test', repo: 'gitlite-repo' }, 'gitlite/default'))!;
    const shards = [...files.keys()].filter(k => /^events\/shard-\d{4}\.jsonl$/.test(k));
    expect(shards.length).toBe(6); // 5001/1000
    const rows = shards.map(s => files.get(s)!.split('\n').filter(Boolean).length);
    expect(Math.max(...rows)).toBeLessThanOrEqual(1000);
  }, 60_000);

  it('diff 永不删除用户文件（foreign 承诺）', async () => {
    const provider = new MemoryProvider();
    const ref = { owner: 'test', repo: 'mixed' };
    await provider.createRepo(ref, { private: true, autoInit: true });
    // 直接在 main 预置用户文件 + 建分支
    await provider.commit(ref, 'main', 'seed', [
      { kind: 'put', path: 'README.md', content: '# x' },
      { kind: 'put', path: 'src/app.js', content: 'x' }
    ]);
    await provider.createBranch(ref, 'gitlite/default', 'main');
    const client = await GitLiteClient.create({
      provider, runtime: createTestRuntime(), ref, database: 'default', allowForeignRepo: true
    });
    await client.collection('t').insertOne({ a: 1 });
    await client.sync.flush();
    const files = (await provider.getFiles(ref, 'gitlite/default'))!;
    expect(files.has('README.md')).toBe(true);   // 用户文件保留
    expect(files.has('src/app.js')).toBe(true);
    expect(files.has('t.jsonl')).toBe(true);     // gitlite 数据写入
    await client.close();
  });

  it('迁移记录写入 _migrations（级别变更留痕）', async () => {
    const { client, provider } = await makeClient();
    const c = client.collection('m');
    for (let i = 0; i < 51; i++) await c.insertOne({ n: i });
    await client.sync.flush();
    const files = (await provider.getFiles({ owner: 'test', repo: 'gitlite-repo' }, 'gitlite/default'))!;
    const mig = [...files.keys()].filter(k => k.startsWith(`${SYS.migrationsDir}/`) && k.includes('tier-'));
    expect(mig.length).toBeGreaterThanOrEqual(1);
  });
});

describe('仓库检查三态（FR A4/D6）', () => {
  it('foreign 仓库：未确认抛 ForeignRepoError 且带文件清单；确认后可写且用户文件保留', async () => {
    const provider = new MemoryProvider();
    const ref = { owner: 'test', repo: 'foreign' };
    await provider.createRepo(ref, { private: true });
    await provider.commit(ref, 'main', 'seed', [
      { kind: 'put', path: 'a.txt', content: '1' },
      { kind: 'put', path: 'b/c.txt', content: '2' }
    ]);
    await provider.createBranch(ref, 'gitlite/default', 'main');
    await expect(GitLiteClient.create({
      provider, runtime: createTestRuntime(), ref, database: 'default'
    })).rejects.toMatchObject({ name: 'ForeignRepoError', files: ['a.txt', 'b/c.txt'] });

    // 确认（allowForeignRepo）→ 可写；承诺兑现：用户文件原样保留
    const client = await GitLiteClient.create({
      provider, runtime: createTestRuntime(), ref, database: 'default', allowForeignRepo: true
    });
    await client.collection('x').insertOne({ a: 1 });
    await client.close();
    const files = (await provider.getFiles(ref, 'gitlite/default'))!;
    expect(files.get('a.txt')).toBe('1');
    expect(files.get('b/c.txt')).toBe('2');
    expect(files.has('x.jsonl')).toBe(true);
    expect(files.has(SYS.configPath)).toBe(true);   // 只添加系统文件
  });

  it('formatVersion 门禁：repo major 更新则拒绝打开（D6；1.0.0 冻结 → 2.x 为未来版）', async () => {
    const provider = new MemoryProvider();
    const ref = { owner: 'test', repo: 'future' };
    await provider.createRepo(ref, { private: true });
    await provider.commit(ref, 'main', 'init', [
      { kind: 'put', path: SYS.configPath, content: JSON.stringify({ formatVersion: '2.0.0' }) }
    ]);
    await provider.createBranch(ref, 'gitlite/default', 'main');
    await expect(GitLiteClient.create({
      provider, runtime: createTestRuntime(), ref, database: 'default', allowForeignRepo: true
    })).rejects.toMatchObject({ name: 'FormatVersionError' });
  });
});
