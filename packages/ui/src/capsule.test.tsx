// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GitLiteCapsule } from './capsule.js';

afterEach(cleanup);

describe('GitLiteCapsule 状态胶囊组件', () => {
  it('未连接状态渲染连接中提示', () => {
    render(<GitLiteCapsule client={null} />);
    expect(screen.getByText('连接中…')).toBeTruthy();
  });

  it('连接状态渲染实时状态与分支名称', () => {
    const mockClient = {
      state: 'ready',
      branch: 'gitlite/myapp',
      syncStatus: () => ({
        online: true,
        state: 'ready',
        mode: 'normal',
        pendingOps: 0,
        lastSyncAt: '2026-08-21T00:00:00.000Z',
        remoteHeadOid: 'abc',
        conflicts: 0
      }),
      on: (_evt: string, _fn: any) => () => {},
      syncNow: vi.fn(async () => ({ pushed: true, pulled: false }))
    } as any;

    render(<GitLiteCapsule client={mockClient} />);
    expect(screen.getByText('实时同步')).toBeTruthy();
    expect(screen.getByText('myapp')).toBeTruthy();
    expect(screen.getByText('立即同步')).toBeTruthy();
  });

  it('点击立即同步触发 client.syncNow 与 onSync 回调', async () => {
    const syncNowMock = vi.fn(async () => ({ pushed: true, pulled: true }));
    const onSyncMock = vi.fn();
    const mockClient = {
      state: 'ready',
      branch: 'gitlite/myapp',
      syncStatus: () => ({ online: true, state: 'ready', pendingOps: 0, lastSyncAt: null, remoteHeadOid: null, conflicts: 0 }),
      on: (_evt: string, _fn: any) => () => {},
      syncNow: syncNowMock
    } as any;

    render(<GitLiteCapsule client={mockClient} onSync={onSyncMock} />);
    const syncBtn = screen.getByText('立即同步');

    await act(async () => {
      fireEvent.click(syncBtn);
    });

    expect(syncNowMock).toHaveBeenCalled();
    expect(onSyncMock).toHaveBeenCalledWith({ pushed: true, pulled: true });
  });

  it('紧凑模式隐藏立即同步按钮', () => {
    const mockClient = {
      state: 'ready',
      branch: 'gitlite/myapp',
      syncStatus: () => ({ online: true, state: 'ready', pendingOps: 0, lastSyncAt: null, remoteHeadOid: null, conflicts: 0 }),
      on: (_evt: string, _fn: any) => () => {}
    } as any;

    render(<GitLiteCapsule client={mockClient} compact={true} />);
    expect(screen.getByText('实时同步')).toBeTruthy();
    expect(screen.queryByText('立即同步')).toBeNull();
  });
});
