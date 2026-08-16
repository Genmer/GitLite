// P1c 增量 pull：树一次比对 + 按需拉变更 blob（14 号定纲：按需页读取对位）
import { describe, expect, it } from 'vitest';
import { MemoryProvider } from '../provider/memory.js';
import { GitHubProvider } from '../provider/github.js';
import { GitLiteClient } from '../client.js';
import { createTestRuntime } from '../test/runtime.js';
import type { RepoRef } from '../types.js';

const REF: RepoRef = { owner: 't', repo: 'r' };
const BRANCH = 'gitlite/d';

/** 记录每次 getChangedFiles 返回的变更/删除清单，验证增量粒度 */
class LogProvider extends MemoryProvider {
  pulls: { keys: string[]; deleted: string[] }[] = [];
  override async getChangedFiles(ref: any, branch: string, prevTree: Map<string, string> | null) {
    const r = await super.getChangedFiles(ref, branch, prevTree);
    if (r) this.pulls.push({ keys: [...r.files.keys()], deleted: r.deleted });
    return r;
  }
}

describe('P1c 增量 pull（集成，MemoryProvider）', () => {
  it('远端单文件变更 → 第二次 pull 只取 1 个变更文件（不做全量）', async () => {
    const provider = new LogProvider();
    const a = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref: REF, database: 'd' });
    await a.collection('t').insertOne({ n: 1 });
    await a.sync.flush();

    const b = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref: REF, database: 'd' });
    provider.pulls.length = 0;                          // 清掉 b 启动后的首拉

    await a.collection('t').insertOne({ n: 2 });        // 只改 t.jsonl
    await a.sync.flush();

    expect(await b.collection('t').count({}, { consistency: 'fresh' } as any)).toBe(2);
    const last = provider.pulls.at(-1)!;
    expect(last.keys).toEqual(['t.jsonl']);             // 仅变更文件，无 config/head 等
    expect(last.deleted).toHaveLength(0);
    await a.close(); await b.close();
  });

  it('远端删除（doc-per-file 全删）→ 增量 pull 移除镜像文件', async () => {
    const provider = new LogProvider();
    const a = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref: REF, database: 'd' });
    const c = a.collection('big');
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push(await c.insertOne({ i })); // >50 → doc-per-file
    await a.sync.flush();

    const b = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref: REF, database: 'd' });
    expect(await b.collection('big').count({}, { consistency: 'fresh' } as any)).toBe(55);
    provider.pulls.length = 0;

    await c.deleteMany({});
    await a.sync.flush();

    expect(await b.collection('big').count({}, { consistency: 'fresh' } as any)).toBe(0);
    const last = provider.pulls.at(-1)!;
    // 55 个逐行文件全部由删除清单承载（增量契约）；降级为 inline 空文件 + 迁移记录随增量带上
    expect(last.deleted.length).toBe(55);
    expect(last.deleted.some(p => p.startsWith('big/'))).toBe(true);
    await a.close(); await b.close();
  });

  it('本地 flush 后 remoteTree 保持：再增量 pull 仍只取远端变更', async () => {
    const provider = new LogProvider();
    const a = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref: REF, database: 'd' });
    const b = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref: REF, database: 'd' });
    await a.collection('t').insertOne({ n: 1 });
    await a.sync.flush();
    expect(await b.collection('t').count({}, { consistency: 'fresh' } as any)).toBe(1);

    await b.collection('u').insertOne({ m: 1 });        // b 本地写并推
    await b.sync.flush();
    provider.pulls.length = 0;

    await a.collection('t').insertOne({ n: 2 });        // a 只改 t.jsonl
    await a.sync.flush();
    expect(await b.collection('t').count({}, { consistency: 'fresh' } as any)).toBe(2);
    const last = provider.pulls.at(-1)!;
    expect(last.keys).toEqual(['t.jsonl']);             // b 自己的 u 未被重复拉
    await a.close(); await b.close();
  });
});

describe('P1c GitHubProvider.getChangedFiles（mock fetch）', () => {
  /** 构造 GitHub 树响应（path → sha）；fetch 计数按 URL 记录 */
  function makeFetch(tree: Record<string, string>, blobs: Record<string, { content: string }>) {
    const calls: string[] = [];
    const fn = async (input: any, init?: any): Promise<Response> => {
      const url = String(input);
      calls.push(url.split('?')[0]!.split('/api.github.com')[1]!);
      if (url.includes('/git/trees/')) {
        return json({ tree: Object.entries(tree).map(([path, sha]) => ({ path, sha, type: 'blob' })) }, 200);
      }
      const m = /\/git\/blobs\/(\w+)$/.exec(url);
      if (m) {
        const b = blobs[m[1]!]!;
        return json({ content: Buffer.from(b.content).toString('base64'), encoding: 'base64' }, 200);
      }
      throw new Error(`unexpected url ${url}`);
    };
    return { fn, calls };
  }
  function json(data: any, status: number): Response {
    return { status, headers: new Headers(), json: async () => data, text: async () => '' } as any as Response;
  }

  it('树一次比对：只拉变更/新增 blob；未变文件零请求', async () => {
    const tree = { 'a.jsonl': 'shaA', 'b.jsonl': 'shaB', 'c.jsonl': 'shaC' };
    const blobs = {
      shaA: { content: 'a-new' },       // a 变更
      shaC: { content: 'c-content' }    // c 新增
    };
    const { fn, calls } = makeFetch(tree, blobs);
    const p = new GitHubProvider('tok', fn);

    const prev = new Map([['a.jsonl', 'shaA-old'], ['b.jsonl', 'shaB']]); // a 变了、c 是新的
    const res = await p.getChangedFiles(REF, BRANCH, prev);

    expect(res!.files.get('a.jsonl')).toBe('a-new');
    expect(res!.files.get('c.jsonl')).toBe('c-content');
    expect(res!.files.has('b.jsonl')).toBe(false);      // 未变 → 不拉
    expect(calls.filter(u => u.includes('/git/blobs/'))).toHaveLength(2); // 只 2 次 blob 请求
  });

  it('prevTree=null → 全量（首拉契约）', async () => {
    const tree = { 'a.jsonl': 'shaA', 'b.jsonl': 'shaB' };
    const blobs = { shaA: { content: 'a' }, shaB: { content: 'b' } };
    const { fn, calls } = makeFetch(tree, blobs);
    const p = new GitHubProvider('tok', fn);
    const res = await p.getChangedFiles(REF, BRANCH, null);
    expect(res!.files.size).toBe(2);
    expect(calls.filter(u => u.includes('/git/blobs/'))).toHaveLength(2);
  });
});
