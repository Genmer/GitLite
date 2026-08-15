import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
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

  it('缺 --db 报错退出 2', async () => {
    expect(await run(['data', 'find', 'x'])).toBe(2);
  });
});
