// P1a 索引范围扫描（14 号定纲：B-Tree 范围查找对位）——纯本地引擎能力
import { describe, expect, it } from 'vitest';
import { IndexManager } from './manager.js';
import { createTestRuntime } from '../test/runtime.js';
import { GitLiteClient } from '../client.js';
import { MemoryProvider } from '../provider/memory.js';
import { Ulid } from '../model/ulid.js';
import type { Document } from '../types.js';

const schema = {
  type: 'object',
  properties: {
    _id: { type: 'string' },
    age: { type: 'integer', 'x-gitlite-indexed': true },
    name: { type: 'string', 'x-gitlite-indexed': true }
  }
};

function docs(n: number): Document[] {
  const ulid = new Ulid(createTestRuntime().crypto);
  return Array.from({ length: n }, (_, i) => ({
    _id: ulid.generate(), age: i, name: `name${String(i).padStart(4, '0')}`
  })) as Document[];
}

describe('IndexManager.rangeCandidates（P1a）', () => {
  it('数值范围：闭开区间 / 开闭区间 / 全边界组合', () => {
    const m = new IndexManager();
    m.registerSchema('t', schema);
    m.rebuild('t', docs(100));

    const ids = (r: any) => m.rangeCandidates('t', 'age', r)!.length;
    expect(ids({ $gte: 10, $lt: 20 })).toBe(10);    // [10,20)
    expect(ids({ $gt: 10, $lte: 20 })).toBe(10);    // (10,20]
    expect(ids({ $gt: 10, $lt: 20 })).toBe(9);      // (10,20)
    expect(ids({ $gte: 10, $lte: 20 })).toBe(11);   // [10,20]
    expect(ids({ $gte: 0, $lte: 99 })).toBe(100);   // 全集
    expect(ids({ $gte: 100 })).toBe(0);             // 超上界
    expect(ids({ $lt: 0 })).toBe(0);                // 超下界
    expect(ids({ $gt: -5, $lt: 3 })).toBe(3);       // 部分越界
  });

  it('数值排序正确性（10 与 9 的字典序陷阱）', () => {
    const m = new IndexManager();
    m.registerSchema('t', schema);
    m.rebuild('t', docs(20)); // 0..19：字典序会排 0,1,10,11,...,19,2,...
    const got = m.rangeCandidates('t', 'age', { $gte: 8, $lte: 12 })!;
    // 取回文档验证是 8..12 而非字典序混入
    expect(got.length).toBe(5);
    const bucket = (m as any).store.data.get('t').get('age'); // P4 起内存 Map 位于 MemoryIndexStore
    const ages = got.map(id => Number([...bucket.entries()].find(([, v]: any) => v.includes(id))![0]));
    expect(ages.sort((a: number, b: number) => a - b)).toEqual([8, 9, 10, 11, 12]);
  });

  it('字符串范围：字典序前缀区间', () => {
    const m = new IndexManager();
    m.registerSchema('t', schema);
    m.rebuild('t', docs(100));
    const got = m.rangeCandidates('t', 'name', { $gte: 'name0010', $lt: 'name0020' })!;
    expect(got.length).toBe(10);
  });

  it('写后一致：增量插入新 key 后范围扫描仍正确（onWrite 同步 sorted）', () => {
    const m = new IndexManager();
    m.registerSchema('t', schema);
    const base = docs(10); // 0..9
    m.rebuild('t', base);
    const late: Document = { _id: 'late1', age: 5, name: 'namelate' } as Document;
    m.onWrite('t', null, late);
    expect(m.rangeCandidates('t', 'age', { $gte: 5, $lte: 6 })!.length).toBe(3); // 5,5,6
    const edge: Document = { _id: 'edge', age: -1, name: 'a' } as Document;
    m.onWrite('t', null, edge);
    expect(m.rangeCandidates('t', 'age', { $lt: 0 })!.length).toBe(1);
    m.onWrite('t', late, null); // 删除
    expect(m.rangeCandidates('t', 'age', { $gte: 5, $lte: 6 })!.length).toBe(2);
  });

  it('索引未建/字段无索引 → null（降级全表，H2 契约不变）', () => {
    const m = new IndexManager();
    expect(m.rangeCandidates('nope', 'age', { $gte: 0 })).toBeNull();
    m.registerSchema('t', schema);
    m.rebuild('t', docs(5));
    expect(m.rangeCandidates('t', 'missing', { $gte: 0 })).toBeNull();
  });
});

describe('Collection 集成：范围查询走索引（P1a）', () => {
  it('数值范围 find 结果与全表扫描等价', async () => {
    const provider = new MemoryProvider();
    const client = await GitLiteClient.create({
      provider, runtime: createTestRuntime(),
      ref: { owner: 't', repo: 'r' }, database: 'd'
    });
    await client.putSchema('users', schema);
    const c = client.collection('users');
    for (const d of docs(200)) await c.insertOne(d as any);

    const page = await c.find({ age: { $gte: 50, $lt: 60 } } as any);
    expect(page.total).toBe(10);
    expect((page.items[0] as any).age).toBeGreaterThanOrEqual(50);

    // 边界破坏性验证：$gt/$lte 组合
    const p2 = await c.find({ age: { $gt: 0, $lte: 3 } } as any);
    expect(p2.total).toBe(3);
    await client.close();
  });
});
