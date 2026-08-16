// 格式版本门禁测试（ADR-002 · 1.0.0 冻结）：读旧兼容 + 拒读未来主版本
import { describe, expect, it } from 'vitest';
import { MemoryProvider } from './provider/memory.js';
import { GitLiteClient } from './client.js';
import { createTestRuntime } from './test/runtime.js';
import { FormatVersionError } from './errors.js';
import { SYS } from './types.js';

const ref = { owner: 'fmt', repo: 'gitlite-repo' };

/** 预置带指定 formatVersion 的 gitlite 分支 */
async function seededProvider(formatVersion: string): Promise<MemoryProvider> {
  const p = new MemoryProvider();
  await p.createRepo(ref, { private: true, autoInit: true });
  await p.createBranch(ref, 'gitlite/default', 'main');
  await p.commit(ref, 'gitlite/default', 'seed', [
    { kind: 'put', path: SYS.configPath, content: JSON.stringify({ formatVersion, createdBy: 'gitlite@0.1.0' }, null, 2) }
  ]);
  return p;
}

describe('格式版本门禁（ADR-002 / 1.0.0 冻结）', () => {
  it('当前客户端写出的仓库 formatVersion = 1.0.0', async () => {
    const p = new MemoryProvider();
    const client = await GitLiteClient.create({ provider: p, runtime: createTestRuntime(), ref, database: 'default' });
    await client.close();
    const files = (await p.getFiles(ref, 'gitlite/default'))!;
    expect(JSON.parse(files.get(SYS.configPath)!).formatVersion).toBe('1.0.0');
  });

  it('0.x 旧仓库可读：连接成功不抛（additive-only 读兼容）', async () => {
    const p = await seededProvider('0.1.0');
    const client = await GitLiteClient.create({ provider: p, runtime: createTestRuntime(), ref, database: 'default' });
    expect(client.syncStatus().online).toBe(true);
    await client.close();
  });

  it('2.x 未来仓库拒读：FormatVersionError', async () => {
    const p = await seededProvider('2.0.0');
    await expect(GitLiteClient.create({
      provider: p, runtime: createTestRuntime(), ref, database: 'default'
    })).rejects.toBeInstanceOf(FormatVersionError);
  });

  it('同版本仓库静默（无告警）', async () => {
    const p = await seededProvider(SYS.formatVersion);
    const client = await GitLiteClient.create({ provider: p, runtime: createTestRuntime(), ref, database: 'default' });
    // startup 已跑过：若版本不一致会在 create 内 emit；同版本无异常即通过
    expect(client.syncStatus().online).toBe(true);
    await client.close();
  });
});
