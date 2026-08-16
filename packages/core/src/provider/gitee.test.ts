// GiteeProvider 测试：Contents 降级提交（非原子逐文件）、目录列表树、CAS 预检、错误映射、扩展名守卫
import { describe, expect, it } from 'vitest';
import { GiteeProvider } from './gitee.js';
import { AuthError, ConflictError, RateLimitError } from '../errors.js';

function mockFetch(routes: Array<{ match: (m: string, p: string, url: string) => boolean; status?: number; body?: any; headers?: Record<string, string> }>): typeof fetch & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const fn = (async (url: any, init?: any) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init?.method ?? 'GET';
    calls.push([method, path + u.search]);
    const hit = routes.find(r => r.match(method, path, url));
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
const enc = (s: string) => btoa(s);

describe('GiteeProvider（Contents 降级，docs/02 §2.2）', () => {
  it('getRepo：200 → RepoInfo；404 → null；默认分支 master 兜底', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p === '/api/v5/repos/me/db', body: { full_name: 'me/db', private: true } }
    ]);
    const info = await new GiteeProvider('t', f).getRepo(ref);
    expect(info?.fullName).toBe('me/db');
    expect(info?.defaultBranch).toBe('master');

    const f404 = mockFetch([{ match: (m, p) => p === '/api/v5/repos/me/db', status: 404, body: {} }]);
    expect(await new GiteeProvider('t', f404).getRepo(ref)).toBeNull();
  });

  it('getHead：branches 接口取 commit.sha；404 → null', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p === '/api/v5/repos/me/db/branches/main', body: { commit: { sha: 'h1' } } }
    ]);
    expect(await new GiteeProvider('t', f).getHead(ref, 'main')).toBe('h1');

    const f404 = mockFetch([{ match: () => true, status: 404, body: {} }]);
    expect(await new GiteeProvider('t', f404).getHead(ref, 'gone')).toBeNull();
  });

  it('getFiles：目录递归 + 单文件内容（base64 解码）', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p === '/api/v5/repos/me/db/contents' && p.length === '/api/v5/repos/me/db/contents'.length,
        body: [
          { path: 'users.jsonl', type: 'file', sha: 's1' },
          { path: '_schema', type: 'dir', sha: 'd1' }
        ] },
      { match: (m, p) => m === 'GET' && p === '/api/v5/repos/me/db/contents/_schema',
        body: [{ path: '_schema/users.schema.jsonc', type: 'file', sha: 's2' }] },
      { match: (m, p) => p === '/api/v5/repos/me/db/contents/users.jsonl', body: { content: enc('{"_id":"u1"}'), encoding: 'base64' } },
      { match: (m, p) => p === '/api/v5/repos/me/db/contents/_schema/users.schema.jsonc', body: { content: enc('{"type":"object"}'), encoding: 'base64' } }
    ]);
    const files = await new GiteeProvider('t', f).getFiles(ref, 'main');
    expect(files?.get('users.jsonl')).toBe('{"_id":"u1"}');
    expect(files?.get('_schema/users.schema.jsonc')).toBe('{"type":"object"}');
  });

  it('getChangedFiles：目录树比对，仅拉变更内容', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p.endsWith('/contents'), body: [
        { path: 'a.json', type: 'file', sha: 'sa' },
        { path: 'b.json', type: 'file', sha: 'sb-new' }
      ] },
      { match: (m, p) => p.endsWith('/contents/b.json'), body: { content: enc('new'), encoding: 'base64' } }
    ]);
    const prev = new Map([['a.json', 'sa'], ['b.json', 'sb-old'], ['c.json', 'sc']]);
    const r = await new GiteeProvider('t', f).getChangedFiles(ref, 'main', prev);
    expect(r?.files.get('b.json')).toBe('new');
    expect(r?.files.has('a.json')).toBe(false);       // sha 未变不拉
    expect(r?.deleted).toEqual(['c.json']);
    expect(r?.tree.get('a.json')).toBe('sa');
    // prevTree=null → 全量
    const f2 = mockFetch([
      { match: (m, p) => p.endsWith('/contents'), body: [{ path: 'a.json', type: 'file', sha: 'sa' }] },
      { match: (m, p) => p.endsWith('/contents/a.json'), body: { content: enc('A'), encoding: 'base64' } }
    ]);
    const full = await new GiteeProvider('t', f2).getChangedFiles(ref, 'main', null);
    expect(full?.files.get('a.json')).toBe('A');
    expect(full?.deleted).toEqual([]);
  });

  it('commit：新文件 POST / 已存在 PUT（带 sha），多文件逐条 + 消息序号', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p.includes('/branches/main'), body: { commit: { sha: 'head1' } } },
      { match: (m, p) => m === 'GET' && p.endsWith('/contents/new.json'), status: 404, body: {} },
      { match: (m, p) => m === 'GET' && p.endsWith('/contents/old.json'), body: { sha: 'sha-old' } },
      { match: (m, p) => m === 'POST' && p.endsWith('/contents/new.json'), body: { commit: { sha: 'c1' } } },
      { match: (m, p) => m === 'PUT' && p.endsWith('/contents/old.json'), body: { commit: { sha: 'c2' } } },
      { match: (m, p) => p === 'GET' && p.endsWith('/contents') && !p.includes('.'), body: [] }
    ]);
    const { oid } = await new GiteeProvider('t', f).commit(ref, 'main', 'sync', [
      { kind: 'put', path: 'new.json', content: '{"n":1}' },
      { kind: 'put', path: 'old.json', content: '{"o":2}' }
    ], 'head1');
    expect(oid).toBe('c2');                            // 最后一条 commit
    const put = f.calls.find(([m, p]) => m === 'PUT')!;
    expect(put).toBeTruthy();
  });

  it('commit：CAS 预检不符 → ConflictError；扩展名缺失 → 明确报错', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p.includes('/branches/main'), body: { commit: { sha: 'moved' } } }
    ]);
    await expect(new GiteeProvider('t', f).commit(ref, 'main', 'm',
      [{ kind: 'put', path: 'a.json', content: '{}' }], 'expected-old'))
      .rejects.toBeInstanceOf(ConflictError);

    const f2 = mockFetch([{ match: () => true, body: {} }]);
    await expect(new GiteeProvider('t', f2).commit(ref, 'main', 'm',
      [{ kind: 'put', path: 'noext', content: '{}' }]))
      .rejects.toThrow(/extension/);
  });

  it('commit：删除走 DELETE（先查 sha）；已不存在幂等跳过', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'GET' && p.includes('/branches/main'), body: { commit: { sha: 'h' } } },
      { match: (m, p) => p.endsWith('/contents/gone.json'), status: 404, body: {} },
      { match: (m, p) => p.endsWith('/contents/x.json'), body: { sha: 'sx' } },
      { match: (m, p) => m === 'DELETE' && p.endsWith('/contents/x.json'), status: 204 },
      { match: (m, p) => m === 'GET' && p.endsWith('/contents') && !p.includes('.'), body: [] }
    ]);
    const { oid } = await new GiteeProvider('t', f).commit(ref, 'main', 'm', [
      { kind: 'delete', path: 'gone.json' },
      { kind: 'delete', path: 'x.json' }
    ], 'h');
    expect(oid).toBe('h');
    expect(f.calls.some(([m, p]) => m === 'DELETE' && p.includes('x.json'))).toBe(true);
    expect(f.calls.some(([m, p]) => m === 'DELETE' && p.includes('gone.json'))).toBe(false);
  });

  it('createBranch：POST branches（branch_name+refs）；冲突幂等', async () => {
    const f = mockFetch([
      { match: (m, p) => m === 'POST' && p.endsWith('/branches'), status: 201, body: {} }
    ]);
    await expect(new GiteeProvider('t', f).createBranch(ref, 'gitlite/x', 'main')).resolves.toBeUndefined();

    const fC = mockFetch([{ match: (m, p) => m === 'POST' && p.endsWith('/branches'), status: 409, body: {} }]);
    await expect(new GiteeProvider('t', fC).createBranch(ref, 'gitlite/x', 'main')).resolves.toBeUndefined();
  });

  it('错误映射：401 → AuthError；限流头精确解析（403/429）', async () => {
    const f401 = mockFetch([{ match: () => true, status: 401, body: {} }]);
    await expect(new GiteeProvider('bad', f401).getRepo(ref)).rejects.toBeInstanceOf(AuthError);

    // 403 + Retry-After → 精确退避（替换原粗略 60s）
    const f403ra = mockFetch([{ match: () => true, status: 403, body: {}, headers: { 'retry-after': '30' } }]);
    const e1 = await new GiteeProvider('t', f403ra).getRepo(ref).catch(e => e);
    expect(e1).toBeInstanceOf(RateLimitError);
    expect(e1.retryAfterMs).toBe(30_000);

    // 403 + remaining=0 + reset → 精确差值
    const resetSec = Math.floor(Date.now() / 1000) + 90;
    const f403r = mockFetch([{ match: () => true, status: 403, body: {},
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) } }]);
    const e2 = await new GiteeProvider('t', f403r).getRepo(ref).catch(e => e);
    expect(e2).toBeInstanceOf(RateLimitError);
    expect(e2.retryAfterMs).toBeGreaterThan(80_000);

    // 403 无限流特征 → 权限错误（不误报限流）
    const f403plain = mockFetch([{ match: () => true, status: 403, body: {} }]);
    await expect(new GiteeProvider('t', f403plain).getRepo(ref)).rejects.toBeInstanceOf(AuthError);

    // 429 无头 → 保守 RateLimit
    const f429 = mockFetch([{ match: () => true, status: 429, body: {} }]);
    const e3 = await new GiteeProvider('t', f429).getRepo(ref).catch(e => e);
    expect(e3).toBeInstanceOf(RateLimitError);
    expect(e3.retryAfterMs).toBe(60_000);
  });

  it('listBranches：分页拉全', async () => {
    const pages: any[][] = [
      Array.from({ length: 100 }, (_, i) => ({ name: `b${i}` })),
      [{ name: 'last' }]
    ];
    const fd = (async (url: any, init?: any) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/branches')) {
        const pg = Number(u.searchParams.get('page') ?? 1) - 1;
        return new Response(JSON.stringify(pages[pg] ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as any;
    const names = await new GiteeProvider('t', fd).listBranches(ref);
    expect(names).toHaveLength(101);
    expect(names[100]).toBe('last');
  });
});
