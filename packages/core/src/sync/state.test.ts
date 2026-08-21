import { describe, it, expect } from 'vitest';
import { GitLiteClient } from '../client.js';
import { MemoryProvider } from '../provider/memory.js';
import { createTestRuntime } from '../test/runtime.js';

describe('Sync State Machine & syncNow', () => {
  it('client 初始化状态为 ready，触发 status:change 事件', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const states: string[] = [];

    const client = await GitLiteClient.create({
      provider,
      runtime,
      ref: { owner: 'alice', repo: 'app' },
      database: 'memex',
      autoPullOnInit: true
    });

    client.on('status:change', e => {
      states.push(e.state);
    });

    expect(client.state).toBe('ready');
    expect(client.syncStatus().state).toBe('ready');

    // 写入数据并调用 syncNow
    await client.collection('notes').insertOne({ title: 'Note 1' });
    const result = await client.syncNow();

    expect(result.pushed).toBe(true);
    expect(client.state).toBe('synced');
    expect(states).toContain('syncing');
    expect(states).toContain('synced');

    await client.close();
  });

  it('多端主动同步 syncNow 返回 pulled/pushed 状态', async () => {
    const provider = new MemoryProvider();
    const runtime1 = createTestRuntime();
    const runtime2 = createTestRuntime();

    // 客户端 1：创建并写入一条数据
    const client1 = await GitLiteClient.create({
      provider,
      runtime: runtime1,
      ref: { owner: 'alice', repo: 'app' },
      database: 'notes'
    });
    await client1.collection('items').insertOne({ content: 'Item from client1' });
    await client1.syncNow();

    // 客户端 2：连接同一个库并拉取
    const client2 = await GitLiteClient.create({
      provider,
      runtime: runtime2,
      ref: { owner: 'alice', repo: 'app' },
      database: 'notes',
      autoPullOnInit: true
    });

    const items = await client2.collection('items').find({});
    expect(items.items.length).toBe(1);
    expect((items.items[0] as any).content).toBe('Item from client1');

    // 客户端 1 再次写入
    await client1.collection('items').insertOne({ content: 'Item 2' });
    await client1.syncNow();

    // 客户端 2 主动 syncNow，检测到远端拉取
    const res2 = await client2.syncNow();
    expect(res2.pulled).toBe(true);

    const itemsAfter = await client2.collection('items').find({});
    expect(itemsAfter.items.length).toBe(2);

    await client1.close();
    await client2.close();
  });
});
