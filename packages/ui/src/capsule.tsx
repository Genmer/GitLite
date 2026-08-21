// GitLiteCapsule：状态胶囊与呼吸灯组件（驱动前端状态栏 / Header Capsule）
import { useState, useEffect, useCallback } from 'react';
import type { GitLiteClient } from '@gitlite/sdk';

export interface GitLiteCapsuleProps {
  /** GitLiteClient 实例 */
  client?: GitLiteClient | null;
  /** 兼容别名：数据库连接实例 */
  db?: GitLiteClient | null;
  /** 自定义根容器 class */
  className?: string;
  /** 紧凑模式（只显示呼吸灯与简略状态，隐藏同步按钮） */
  compact?: boolean;
  /** 同步完成回调 */
  onSync?: (res: { pushed: boolean; pulled: boolean }) => void;
}

export function GitLiteCapsule(props: GitLiteCapsuleProps) {
  const targetClient = props.client ?? props.db ?? null;
  const [state, setState] = useState<'connecting' | 'ready' | 'syncing' | 'synced' | 'offline' | 'error'>(
    targetClient ? (targetClient as any).state ?? 'ready' : 'connecting'
  );
  const [status, setStatus] = useState<any>(targetClient ? targetClient.syncStatus() : null);
  const [manualSyncing, setManualSyncing] = useState(false);

  useEffect(() => {
    if (!targetClient) {
      setState('connecting');
      setStatus(null);
      return;
    }
    setState((targetClient as any).state ?? 'ready');
    setStatus(targetClient.syncStatus());

    const off1 = targetClient.on('status:change', (e: { state: any }) => {
      setState(e.state);
      setStatus(targetClient.syncStatus());
    });
    const off2 = targetClient.on('sync:push', () => setStatus(targetClient.syncStatus()));
    const off3 = targetClient.on('sync:pull', () => setStatus(targetClient.syncStatus()));
    return () => { off1(); off2(); off3(); };
  }, [targetClient]);

  const handleSyncClick = useCallback(async () => {
    if (!targetClient || manualSyncing || state === 'syncing') return;
    setManualSyncing(true);
    try {
      let res: { pushed: boolean; pulled: boolean };
      if (typeof (targetClient as any).syncNow === 'function') {
        res = await (targetClient as any).syncNow();
      } else {
        await (targetClient as any).sync.pull();
        await (targetClient as any).sync.flush();
        res = { pushed: true, pulled: true };
      }
      props.onSync?.(res);
    } catch {
      // ignore
    } finally {
      setManualSyncing(false);
    }
  }, [targetClient, manualSyncing, state, props.onSync]);

  const isSyncing = state === 'syncing' || manualSyncing;

  const stateConfig = {
    connecting: { label: '连接中…', dotClass: 'gl-capsule-dot-connecting' },
    ready: { label: '实时同步', dotClass: 'gl-capsule-dot-synced' },
    syncing: { label: '正在同步…', dotClass: 'gl-capsule-dot-syncing' },
    synced: { label: '已同步', dotClass: 'gl-capsule-dot-synced' },
    offline: { label: '离线模式', dotClass: 'gl-capsule-dot-offline' },
    error: { label: '同步异常', dotClass: 'gl-capsule-dot-error' }
  }[state] ?? { label: '就绪', dotClass: 'gl-capsule-dot-synced' };

  const dbBranch = targetClient ? (targetClient as any).branch ?? 'main' : '';
  const branchDisplay = dbBranch.startsWith('gitlite/') ? dbBranch.slice('gitlite/'.length) : dbBranch;

  return (
    <div className={`gl-capsule ${props.className ?? ''}`}>
      <span className={`gl-capsule-dot ${stateConfig.dotClass}`} />
      <span className="gl-capsule-state">{stateConfig.label}</span>
      {branchDisplay && (
        <span className="gl-capsule-badge" title={`分支: ${dbBranch}`}>
          {branchDisplay}
        </span>
      )}
      {!props.compact && (
        <button
          type="button"
          className="gl-capsule-sync-btn"
          disabled={!targetClient || isSyncing || state === 'offline'}
          onClick={handleSyncClick}
          title="立即执行双向增量同步"
        >
          <svg className={`gl-capsule-sync-icon ${isSyncing ? 'gl-spin' : ''}`} viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
            <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
          </svg>
          {isSyncing ? '同步中' : '立即同步'}
        </button>
      )}
    </div>
  );
}
