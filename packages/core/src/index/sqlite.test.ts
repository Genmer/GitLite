// P4 本地 SQLite 索引后端测试（docs/14 P4 / docs/08 §六）：
// 双后端语义 parity、跨会话持久化、docHash 跳重建、损坏/故障降级（H2）、client 级集成（ADR-002 in-band 格式）。
// 测试文件经 createRequire 使用 node:sqlite（Node ≥22.5）——core 生产代码零 node 依赖不受影响（FR I4）。
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexManager } from './manager.js';
import { GitLiteClient } from '../client.js';
import { MemoryProvider } from '../provider/memory.js';
import { createTestRuntime } from '../test/runtime.js';
import { UniqueConstraintError } from '../errors.js';
import type { SqliteDb } from '../runtime.js';

const nodeRequire = createRequire(import.meta.url);

/** 真 SQLite（node:sqlite DatabaseSync）：同步 API 与 core 的同步索引接口对位 */
function openDb(path: string): SqliteDb {
  const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: any };
  const db = new DatabaseSync(path);
  return {
    exec: sql => void db.exec(sql),
    run: (sql, params = []) => Number(db.prepare(sql).run(...params).changes),
    all: (sql, params = []) => db.prepare(sql).all(...params),
    close: () => void db.close()
  };
}

const SCHEMA = {
  type: 'object',
  properties: {
    age: { type: 'integer', 'x-gitlite-indexed': true },
    email: { type: 'string', 'x-gitlite-unique': true },
    city: { type: 'string', 'x-gitlite-indexed': true }
  },
  'x-gitlite-indexes': [{ name: 'city_age', fields: ['city', 'age'] }]
};

const d = (_id: string, age: number, email: string, city: string) => ({ _id, age, email, city });
const DOCS = () => [d('u1', 30, 'a@x.dev', 'sh'), d('u2', 25, 'b@x.dev', 'bj'), d('u3', 35, 'c@x.dev', 'sh')];

/** 同一操作序列跑在任一后端上：rebuild → 改（更新索引字段）→ 插 → 删 */
function script(m: IndexManager): void {
  m.registerSchema('users', SCHEMA);
  m.rebuild('users', DOCS());
  m.onWrite('users', d('u2', 25, 'b@x.dev', 'bj'), d('u2', 28, 'b@x.dev', 'bj')); // 更新（改索引字段）
  m.onWrite('users', null, d('u4', 40, 'd@x.dev', 'sz'));                          // 插入
  m.onWrite('users', d('u3', 35, 'c@x.dev', 'sh'), null);                          // 删除
}

type Snap = {
  eqAge: string[] | null; eqAgeMiss: string[] | null; eqCity: string[] | null;
  rangeAge: string[] | null; rangeAgeOpen: string[] | null; rangeCity: string[] | null;
  composite: string[] | null; compositeMiss: string[] | null; compositePartial: string[] | null;
  noIndex: string[] | null;
  files: Map<string, string>;
};

function snap(m: IndexManager): Snap {
  return {
    eqAge: m.candidates('users', 'age', 28),
    eqAgeMiss: m.candidates('users', 'age', 999),
    eqCity: m.candidates('users', 'city', 'sh'),
    rangeAge: m.rangeCandidates('users', 'age', { $gte: 28, $lt: 40 }),
    rangeAgeOpen: m.rangeCandidates('users', 'age', { $gt: 25 }),
    rangeCity: m.rangeCandidates('users', 'city', { $gte: 'bj', $lte: 'sz' }),
    composite: m.compositeCandidates('users', new Map<string, any>([['city', 'sh'], ['age', 30]])),
    compositeMiss: m.compositeCandidates('users', new Map<string, any>([['city', 'sh'], ['age', 999]])),
    compositePartial: m.compositeCandidates('users', new Map([['city', 'sh']])),
    noIndex: m.candidates('users', 'name', 'x'),
    files: m.exportFiles()
  };
}

const norm = (x: string[] | null) => (x === null ? null : [...x].sort());
function normQueries(s: Snap) {
  const { files, ...q } = s;
  void files;
  const out: Record<string, string[] | null> = {};
  for (const [k, v] of Object.entries(q)) out[k] = norm(v as string[] | null);
  return out;
}
/** 导出文件语义化对比（解析 JSON；键序差异不构成格式差异，ADR-002 shape 不变） */
function normFiles(files: Map<string, string>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [p, c] of files) out[p] = JSON.parse(c);
  return out;
}

