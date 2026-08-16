// P2 最小计划器 + explain（SQLite 代价优化器对位第一步）：访问路径决策与执行严格一致
import { describe, expect, it } from 'vitest';
import { IndexManager } from '../index/manager.js';
import { select } from './planner.js';
import { MemoryProvider } from '../provider/memory.js';
import { GitLiteClient } from '../client.js';
import { createTestRuntime } from '../test/runtime.js';
import { Ulid } from '../model/ulid.js';
import type { Document } from '../types.js';

const schema = {
  type: 'object',
  properties: {
    _id: { type: 'string' },
    age: { type: 'integer', 'x-gitlite-indexed': true },
    name: { type: 'string' }
  }
};

function docs(n: number): Document[] {
  const ulid = new Ulid(createTestRuntime().crypto);
  return Array.from({ length: n }, (_, i) => ({ _id: ulid.generate(), age: i, name: `n${i}` })) as Document[];
}

describe('QueryPlanner.select（P2）', () => {
  it('空 filter → full-scan，预估 = 全表行数', () => {
    const m = new IndexManager();
    m.registerSchema('t', schema);
    m.rebuild('t', docs(100));
    const sel = select(m, 100, 't', undefined);
    expect(sel.plan.accessPath).toBe('full-scan');
    expect(sel.plan.estimatedRows).toBe(100);
    expect(sel.ids).toBeNull();
  });

  it('等值命中索引 → index-eq，预估 = 候选基数', () => {
    const m = new IndexManager();
    m.registerSchema('t', schema);
    m.rebuild('t', docs(100));
    const sel = select(m, 100, 't', { age: 10 });
    expect(sel.plan.accessPath).toBe('index-eq');
    expect(sel.plan.field).toBe('age');
    expect(sel.plan.estimatedRows).toBe(1);
    expect(sel.plan.selective).toBe(true);
    expect(sel.ids).toHaveLength(1);
  });

  it('等值未命中索引（name 无索引）→ full-scan', () => {
    const m = new IndexManager();
    m.registerSchema('t', schema);
    m.rebuild('t', docs(100));
    const sel = select(m, 100, 't', { name: 'n3' });
    expect(sel.plan.accessPath).toBe('full-scan');
    expect(sel.ids).toBeNull();
  });

  it('范围命中索引 → index-range，$eq 优先于 $gte', () => {
    const m = new IndexManager();
    m.registerSchema('t', schema);
    m.rebuild('t', docs(100));
    const range = select(m, 100, 't', { age: { $gte: 10, $lt: 20 } });
    expect(range.plan.accessPath).toBe('index-range');
    expect(range.plan.estimatedRows).toBe(10);
    expect(range.ids).toHaveLength(10);

    // 混合：$eq + $gte 同字段 → eq 优先
    const mixed = select(m, 100, 't', { age: { $gte: 10 }, name: 'n0' });
    expect(mixed.plan.accessPath).toBe('index-range');  // name 无索引，走 age 范围
    expect(mixed.plan.field).toBe('age');
  });
});

describe('Collection.explain（P2 集成）', () => {
  it('explain 与实际执行一致：estimatedRows == find total', async () => {
    const provider = new MemoryProvider();
    const client = await GitLiteClient.create({
      provider, runtime: createTestRuntime(),
      ref: { owner: 't', repo: 'r' }, database: 'd'
    });
    await client.putSchema('users', schema);
    const c = client.collection('users');
    for (const d of docs(200)) await c.insertOne(d as any);

    const eq = await c.explain({ age: 5 } as any);
    expect(eq.accessPath).toBe('index-eq');
    expect(eq.estimatedRows).toBe(1);
    expect((await c.find({ age: 5 } as any)).total).toBe(eq.estimatedRows);

    const range = await c.explain({ age: { $gte: 50, $lt: 60 } } as any);
    expect(range.accessPath).toBe('index-range');
    expect(range.estimatedRows).toBe(10);
    expect((await c.find({ age: { $gte: 50, $lt: 60 } } as any)).total).toBe(range.estimatedRows);

    const full = await c.explain({ name: 'n7' } as any);
    expect(full.accessPath).toBe('full-scan');
    expect(full.estimatedRows).toBe(200);
    await client.close();
  });
});
