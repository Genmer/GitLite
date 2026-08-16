import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './index.js';

// CLI 会写 ~/.gitlite（队列/凭据）→ 测试期把 home 重定向到临时目录
const realHome = process.env.USERPROFILE ?? process.env.HOME;
let tmpHome = '';
beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gitlite-cli-'));
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
});
afterAll(() => {
  process.env.USERPROFILE = realHome;
  process.env.HOME = realHome;
});

describe('CLI 冒烟（FR J 组）', () => {
  it('help 退出码 0；未知命令 2', async () => {
    expect(await run(['help'])).toBe(0);
    expect(await run(['nope'])).toBe(2);
  });

  it('data insert/find/count（memory provider URI 全链路）', async () => {
    const uri = 'gitlite://memory:t@me/gitlite-repo/default';
    expect(await run(['data', 'insert', 'users', '--doc', '{"email":"a@x.com"}', '--db', uri])).toBe(0);
    expect(await run(['data', 'find', 'users', '--db', uri])).toBe(0);
    expect(await run(['data', 'count', 'users', '--db', uri])).toBe(0); // memory 实例不跨进程共享 → 0
  });

  it('sync status（memory URI）', async () => {
    expect(await run(['sync', 'status', '--db', 'gitlite://memory:t@me/gitlite-repo/default'])).toBe(0);
  });

  it('setup --check：打印两平台状态 JSON 退出 0', async () => {
    expect(await run(['setup', '--check'])).toBe(0);
  });

  it('缺 --db 报错退出 2', async () => {
    expect(await run(['data', 'find', 'x'])).toBe(2);
  });

  it('codegen：本地 schema 目录 → 生成强类型 Client', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlite-cli-codegen-'));
    writeFileSync(join(dir, 'users.schema.jsonc'),
      '{ "properties": { "email": { "type": "string" } }, "required": ["email"] }');
    const out = join(dir, 'generated');
    expect(await run(['codegen', '--schema', dir, '--out', out])).toBe(0);
    expect(existsSync(join(out, 'gitlite.types.ts'))).toBe(true);
    expect(readFileSync(join(out, 'gitlite.client.ts'), 'utf8')).toContain('TypedGitLiteClient');
    rmSync(dir, { recursive: true, force: true });
    // 空目录 → 退出 1（错误信息不炸）
    const empty = mkdtempSync(join(tmpdir(), 'gitlite-cli-codegen-empty-'));
    expect(await run(['codegen', '--schema', empty, '--out', join(empty, 'g')])).toBe(1);
    rmSync(empty, { recursive: true, force: true });
  });
});
