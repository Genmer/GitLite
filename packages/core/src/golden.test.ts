// 黄金仓库快照（NFR-5 / M9）：格式稳定性回归基线。
// 首次运行生成 fixtures/golden-v0.1.json；此后每次运行必须逐字节复现（_migrations 时间戳文件除外）。
// 这是「格式宪法」的机器执行：additive-only 的最低保障。
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryProvider } from './provider/memory.js';
import { GitLiteClient } from './client.js';
import { createTestRuntime } from './test/runtime.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'golden-v0.1.json');

// 固定 ID + 固定时间戳 → 快照稳定
const fixedUsers = Array.from({ length: 55 }, (_, i) => ({
  _id: `GOLDENUSER${String(i).padStart(4, '0')}`,
  email: `u${i}@golden.dev`,
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z'
}));

async function buildGoldenFiles(): Promise<Record<string, string>> {
  const provider = new MemoryProvider();
  const ref = { owner: 'golden', repo: 'gitlite-repo' };
  const client = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref, database: 'default' });
  await client.putSchema('users', {
    type: 'object',
    gitliteDescriptor: { collection: 'users', timestamps: true },
    properties: {
      _id: { type: 'string' },
      email: { type: 'string', format: 'email', 'x-gitlite-unique': true, 'x-gitlite-indexed': true }
    },
    required: ['email']
  });
  const users = client.collection('users');
  for (const u of fixedUsers) await users.insertOne(u as any);
  await client.close();
  const files = (await provider.getFiles(ref, 'gitlite/default'))!;
  const out: Record<string, string> = {};
  for (const [k, v] of files!) if (!k.startsWith('_migrations/')) out[k] = v;
  return out;
}

describe('黄金仓库快照（NFR-5 格式稳定性）', () => {
  it('export 与 golden 逐字节一致（首次运行生成基线）', async () => {
    const files = await buildGoldenFiles();
    if (!existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, JSON.stringify(files, null, 2));
      console.log(`[golden] baseline created: ${FIXTURE}`);
      return;
    }
    const golden: Record<string, string> = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(Object.keys(files).sort()).toEqual(Object.keys(golden).sort());
    for (const k of Object.keys(golden)) {
      expect(files[k], `file diverged: ${k}`).toBe(golden[k]);
    }
  });
});
