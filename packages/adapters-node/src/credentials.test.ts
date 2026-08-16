// OS 凭据库测试（docs/13 功能轨第 10 项）：平台分支命令形态、ENOENT 粘性降级、文件回退
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOsCredentialStore, type Runner } from './credentials.js';

function recRunner(handle: (cmd: string, args: string[], opts?: { stdin?: string }) =>
  { code: number; stdout: string; stderr: string } | 'ENOENT'): Runner & { calls: any[] } {
  const calls: any[] = [];
  const fn = (async (cmd: string, args: string[], opts?: { stdin?: string }) => {
    calls.push({ cmd, args, stdin: opts?.stdin });
    const r = handle(cmd, args, opts);
    if (r === 'ENOENT') throw new Error(`ENOENT: ${cmd}`);
    return r;
  }) as any;
  fn.calls = calls;
  return fn;
}

const tmpDir = () => mkdtempSync(join(tmpdir(), 'gitlite-cred-'));

describe('createOsCredentialStore（darwin = security CLI）', () => {
  it('set/get/delete 命令形态；不存在（exit 44）→ null', async () => {
    const dir = tmpDir();
    const runner = recRunner((cmd, args) => {
      if (args[0] === 'find-generic-password') {
        if (args[1] === '-a' && args[2] === 'missing') return { code: 44, stdout: '', stderr: 'not found' };
        return { code: 0, stdout: 'tok123\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const store = createOsCredentialStore({ runner, platform: 'darwin', fallbackDir: dir });
    expect(store.backend()).toBe('os');
    await store.set('gitlite:github:default', 'tok123');
    expect(runner.calls[0]).toMatchObject({ cmd: 'security' });
    expect(runner.calls[0]!.args).toContain('add-generic-password');
    expect(runner.calls[0]!.args).toContain('-U');            // 幂等更新
    expect(runner.calls[0]!.args).toContain('tok123');
    expect(await store.get('gitlite:github:default')).toBe('tok123');
    expect(await store.get('missing')).toBeNull();
    await store.delete('gitlite:github:default');
    expect(runner.calls.some(c => c.args[0] === 'delete-generic-password')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('工具缺失（ENOENT）→ 粘性降级文件存储，且后续不再调 CLI', async () => {
    const dir = tmpDir();
    const runner = recRunner(() => 'ENOENT');
    const store = createOsCredentialStore({ runner, platform: 'darwin', fallbackDir: dir });
    await store.set('k1', 'v1');
    expect(store.backend()).toBe('file');
    expect(await store.get('k1')).toBe('v1');
    expect(runner.calls.length).toBe(1);                      // 降级后不再尝试
    await store.delete('k1');
    expect(await store.get('k1')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('CLI 真实失败（非 ENOENT）→ 上抛，不静默降级', async () => {
    const dir = tmpDir();
    const runner = recRunner(() => ({ code: 45, stdout: '', stderr: 'keychain locked' }));
    const store = createOsCredentialStore({ runner, platform: 'darwin', fallbackDir: dir });
    await expect(store.get('k')).rejects.toThrow(/security find failed|keychain/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('createOsCredentialStore（linux = secret-tool）', () => {
  it('store 走 stdin（不进 argv）；lookup 空输出 → null', async () => {
    const dir = tmpDir();
    const runner = recRunner((cmd, args) => {
      if (args[0] === 'lookup') {
        return args.includes('hit') ? { code: 0, stdout: 'sec-value', stderr: '' }
                                    : { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const store = createOsCredentialStore({ runner, platform: 'linux', fallbackDir: dir });
    await store.set('hit', 'sec-value');
    const storeCall = runner.calls[0]!;
    expect(storeCall.cmd).toBe('secret-tool');
    expect(storeCall.args[0]).toBe('store');
    expect(storeCall.stdin).toBe('sec-value');                // 密文走 stdin
    expect(storeCall.args).not.toContain('sec-value');        // 不出现在 argv
    expect(await store.get('hit')).toBe('sec-value');
    expect(await store.get('miss')).toBeNull();
    await store.delete('hit');
    expect(runner.calls.some(c => c.args[0] === 'clear')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('createOsCredentialStore（win32 等其余平台 = 文件回退）', () => {
  it('不触 CLI，直接文件存储', async () => {
    const dir = tmpDir();
    const runner = recRunner(() => ({ code: 0, stdout: '', stderr: '' }));
    const store = createOsCredentialStore({ runner, platform: 'win32', fallbackDir: dir });
    expect(store.backend()).toBe('file');
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    expect(runner.calls.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
