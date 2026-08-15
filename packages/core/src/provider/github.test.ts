import { describe, expect, it } from 'vitest';
import { GitHubProvider } from './github.js';
import { AuthError, ConflictError, RateLimitError } from '../errors.js';

// 极简 fetch 路由器：按 (method, path 片段) 返回预设响应序列
function mockFetch(routes: Array<{ match: (m: string, p: string) => boolean; status?: number; body?: any; headers?: Record<string, string> }>): typeof fetch & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const fn = (async (url: any, init?: any) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    calls.push([method, path]);
    const hit = routes.find(r => r.match(method, path));
    if (!hit) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { 'content-type': 'application/json', ...(hit.headers ?? {}) }
    });
  }) as any;
  fn.calls = calls;
  return fn;
}

const ref = { owner: 'me', repo: 'db' };

describe('GitHubProvider（FR B5 错误映射 / Git DB 四步 commit）', () => {
  it('getRepo：200 → RepoInfo；404 → null', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p === '/repos/me/db', body: { full_name: 'me/db', private: true, default_branch: 'main', size: 1 } }
    ]);
    const p = new GitHubProvider('t', f);
    const info = await p.getRepo(ref);
    expect(info?.fullName).toBe('me/db');

    const f404 = mockFetch([{ match: (m, p) => p === '/repos/me/db', status: 404, body: { message: 'Not Found' } }]);
    expect(await new GitHubProvider('t', f404).getRepo(ref)).toBeNull();
  });

  it('commit：blobs→trees→commits→ref 四步 CAS', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p.includes('/git/ref/heads/main'), body: { object: { sha: 'head1' } } },
      { match: (m, p) => m === 'GET' && p.includes('/git/commits/head1'), body: { tree: { sha: 'tree0' } } },
      { match: (m, p) => m === 'POST' && p.includes('/git/blobs'), body: { sha: 'blob1' } },
      { match: (m, p) => m === 'POST' && p.includes('/git/trees'), body: { sha: 'tree1' } },
      { match: (m, p) => m === 'POST' && p.includes('/git/commits'), body: { sha: 'commit1' } },
      { match: (m, p) => m === 'PATCH' && p.includes('/git/refs/heads/main'), body: { object: { sha: 'commit1' } } }
    ]);
    const p = new GitHubProvider('t', f);
    const { oid } = await p.commit(ref, 'main', 'msg',
      [{ kind: 'put', path: 'a.json', content: '{}' }], 'head1');
    expect(oid).toBe('commit1');
    const seq = f.calls.map(([m, p2]) => `${m} ${p2.split('/').slice(-2).join('/')}`);
    expect(seq.join(' > ')).toContain('blobs');
    expect(seq.join(' > ')).toContain('commits');
  });

  it('ref 更新 422 → ConflictError（CAS 语义，F6）', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p.includes('/git/commits/'), body: { tree: { sha: 't0' } } },
      { match: (m, p) => m === 'POST', body: { sha: 'x' } },
      { match: (m, p) => m === 'PATCH', status: 422, body: { message: 'Update is not a fast forward' } }
    ]);
    await expect(new GitHubProvider('t', f).commit(ref, 'main', 'm', [], 'old'))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it('401 → AuthError；403+remaining 0 → RateLimitError（F7）', async () => {
    const f401 = mockFetch([{ match: () => true, status: 401, body: { message: 'Bad credentials' } }]);
    await expect(new GitHubProvider('bad', f401).getRepo(ref)).rejects.toBeInstanceOf(AuthError);

    const f403 = mockFetch([{ match: () => true, status: 403, body: { message: 'rate' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' } }]);
    await expect(new GitHubProvider('t', f403).getRepo(ref)).rejects.toBeInstanceOf(RateLimitError);
  });
});
