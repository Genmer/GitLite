// @vitest-environment jsdom
// @gitlite/react hooks 测试：真实 memory provider 链路（HOME 重定向防真实 ~/.gitlite 污染）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFind, useUpdate, useSyncStatus } from './index.js';
import { connect } from '@gitlite/sdk';
import type { GitLiteClient } from '@gitlite/sdk';

const realHome = process.env.USERPROFILE ?? process.env.HOME;
let tmpHome = '';
beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gitlite-react-'));
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
});
afterAll(() => {
  process.env.USERPROFILE = realHome;
  process.env.HOME = realHome;
});

async function fixture(): Promise<GitLiteClient> {
  const db = await connect('gitlite://memory:t@me/react-db/default');
  await db.putSchema('users', {
    type: 'object',
    properties: { email: { type: 'string' }, age: { type: 'integer' } }
  } as any);
  const users = db.collection('users');
  await users.insertOne({ email: 'a@x.dev', age: 30 } as any);
  await users.insertOne({ email: 'b@x.dev', age: 20 } as any);
  return db;
}

describe('useFind', () => {
  it('初始加载 + filter 过滤 + 手动 refetch', async () => {
    const db = await fixture();
    const { result } = renderHook(() => useFind(db, 'users', { age: { $gte: 25 } }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(1);
    expect((result.current.items[0] as any).email).toBe('a@x.dev');
    expect(result.current.total).toBe(1);

    // 新写入 → refetch 拉到
    await act(async () => {
      await db.collection('users').insertOne({ email: 'c@x.dev', age: 40 } as any);
    });
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await db.close();
  });

  it('remoteChange 事件 → 自动 refetch（docs/09 契约）', async () => {
    const db = await fixture();
    const { result } = renderHook(() => useFind(db, 'users', {}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(2);

    await act(async () => {
      await db.collection('users').insertOne({ email: 'd@x.dev', age: 50 } as any);
      db.bus.emit('remoteChange', {}); // 远端到达（本地写测试用直接广播模拟）
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    await db.close();
  });

  it('db 为 null → 稳定 loading 态', async () => {
    const { result } = renderHook(() => useFind(null, 'users', {}));
    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([]);
  });
});

describe('useUpdate', () => {
  it('更新成功返回 true 并置 pending 往返', async () => {
    const db = await fixture();
    const { result } = renderHook(() => useUpdate(db, 'users'));
    let ok = false;
    await act(async () => {
      ok = await result.current[0]({ email: 'a@x.dev' }, { $set: { age: 31 } });
    });
    expect(ok).toBe(true);
    expect(result.current[1]).toBe(false);
    expect((await db.collection('users').findOne({ email: 'a@x.dev' } as any) as any)?.age).toBe(31);
    await db.close();
  });
});

describe('useSyncStatus', () => {
  it('响应 db 同步状态与 syncNow 调用', async () => {
    const db = await fixture();
    const { result } = renderHook(() => useSyncStatus(db));

    expect(result.current.state).toBe('ready');
    expect(result.current.status).toBeDefined();
    expect(result.current.syncing).toBe(false);

    let syncResult: any;
    await act(async () => {
      syncResult = await result.current.syncNow();
    });

    expect(syncResult).toBeDefined();
    expect(result.current.state).toBe('synced');
    await db.close();
  });
});
