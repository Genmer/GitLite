// P3 SAVEPOINT（SQLite SAVEPOINT 对位）：长事务内保存点/部分回滚，单 commit 原子性不变
import { describe, expect, it } from 'vitest';
import { MemoryProvider } from '../provider/memory.js';
import { GitLiteClient } from '../client.js';
import { createTestRuntime } from '../test/runtime.js';

async function makeClient() {
  const provider = new MemoryProvider();
  const client = await GitLiteClient.create({
    provider, runtime: createTestRuntime(),
    ref: { owner: 't', repo: 'r' }, database: 'd'
  });
  return { client, provider };
}

describe('TransactionManager SAVEPOINT（P3）', () => {
  it('rollbackTo 丢弃保存点后的写入，保留其前的；commit 只应用保留部分', async () => {
    const { client } = await makeClient();
    const t = client.collection('t');
    await client.transaction(async tx => {
      const c = tx.collection('t');
      await c.insertOne({ n: 1 });
      tx.savepoint('sp1');
      await c.insertOne({ n: 2 });
      expect((await c.find({}) as any).items.length).toBe(2);   // read-your-writes
      tx.rollbackTo('sp1');
      expect((await c.find({}) as any).items.length).toBe(1);   // n:2 已回滚
    });
    expect(await t.count()).toBe(1);
    expect(await t.findOne({ n: 2 })).toBeNull();
    await client.close();
  });

  it('rollbackTo 同时回滚插入与删除；嵌套保存点回滚到外层释放内层', async () => {
    const { client } = await makeClient();
    const t = client.collection('t');
    await client.transaction(async tx => {
      const c = tx.collection('t');
      await c.insertOne({ a: 1 });
      tx.savepoint('outer');
      await c.insertOne({ b: 2 });
      tx.savepoint('inner');
      await c.insertOne({ c: 3 });
      await c.deleteOne({ a: 1 });        // inner 之后
      tx.rollbackTo('outer');             // 丢弃 inner 及之后全部 → 只剩 a:1 插入
      expect((await c.find({}) as any).items.length).toBe(1);
    });
    expect(await t.count()).toBe(1);
    expect(await t.findOne({ a: 1 })).not.toBeNull();
    expect(await t.findOne({ b: 2 })).toBeNull();
    await client.close();
  });

  it('同名 savepoint 隐式释放旧同名（SQLite 语义）', async () => {
    const { client } = await makeClient();
    const t = client.collection('t');
    await client.transaction(async tx => {
      const c = tx.collection('t');
      await c.insertOne({ x: 1 });
      tx.savepoint('sp');
      await c.insertOne({ y: 2 });
      tx.savepoint('sp');                // 释放旧 sp，新基线含 x+y
      await c.insertOne({ z: 3 });
      tx.rollbackTo('sp');               // 回滚到第二个 sp → 丢 z，保留 x+y
    });
    expect(await t.count()).toBe(2);
    expect(await t.findOne({ z: 3 })).toBeNull();
    await client.close();
  });

  it('回滚到不存在的保存点 → 抛错，整个事务回滚零残留', async () => {
    const { client } = await makeClient();
    const t = client.collection('t');
    await expect(client.transaction(async tx => {
      const c = tx.collection('t');
      await c.insertOne({ n: 1 });
      tx.savepoint('a');
      tx.rollbackTo('missing');
    })).rejects.toThrow(/savepoint not found/);
    expect(await t.count()).toBe(0);     // 事务整体回滚，镜像零残留
    await client.close();
  });
});
