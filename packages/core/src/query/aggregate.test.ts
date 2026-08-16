// P2 聚合管道（SQLite GROUP BY/聚合对位）
import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregate.js';
import { MemoryProvider } from '../provider/memory.js';
import { GitLiteClient } from '../client.js';
import { createTestRuntime } from '../test/runtime.js';

const sales = [
  { _id: '1', region: 'east', amount: 10 },
  { _id: '2', region: 'east', amount: 20 },
  { _id: '3', region: 'west', amount: 30 },
  { _id: '4', region: 'west', amount: 40 },
  { _id: '5', region: 'north', amount: 50 }
];

describe('aggregate（P2）', () => {
  it('$group 按字段分组 + $sum', () => {
    const out = aggregate(sales, [{ $group: { _id: '$region', total: { $sum: '$amount' } } }]);
    const by = Object.fromEntries(out.map(g => [g._id, g.total]));
    expect(by).toEqual({ east: 30, west: 70, north: 50 });
  });

  it('$group 单组（_id:null）+ $sum:1 计数', () => {
    const out = aggregate(sales, [{ $group: { _id: null, n: { $sum: 1 } } }]);
    expect(out).toEqual([{ _id: null, n: 5 }]);
  });

  it('$avg/$min/$max 累加器', () => {
    const out = aggregate(sales, [{ $group: {
      _id: '$region',
      avg: { $avg: '$amount' },
      min: { $min: '$amount' },
      max: { $max: '$amount' }
    } }]);
    const east = out.find(g => g._id === 'east')!;
    expect(east.avg).toBe(15);
    expect(east.min).toBe(10);
    expect(east.max).toBe(20);
  });

  it('$push 收集数组', () => {
    const out = aggregate(sales, [{ $group: { _id: '$region', amounts: { $push: '$amount' } } }]);
    const east = out.find(g => g._id === 'east')!;
    expect(east.amounts.sort()).toEqual([10, 20]);
  });

  it('$match → $group 流水线', () => {
    const out = aggregate(sales, [
      { $match: { amount: { $gte: 20 } } },
      { $group: { _id: '$region', total: { $sum: '$amount' } } }
    ]);
    const by = Object.fromEntries(out.map(g => [g._id, g.total]));
    expect(by).toEqual({ east: 20, west: 70, north: 50 });
  });

  it('$sort + $skip + $limit', () => {
    const out = aggregate(sales, [
      { $sort: { amount: -1 } },
      { $skip: 1 },
      { $limit: 2 }
    ]);
    expect(out.map(d => d.amount)).toEqual([40, 30]);
  });

  it('$count 输出 {name: n}', () => {
    const out = aggregate(sales, [{ $count: 'totalDocs' }]);
    expect(out).toEqual([{ _id: 1, totalDocs: 5 }]);
  });

  it('$project 计算字段与排除', () => {
    const out = aggregate(sales, [
      { $match: { region: 'east' } },
      { $project: { region: 1, dbl: '$amount' } }
    ]);
    expect(out[0]).toMatchObject({ region: 'east', dbl: 10 });
  });

  it('未知 stage 抛错', () => {
    expect(() => aggregate(sales, [{ $foo: {} }] as any)).toThrow(/unsupported aggregation stage/);
  });
});

describe('Collection.aggregate（P2 集成）', () => {
  it('分组聚合经客户端 API 可达', async () => {
    const provider = new MemoryProvider();
    const client = await GitLiteClient.create({
      provider, runtime: createTestRuntime(),
      ref: { owner: 't', repo: 'r' }, database: 'd'
    });
    const c = client.collection('sales');
    for (const s of sales) await c.insertOne(s as any);

    const out = await c.aggregate<any>([
      { $group: { _id: '$region', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } }
    ]);
    expect(out[0]).toEqual({ _id: 'west', total: 70 });
    await client.close();
  });
});
