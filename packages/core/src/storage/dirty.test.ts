// P1b 脏集合增量 diff：写路径标记 → flush 只导出脏表 → O(全仓库) 变 O(改动)
import { describe, expect, it } from 'vitest';
import { StorageEngine } from './engine.js';
import { IndexManager } from '../index/manager.js';
import { MemoryProvider } from '../provider/memory.js';
import type { FileChange } from '../types.js';
import { GitLiteClient } from '../client.js';
import { createTestRuntime } from '../test/runtime.js';
import { SYS, type Document } from '../types.js';

const REF = { owner: 't', repo: 'r' };
const BRANCH = 'gitlite/d';

function seed(c: string, docs: Document[]): Map<string, string> {
  const m = new Map<string, string>();
  m.set(SYS.configPath, JSON.stringify({ formatVersion: SYS.formatVersion, createdBy: 'x' }, null, 2));
  m.set(SYS.headPath, '{}');
  m.set(`${c}.jsonl`, docs.map(d => JSON.stringify(d)).join('\n') + '\n');
  return m;
}

/** 捕获每次 commit 的变更清单，验证增量 */
class CaptureProvider extends MemoryProvider {
  commits: FileChange[][] = [];
  override async commit(ref: any, branch: string, _m: string,
                        changes: FileChange[], expectedHeadOid?: string): Promise<{ oid: string }> {
    this.commits.push(changes);
    return super.commit(ref, branch, _m, changes, expectedHeadOid);
  }
}

describe('StorageEngine 脏集合增量 diff（P1b）', () => {
  it('只写一个表：diff 仅含该表文件，不触碰 clean 表', () => {
    const s = new StorageEngine();
    s.importFiles(seed('a', [
      { _id: 'a1', n: 1 }, { _id: 'a2', n: 2 }
    ]));
    s.upsert('b', { _id: 'b1', n: 3 });      // 只脏 b
    s.markSynced(s.diff(), new Set(s.dirtyCollections())); // baseline = 当前全量（a 已同步）

    s.upsert('b', { _id: 'b2', n: 4 });      // 再脏 b
    const changes = s.diff();
    expect(changes.some(c => c.path.startsWith('a'))).toBe(false); // clean 表零触碰
    expect(changes.some(c => c.path === 'b.jsonl')).toBe(true);    // 脏表文件在列
  });

  it('markSynced 清脏后 diff 为空；clearDirty 后 diff 为空', () => {
    const s = new StorageEngine();
    s.importFiles(seed('a', [{ _id: 'a1', n: 1 }]));
    s.upsert('a', { _id: 'a2', n: 2 });
    s.markSynced(s.diff(), new Set(s.dirtyCollections()));
    expect(s.diff()).toHaveLength(0);

    s.upsert('a', { _id: 'a3', n: 3 });
    s.clearDirty();                          // flush 空 diff 分支清理
    expect(s.diff()).toHaveLength(0);
  });

  it('L0→L1 迁移：增量导出仍产出 delete 旧 jsonl + put 逐行文件', () => {
    const s = new StorageEngine();
    const base = Array.from({ length: 49 }, (_, i) => ({ _id: `id${i}`, n: i })); // <50 → inline
    s.importFiles(seed('a', base as Document[]));
    s.upsert('a', { _id: 'id49', n: 49 });   // 50 行 → 升级 doc-per-file
    const changes = s.diff();
    expect(changes.some(c => c.kind === 'delete' && c.path === 'a.jsonl')).toBe(true);
    const puts = changes.filter(c => c.kind === 'put' && /^a\/.+\.json$/.test(c.path));
    expect(puts.length).toBe(50);
  });

  it('clean 表索引文件不随脏表导出；dirty 表索引在列，manifest 常驻', () => {
    const idx = new IndexManager();
    idx.registerSchema('a', { properties: { age: { 'x-gitlite-indexed': true } } });
    idx.registerSchema('b', { properties: { age: { 'x-gitlite-indexed': true } } });
    idx.rebuild('a', [{ _id: 'a1', age: 1 }] as Document[]);
    idx.rebuild('b', [{ _id: 'b1', age: 2 }] as Document[]);

    const all = idx.exportFiles();
    expect(all.has('_indexes/a.age.idx.json')).toBe(true);
    expect(all.has('_indexes/b.age.idx.json')).toBe(true);

    const dirty = idx.exportFiles(new Set(['a']));
    expect(dirty.has('_indexes/a.age.idx.json')).toBe(true);   // 脏表索引导出
    expect(dirty.has('_indexes/b.age.idx.json')).toBe(false);  // clean 表索引不导出
    expect(dirty.has('_indexes/_manifest.json')).toBe(true);   // manifest 常驻
  });
});

describe('集成：MemoryProvider 两次 flush 增量提交（P1b）', () => {
  it('先写 a flush、再写 b flush：第二次 commit 不含 a 文件', async () => {
    const provider = new CaptureProvider();
    const client = await GitLiteClient.create({
      provider, runtime: createTestRuntime(), ref: REF, database: 'd'
    });
    await client.collection('a').insertOne({ n: 1 });
    await client.sync.flush();
    provider.commits.length = 0;             // 清掉 bootstrap/first commit

    await client.collection('b').insertOne({ n: 2 });
    await client.sync.flush();
    const last = provider.commits.at(-1)!;
    expect(last.some(c => c.path === 'b.jsonl')).toBe(true);      // b 在列
    expect(last.some(c => c.path === 'a.jsonl')).toBe(false);     // a 零触碰（增量核心）

    const files = (await provider.getFiles(REF, BRANCH))!;
    expect(files.get('a.jsonl')).toContain('"n":1');
    expect(files.get('b.jsonl')).toContain('"n":2');
    await client.close();
  });
});
