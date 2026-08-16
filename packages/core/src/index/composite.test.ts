// P2 复合索引（联合索引对位）：最左前缀等值匹配 + 写路径维护 + planner/explain 集成
import { describe, expect, it } from 'vitest';
import { IndexManager, indexDefsFromSchema } from './manager.js';
import { UniqueConstraintError } from '../errors.js';
import { MemoryProvider } from '../provider/memory.js';
import { GitLiteClient } from '../client.js';
import { createTestRuntime } from '../test/runtime.js';
import { Ulid } from '../model/ulid.js';
import type { Document } from '../types.js';

const compositeSchema = {
  type: 'object',
  properties: {
    _id: { type: 'string' },
    age: { type: 'integer' },
    name: { type: 'string' }
  },
  'x-gitlite-indexes': [
    { name: 'age_name', fields: ['age', 'name'] },
    { name: 'u', fields: ['name', 'age'], unique: true }
  ]
};

function docs(): Document[] {
  const ulid = new Ulid(createTestRuntime().crypto);
  return [
    { _id: ulid.generate(), age: 10, name: 'a' },
    { _id: ulid.generate(), age: 10, name: 'b' },
    { _id: ulid.generate(), age: 20, name: 'a' },
    { _id: ulid.generate(), age: 30, name: 'c' }
  ];
}

describe('IndexManager 复合索引（P2）', () => {
  it('schema 解析：多字段索引进入 defs，保留 fields', () => {
    const defs = indexDefsFromSchema(compositeSchema);
    expect(defs.some(d => d.name === 'age_name' && d.fields.length === 2)).toBe(true);
    expect(defs.some(d => d.name === 'u' && d.unique)).toBe(true);
  });

  it('全字段等值：age_name 与 u 双索引都命中正确候选', () => {
    const m = new IndexManager();
    m.registerSchema('t', compositeSchema);
    const ds = docs();
    m.rebuild('t', ds);

    const full = m.compositeCandidates('t', new Map<string, any>([['age', 10], ['name', 'a']]));
    expect(full).toHaveLength(1);                          // 只有 (10,'a')

    const other = m.compositeCandidates('t', new Map<string, any>([['name', 'a'], ['age', 20]]));
    expect(other).toHaveLength(1);                         // 命中 u(name,age) → (a,20)
  });

  it('字段不全（部分前缀）→ null：v0.2 全字段契约，缺列不查', () => {
    const m = new IndexManager();
    m.registerSchema('t', compositeSchema);
    m.rebuild('t', docs());
    expect(m.compositeCandidates('t', new Map<string, any>([['age', 10]]))).toBeNull();       // 缺 name
    expect(m.compositeCandidates('t', new Map<string, any>([['name', 'a']]))).toBeNull();     // 缺 age
    expect(m.compositeCandidates('t', new Map<string, any>([['x', 1]]))).toBeNull();          // 无索引字段
  });

  it('写路径：onWrite 维护复合条目（插入/改键/删除）', () => {
    const m = new IndexManager();
    m.registerSchema('t', compositeSchema);
    m.rebuild('t', docs());

    const late = { _id: 'late', age: 10, name: 'x' } as Document;  // (x,10) 不撞 u(name,age)
    m.onWrite('t', null, late);
    expect(m.compositeCandidates('t', new Map<string, any>([['age', 10], ['name', 'x']]))).toContain('late');

    const moved = { _id: 'late', age: 99, name: 'z' } as Document;
    m.onWrite('t', late, moved);
    expect(m.compositeCandidates('t', new Map<string, any>([['age', 10], ['name', 'x']]))).not.toContain('late');
    expect(m.compositeCandidates('t', new Map<string, any>([['age', 99], ['name', 'z']]))).toContain('late');

    m.onWrite('t', moved, null);
    expect(m.compositeCandidates('t', new Map<string, any>([['age', 99], ['name', 'z']]))).not.toContain('late');
  });

  it('复合唯一：同字段组合重复被拒，不同组合放行', () => {
    const m = new IndexManager();
    m.registerSchema('t', compositeSchema);
    const ds = docs();
    m.rebuild('t', ds);
    const dup = { _id: 'dup', age: 10, name: 'b' } as Document;   // u(name,age)=(b,10) 已存在
    expect(() => m.onWrite('t', null, dup)).toThrow(UniqueConstraintError);
    const ok = { _id: 'ok', age: 77, name: 'b' } as Document;     // (b,77) 未冲突
    expect(() => m.onWrite('t', null, ok)).not.toThrow();
  });
});

describe('planner / explain 复合索引集成（P2）', () => {
  it('多等值 AND → index-composite；单字段等值不受复合干扰', async () => {
    const provider = new MemoryProvider();
    const client = await GitLiteClient.create({
      provider, runtime: createTestRuntime(),
      ref: { owner: 't', repo: 'r' }, database: 'd'
    });
    await client.putSchema('users', compositeSchema);
    const c = client.collection('users');
    for (const d of docs()) await c.insertOne(d as any);

    const plan = await c.explain({ age: 10, name: 'a' } as any);
    expect(plan.accessPath).toBe('index-composite');
    expect(plan.estimatedRows).toBe(1);
    expect((await c.find({ age: 10, name: 'a' } as any)).total).toBe(1);

    // 单字段等值 age 无单字段索引（复合前导列不误当单字段）→ 全表
    const single = await c.explain({ age: 10 } as any);
    expect(single.accessPath).toBe('full-scan');
    expect((await c.find({ age: 10 } as any)).total).toBe(2);
    await client.close();
  });
});
