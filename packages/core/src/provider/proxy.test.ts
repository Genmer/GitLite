import { describe, it, expect } from 'vitest';
import { GitHubProvider } from './github.js';
import { GiteeProvider } from './gitee.js';

describe('Provider Custom baseUrl / Proxy Support', () => {
  it('GitHubProvider 支持自定义 baseUrl（如 Cloudflare Worker 代理）', async () => {
    let requestedUrl = '';
    const mockFetch: typeof fetch = async (input: any) => {
      requestedUrl = typeof input === 'string' ? input : input.url;
      return new Response(JSON.stringify({ login: 'alice' }), { status: 200 });
    };

    const provider = new GitHubProvider('test-token', mockFetch, {
      baseUrl: 'https://my-cf-proxy.workers.dev/github'
    });

    const user = await provider.getUser();
    expect(user.login).toBe('alice');
    expect(requestedUrl).toBe('https://my-cf-proxy.workers.dev/github/user');
  });

  it('GiteeProvider 支持自定义 baseUrl', async () => {
    let requestedUrl = '';
    const mockFetch: typeof fetch = async (input: any) => {
      requestedUrl = typeof input === 'string' ? input : input.url;
      return new Response(JSON.stringify({ login: 'bob' }), { status: 200 });
    };

    const provider = new GiteeProvider('test-token', mockFetch, {
      baseUrl: 'https://my-cf-proxy.workers.dev/gitee/api/v5'
    });

    const user = await provider.getUser();
    expect(user.login).toBe('bob');
    expect(requestedUrl).toBe('https://my-cf-proxy.workers.dev/gitee/api/v5/user');
  });
});
