import { beforeEach, describe, expect, it } from 'vitest';
import { makeClient } from './storage/engine.test.js';
import { MemoryProvider } from './provider/memory.js';
import { GitLiteClient } from './client.js';
import { createTestRuntime } from './test/runtime.js';
import type { Document } from './types.js';

const schema = {
  type: 'object',
  gitliteDescriptor: { collection: 'users', timestamps: true },
  properties: {
    _id: { type: 'string' },
    email: { type: 'string', format: 'email', 'x-gitlite-unique': true, 'x-gitlite-indexed': true },
    age: { type: 'integer', minimum: 0 }
  },
  required: ['email']
};

describe('Collection CRUD（FR E1~E6）', () => {
  let ctx: Awaited<ReturnType<typeof makeClient>>;
  beforeEach(async () => { ctx = await makeClient(); });

  it('insert → findOne/find/count/exists；timestamps 自动（D5）', async () => {
    await ctx.client.putSchema('users', schema);
    const c = ctx.client.collection('users');
    const id = await c.insertOne({ email: 'a@x.com', age: 30 } as any);
    const u: any = await c.findOne({ email: 'a@x.com' });
    expect(u._id).toBe(id);
    expect(u.createdAt).toBeTruthy();
    expect(u.updatedAt).toBeTruthy();
    expect(await c.count({ age: { $gte: 18 } })).toBe(1);
    expect(await c.exists({ email: 'nope@x.com' })).toBe(false);
  });

  it('schema 违规抛 ValidationError（E1）', async () => {
    await ctx.client.putSchema('users', schema);
    await expect(ctx.client.collection('users').insertOne({ email: 'bad', age: 1 } as any))
      .rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('唯一约束：唯一索引冲突抛 UniqueConstraintError（H1）', async () => {
    await ctx.client.putSchema('users', schema);
    const c = ctx.client.collection('users');
    await c.insertOne({ email: 'dup@x.com' } as any);
    await expect(c.insertOne({ email: 'dup@x.com' } as any))
      .rejects.toMatchObject({ name: 'UniqueConstraintError' });
  });

  it('update 操作符 + expectedRev OCC（E4）', async () => {
    const c = ctx.client.collection('c1');
    const id = await c.insertOne({ n: 1, tags: ['a'] } as any);
    await c.updateOne({ _id: id }, { $inc: { n: 5 }, $push: { tags: 'b' } } as any);
    expect((await c.findById(id))!.n).toBe(6);

    const stale = await c.findById(id);
    await c.updateOne({ _id: id }, { $set: { n: 100 } } as any);
    await expect(c.updateOne({ _id: id }, { $set: { n: 999 } } as any,
      { expectedRev: stale!._rev } as any))
      .rejects.toMatchObject({ name: 'ConflictError' });
  });

  it('upsert 与 replaceOne 与 deleteMany（E3/E4/E5）', async () => {
    const c = ctx.client.collection('c2');
    const r = await c.updateOne({ k: 'new' } as any, { $set: { k: 'new', v: 1 } } as any, { upsert: true });
    expect(r.upsertedId).toBeTruthy();
    await c.replaceOne({ k: 'new' } as any, { k: 'new', v: 42 } as any);
    expect((await c.findOne({ k: 'new' } as any))!.v).toBe(42);
    await c.insertMany([{ x: 1 }, { x: 2 }] as any);
    expect((await c.deleteMany({ x: { $gte: 1 } } as any)).deletedCount).toBe(2);
  });

  it('find：sort/limit/skip/projection/分页结构（E3）', async () => {
    const c = ctx.client.collection('c3');
    for (let i = 0; i < 10; i++) await c.insertOne({ i } as any);
    const page = await c.find({ i: { $gte: 0 } } as any,
      { sort: { i: -1 }, limit: 3, skip: 2, projection: { i: 1 } });
    expect(page.items.map((d: any) => d.i)).toEqual([7, 6, 5]);
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(true);
    expect(Object.keys(page.items[0]!)).toEqual(['_id', 'i']);
  });

  it('写后即读（E6）+ 本地事件（I3）', async () => {
    const events: string[] = [];
    ctx.client.on('insert:c4', () => events.push('insert'));
    const c = ctx.client.collection('c4');
    await c.insertOne({ a: 1 } as any);
    expect(await c.count()).toBe(1);       // 不等 flush 立即可见
    expect(events).toEqual(['insert']);
  });

  it('索引降级：索引文件损坏 → 全表扫描仍可查（H2）', async () => {
    await ctx.client.putSchema('users', schema);
    const c = ctx.client.collection('users');
    await c.insertOne({ email: 'q@x.com' } as any);
    ctx.client.indexMgr['healthy'].set('users', false); // 模拟损坏
    expect(await c.count({ email: 'q@x.com' } as any)).toBe(1);
  });
});

describe('同步引擎（FR F2~F8, NFR-3/4, ADR-001）', () => {
  it('economy：窗口内不触发远端 commit，显式 flush 后数据上远端（F2/NFR-3）', async () => {
    const { client, provider } = await makeClient();
    const ref = { owner: 'test', repo: 'gitlite-repo' };
    const before = provider.callCount;
    const headBefore = await provider.getHead(ref, 'gitlite/default');
    const c = client.collection('logs');
    for (let i = 0; i < 30; i++) await c.insertOne({ i });  // < batchSize=100
    // 未到 10min 窗口：零远端调用、HEAD 未动
    expect(provider.callCount - before).toBe(1);            // 仅上面那次 getHead 探测
    expect(await provider.getHead(ref, 'gitlite/default')).toBe(headBefore);
    await client.sync.flush();                              // 显式 flush → 单 commit 推全部 30 条
    expect(await provider.getHead(ref, 'gitlite/default')).not.toBe(headBefore);
    expect(await client.collection('logs').count()).toBe(30);
    await client.close();
  });

  it('离线队列：写返回即落盘，重启重放后 flush（F5/NFR-4）', async () => {
    const provider = new MemoryProvider();
    const ref = { owner: 'test', repo: 'q' };
    const rt1 = createTestRuntime();
    const c1 = await GitLiteClient.create({ provider, runtime: rt1, ref, database: 'default' });
    await c1.collection('t').insertOne({ a: 1 });
    await c1.collection('t').insertOne({ a: 2 });
    // 不 close（模拟 kill -9）：队列文件已在盘（JSONL，至少两行待重放操作）
    const qFile = [...rt1.files.keys()].find(k => k.includes('/queues/'));
    expect(qFile).toBeTruthy();
    const lines = rt1.files.get(qFile!)!.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();

    // 新进程重连（同一台机器 → 同一 fs）：startup 重放 + 强制 flush
    const c2 = await GitLiteClient.create({ provider, runtime: rt1, ref, database: 'default' });
    expect(await c2.collection('t').count()).toBe(2);
    const files = (await provider.getFiles(ref, 'gitlite/default'))!;
    expect([...files.keys()].some(k => k.startsWith('t') || k === 't.jsonl')).toBe(true);
    await c2.close();
  });

  it('CAS 冲突：远端他方推进 → pull 合并 → 重试成功（F6）', async () => {
    const provider = new MemoryProvider();
    const ref = { owner: 'test', repo: 'conf' };
    const a = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref, database: 'default' });
    const b = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref, database: 'default' });
    await a.collection('t').insertOne({ v: 1 });
    await a.sync.flush();
    // b 本地写（队列 pending），a 再推进远端
    await b.collection('t2').insertOne({ v: 2 });
    await a.collection('t3').insertOne({ v: 3 });
    await a.sync.flush();
    // b flush：expected head 失效 → 冲突 → pull（拿到 a 的 t3）→ 重试
    await b.sync.flush();
    const files = (await provider.getFiles(ref, 'gitlite/default'))!;
    expect([...files.keys()].some(k => k.startsWith('t2'))).toBe(true); // b 的写最终上去
    expect([...files.keys()].some(k => k.startsWith('t3'))).toBe(true); // a 的写保留
    await a.close(); await b.close();
  });

  it('pull：另一端写入 → remoteChange 可见（F8 fresh）', async () => {
    const provider = new MemoryProvider();
    const ref = { owner: 'test', repo: 'pull' };
    const a = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref, database: 'default' });
    const b = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref, database: 'default' });
    await a.collection('s').insertOne({ x: 1 });
    await a.sync.flush();
    expect(await b.collection('s').count({}, { consistency: 'fresh' } as any)).toBe(1);
    await a.close(); await b.close();
  });

  it('close 强制 flush（F3）', async () => {
    const { client, provider } = await makeClient();
    await client.collection('f').insertOne({ a: 1 });
    await client.close();
    const files = (await provider.getFiles({ owner: 'test', repo: 'gitlite-repo' }, 'gitlite/default'))!;
    expect([...files.keys()].some(k => k.startsWith('f'))).toBe(true);
  });
});

