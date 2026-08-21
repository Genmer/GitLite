import { describe, expect, it, beforeEach } from 'vitest';
import { initDB, interactiveLogin, giteeLogin, OAuthAppNotConfiguredError } from './index.js';
import { MemoryProvider } from '@gitlite/core';
import type { RuntimeAdapter } from '@gitlite/core';

function createMockRuntime(): RuntimeAdapter {
  const store = new Map<string, string>();
  const creds = new Map<string, string>();
  return {
    fs: {
      readFile: async (f: string) => {
        if (!store.has(f)) throw new Error(`file not found: ${f}`);
        return store.get(f)!;
      },
      writeFile: async (f: string, d: string) => { store.set(f, d); },
      appendFile: async (f: string, d: string) => { store.set(f, (store.get(f) ?? '') + d); },
      exists: async (f: string) => store.has(f),
      mkdir: async () => {}
    },
    crypto: {
      randomBytes: (n: number) => new Uint8Array(n).fill(1),
      sha1hex: (s: string) => 'mocksha1'
    },
    credential: {
      get: async (k: string) => creds.get(k) ?? null,
      set: async (k: string, v: string) => { creds.set(k, v); },
      delete: async (k: string) => { creds.delete(k); }
    },
    fetch: globalThis.fetch,
    now: () => 1700000000000,
    onExit: () => {}
  };
}

describe('initDB 与认证安全机制', () => {
  it('MemoryProvider 模式初始化成功后不应落盘 bindings.json', async () => {
    const runtime = createMockRuntime();
    const remote = new MemoryProvider();
    const db = await initDB({
      provider: 'memory',
      owner: 'test-user',
      repo: 'test-repo',
      database: 'test-db',
      providerInstance: remote,
      runtime
    });
    expect(db).toBeDefined();
    await db.close();

    const bindingsExists = await runtime.fs.exists('~/.gitlite/bindings.json');
    expect(bindingsExists).toBe(false);
  });

  it('若 bindings.json 中存在旧 memory 记录，传入 provider: "github" 重新初始化时不会复用旧记录', async () => {
    const runtime = createMockRuntime();
    // 人为写入旧的 memory binding 记录
    await runtime.fs.writeFile('~/.gitlite/bindings.json', JSON.stringify({
      provider: 'memory',
      owner: 'old-memory-user',
      repo: 'old-memory-repo',
      database: 'old-db'
    }));

    const events: string[] = [];
    const remoteGithub = new MemoryProvider(); // 模拟 github provider
    (remoteGithub as any).getUser = async () => ({ login: 'github-user' });

    const db = await initDB({
      provider: 'github',
      token: 'ghp_fake_token',
      providerInstance: remoteGithub,
      runtime,
      onProgress: step => events.push(step)
    });

    expect(db).toBeDefined();
    // 应该触发全新的 start，而不是 reconnect
    expect(events).not.toContain('reconnect');
    expect(events).toContain('start');

    // 成功后 bindings.json 应被更新为 github
    const newBindings = JSON.parse(await runtime.fs.readFile('~/.gitlite/bindings.json'));
    expect(newBindings.provider).toBe('github');
    expect(newBindings.owner).toBe('github-user');
    await db.close();
  });

  it('provider 匹配时正常触发 reconnect 幂等静默连接', async () => {
    const runtime = createMockRuntime();
    await runtime.fs.writeFile('~/.gitlite/bindings.json', JSON.stringify({
      provider: 'github',
      owner: 'gh-user',
      repo: 'my-repo',
      database: 'main-db'
    }));

    const events: string[] = [];
    const remoteGithub = new MemoryProvider();
    (remoteGithub as any).getUser = async () => ({ login: 'gh-user' });

    const db = await initDB({
      provider: 'github',
      token: 'ghp_token',
      providerInstance: remoteGithub,
      runtime,
      onProgress: step => events.push(step)
    });

    expect(events).toContain('reconnect');
    await db.close();
  });

  it('未配置 OAuth App 时 interactiveLogin 抛出结构化 OAuthAppNotConfiguredError', async () => {
    const runtime = createMockRuntime();
    await expect(interactiveLogin(runtime))
      .rejects.toThrowError(OAuthAppNotConfiguredError);

    try {
      await interactiveLogin(runtime);
    } catch (e: any) {
      expect(e).toBeInstanceOf(OAuthAppNotConfiguredError);
      expect(e.code).toBe('OAUTH_APP_NOT_CONFIGURED');
      expect(e.provider).toBe('github');
    }
  });

  it('未配置 OAuth App 时 giteeLogin 抛出结构化 OAuthAppNotConfiguredError', async () => {
    const runtime = createMockRuntime();
    await expect(giteeLogin({ runtime }))
      .rejects.toThrowError(OAuthAppNotConfiguredError);

    try {
      await giteeLogin({ runtime });
    } catch (e: any) {
      expect(e).toBeInstanceOf(OAuthAppNotConfiguredError);
      expect(e.code).toBe('OAUTH_APP_NOT_CONFIGURED');
      expect(e.provider).toBe('gitee');
    }
  });
});