describe('P4 SQLite 索引后端', () => {
  it('内存 / SQLite 双后端语义 parity（等值/范围/复合/导出）', () => {
    const mem = new IndexManager();
    const sq = IndexManager.openSqlite(openDb(':memory:'));
    expect(sq.backend).toBe('sqlite');
    expect(mem.backend).toBe('memory');
    script(mem);
    script(sq);
    const a = snap(mem), b = snap(sq);
    expect(normQueries(b)).toEqual(normQueries(a));
    expect(normFiles(b.files)).toEqual(normFiles(a.files));
    expect(sq.isIndexed('users')).toBe(mem.isIndexed('users'));
    mem.close();
    sq.close();
  });

  it('唯一约束：双后端一致抛 UniqueConstraintError，自更新不误伤', () => {
    const mem = new IndexManager();
    const sq = IndexManager.openSqlite(openDb(':memory:'));
    script(mem);
    script(sq);
    const dup = d('u9', 50, 'a@x.dev', 'gz'); // email 与 u1 冲突
    expect(() => mem.onWrite('users', null, dup)).toThrow(UniqueConstraintError);
    expect(() => sq.onWrite('users', null, { ...dup })).toThrow(UniqueConstraintError);
    expect(() => mem.checkUnique('users', dup)).toThrow(UniqueConstraintError);
    expect(() => sq.checkUnique('users', { ...dup })).toThrow(UniqueConstraintError);
    // 自更新（同 _id 换 email）不冲突
    expect(() => sq.onWrite('users', d('u1', 30, 'a@x.dev', 'sh'), d('u1', 30, 'new@x.dev', 'sh'))).not.toThrow();
    mem.close();
    sq.close();
  });

  it('跨会话持久化：缓存+指纹双命中 → importFiles/rebuild 零写入（数据 > 内存场景）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlite-p4-'));
    const path = join(dir, 'index.db');
    const m1 = IndexManager.openSqlite(openDb(path));
    script(m1);
    const repoFiles = m1.exportFiles();
    const before = normQueries(snap(m1));
    m1.close();

    // script 终态 docs（会话二从数据文件解析所得）
    const docsNow = [d('u1', 30, 'a@x.dev', 'sh'), d('u2', 28, 'b@x.dev', 'bj'), d('u4', 40, 'd@x.dev', 'sz')];

    // 写计数探针：第二会话的 importFiles（渲染缓存全命中）+ rebuild（XOR 指纹命中）应为零写入
    const raw = openDb(path);
    let writes = 0;
    const counting: SqliteDb = {
      exec: sql => raw.exec(sql),
      run: (sql, params) => {
        if (/^\s*(INSERT|DELETE|UPDATE|REPLACE)/i.test(sql)) writes++;
        return raw.run(sql, params);
      },
      all: (sql, params) => raw.all(sql, params),
      close: () => raw.close()
    };
    const m2 = IndexManager.openSqlite(counting);
    m2.registerSchema('users', SCHEMA); // schema 由会话从 _schema/ 恢复（条目已在盘上）
    m2.importFiles(repoFiles);          // 全命中 → 零解析零写入
    m2.rebuild('users', docsNow);       // 指纹命中（onWrite 已增量维护）→ 跳过重建
    expect(writes).toBe(0);
    expect(normQueries(snap(m2))).toEqual(before);
    expect(normFiles(m2.exportFiles())).toEqual(normFiles(repoFiles));
    m2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('docHash 指纹：docs 未变跳过全量重建，变了则重建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlite-p4h-'));
    const db = openDb(join(dir, 'index.db'));
    const m = IndexManager.openSqlite(db);
    m.registerSchema('users', SCHEMA);
    m.rebuild('users', DOCS());
    expect(norm(m.candidates('users', 'age', 30))).toEqual(['u1']);

    // 探针：外部清空条目后，同 docs 的 rebuild 应命中 docHash 跳过（不恢复条目）
    db.run('DELETE FROM idx_entry');
    m.rebuild('users', DOCS());
    expect(m.candidates('users', 'age', 30)).toEqual([]);

    // docs 变化 → 指纹不中 → 全量重建恢复
    m.rebuild('users', [...DOCS(), d('u5', 41, 'e@x.dev', 'hz')]);
    expect(norm(m.candidates('users', 'age', 30))).toEqual(['u1']);
    expect(norm(m.candidates('users', 'age', 41))).toEqual(['u5']);
    m.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('importFiles：内存导出 → 双后端导入等价；损坏 idx.json 降级（H2）', () => {
    const mem = new IndexManager();
    script(mem);
    const files = mem.exportFiles();
    expect(Object.keys(JSON.parse(files.get('_indexes/users.age.idx.json')!).entries).length).toBeGreaterThan(0); // 空 entries 修复验证

    const mem2 = new IndexManager();
    mem2.registerSchema('users', SCHEMA);
    mem2.importFiles(files);
    const sq = IndexManager.openSqlite(openDb(':memory:'));
    sq.registerSchema('users', SCHEMA);
    sq.importFiles(files);
    const ref = { eq: mem2.candidates('users', 'age', 28), range: mem2.rangeCandidates('users', 'age', { $gte: 28, $lt: 40 }) };
    expect(sq.candidates('users', 'age', 28)).toEqual(ref.eq);          // 导入即建（含 sorted 修复路径）
    expect(norm(sq.rangeCandidates('users', 'age', { $gte: 28, $lt: 40 }))).toEqual(norm(ref.range));
    expect(normFiles(sq.exportFiles())).toEqual(normFiles(files));       // 往返稳定

    const bad = new Map(files);
    for (const p of [...bad.keys()]) if (p.startsWith('_indexes/') && !p.endsWith('_manifest.json')) bad.set(p, '{corrupted');
    sq.importFiles(bad);
    expect(sq.isIndexed('users')).toBe(false);
    expect(sq.candidates('users', 'age', 28)).toBeNull();
    mem.close();
    mem2.close();
    sq.close();
  });

  it('数值索引遇非数值边界 → 降级 null（宁全勿漏）', () => {
    const sq = IndexManager.openSqlite(openDb(':memory:'));
    script(sq);
    expect(sq.rangeCandidates('users', 'age', { $gte: 'not-a-number' })).toBeNull();
    sq.close();
  });

  it('存储故障（库被关/损坏）→ 查询降级 null、写路径不炸（H2）', () => {
    const db = openDb(':memory:');
    const m = IndexManager.openSqlite(db);
    script(m);
    db.close(); // 模拟故障
    expect(m.candidates('users', 'age', 28)).toBeNull();
    expect(m.rangeCandidates('users', 'age', { $gt: 0 })).toBeNull();
    expect(m.compositeCandidates('users', new Map<string, any>([['city', 'sh'], ['age', 30]]))).toBeNull();
    expect(m.isIndexed('users')).toBe(false);
    expect(() => m.onWrite('users', null, d('u9', 50, 'z@x.dev', 'gz'))).not.toThrow();
    expect(() => m.checkUnique('users', d('u10', 51, 'a@x.dev', 'gz'))).not.toThrow(); // 降级放行（本地索引非最终权威）
  });

  it('indexBackend sqlite 但 runtime 未注入 sqlite → 清晰报错', async () => {
    await expect(GitLiteClient.create({
      provider: new MemoryProvider(),
      runtime: createTestRuntime(),
      ref: { owner: 'x', repo: 'r' },
      database: 'default',
      indexBackend: 'sqlite'
    })).rejects.toThrow(/requires runtime\.sqlite/);
  });

  it('client 级全链路：CRUD→flush→repo in-band 索引文件（entries 已填充）→第二会话恢复', async () => {
    const provider = new MemoryProvider();
    const ref = { owner: 'p4', repo: 'gitlite-repo' };
    const dir = mkdtempSync(join(tmpdir(), 'gitlite-p4c-'));
    const dbPath = join(dir, 'index.db');
    const sqlite = { open: (_path: string) => openDb(dbPath) };

    const c1 = await GitLiteClient.create({
      provider, runtime: { ...createTestRuntime(), sqlite }, ref, database: 'default', indexBackend: 'sqlite'
    });
    expect(c1.indexMgr.backend).toBe('sqlite');
    await c1.putSchema('users', SCHEMA as any);
    const users = c1.collection('users');
    await users.insertOne(d('u1', 30, 'a@x.dev', 'sh') as any);
    await users.insertOne(d('u2', 25, 'b@x.dev', 'bj') as any);
    expect((await users.find({ age: { $gte: 26 } })).total).toBe(1);
    expect((await users.explain({ age: { $gte: 26 } })).accessPath).toBe('index-range');
    await expect(users.insertOne(d('u3', 40, 'a@x.dev', 'gz') as any)).rejects.toThrow(UniqueConstraintError);
    await c1.close();

    // ADR-002：索引文件照常随数据 commit，且 entries 已填充（修复前为 {"entries":{}} 空壳）
    const files = (await provider.getFiles(ref, 'gitlite/default'))!;
    const idx = files.get('_indexes/users.age.idx.json');
    expect(idx).toBeTruthy();
    const parsed = JSON.parse(idx!);
    expect(parsed.entries['30']).toEqual(['u1']);
    expect(parsed.entries['25']).toEqual(['u2']);

    // 第二会话：同一 db 文件 → 索引从盘上恢复
    const c2 = await GitLiteClient.create({
      provider, runtime: { ...createTestRuntime(), sqlite }, ref, database: 'default', indexBackend: 'sqlite'
    });
    expect((await c2.collection('users').find({ city: 'sh' })).total).toBe(1);
    expect((await c2.collection('users').find({ age: { $gte: 26 } })).total).toBe(1);
    await c2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