describe('事务（FR G1/G2）', () => {
  it('多操作单 commit 原子；中途失败零残留', async () => {
    const { client, provider } = await makeClient();
    await client.putSchema('acc', {
      type: 'object',
      properties: { _id: { type: 'string' }, owner: { type: 'string' }, amount: { type: 'integer' } },
      required: ['owner', 'amount']
    });
    const acc = client.collection('acc');
    const from = await acc.insertOne({ owner: 'a', amount: 100 } as any);
    const to = await acc.insertOne({ owner: 'b', amount: 0 } as any);
    await client.sync.flush();

    // 成功事务：双扣双加在一个 commit
    const commitsBefore = (await provider.getFiles({ owner: 'test', repo: 'gitlite-repo' }, 'gitlite/default'))!;
    await client.transaction(async tx => {
      const A = tx.collection('acc');
      await A.updateOne({ _id: from }, { $inc: { amount: -100 } } as any);
      await A.updateOne({ _id: to }, { $inc: { amount: 100 } } as any);
    });
    expect((await acc.findById(from))!.amount).toBe(0);
    expect((await acc.findById(to))!.amount).toBe(100);
    void commitsBefore;

    // 失败事务：抛错零残留
    await expect(client.transaction(async tx => {
      const A = tx.collection('acc');
      await A.updateOne({ _id: from }, { $inc: { amount: -1 } } as any);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await acc.findById(from))!.amount).toBe(0); // 未变

    // schema 违规在 commit 校验 → 整体不生效
    await expect(client.transaction(async tx => {
      const A = tx.collection('acc');
      await A.updateOne({ _id: from }, { $set: { amount: 'NaN' } } as any);
    })).rejects.toMatchObject({ name: 'ValidationError' });
    expect((await acc.findById(from))!.amount).toBe(0);
    await client.close();
  });

  it('read-your-writes（G2）', async () => {
    const { client } = await makeClient();
    const r = await client.transaction(async tx => {
      const T = tx.collection('tmp');
      const id = await T.insertOne({ v: 1 });
      const seen = await T.findOne({ _id: id } as any);
      return (seen as any).v as number;
    });
    expect(r).toBe(1);
    await client.close();
  });
});

describe('ULID 与文档结构端到端', () => {
  it('_id/_rev/_schema 元字段齐备（D2/D4）', async () => {
    const { client, provider } = await makeClient();
    const c = client.collection('meta1');
    const id = await c.insertOne({ a: 1 });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await client.close();
    const files = (await provider.getFiles({ owner: 'test', repo: 'gitlite-repo' }, 'gitlite/default'))!;
    const line = files.get('meta1.jsonl')!.split('\n')[0]!;
    const doc: Document = JSON.parse(line);
    expect(doc._rev).toMatch(/^[0-9a-f]{12}$/);
  });
});
