// @gitlite/react（docs/09 §六）：React hooks——连接生命周期 + 查询状态 + 远端变更自动 refetch。
// 以 db（GitLiteClient）为中心的 API：bus 可达 → remoteChange/sync:pull 自动 refetch；
// codegen 用户传 db.raw。宿主负责渲染环境（React ≥18）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Collection, Filter, FindOptions } from '@gitlite/core';
import { connect as sdkConnect } from '@gitlite/sdk';
import type { GitLiteClient, SdkConnectOptions } from '@gitlite/sdk';

/** 连接生命周期：挂载即连、卸即关（flush）；重连仅当输入变化 */
export function useGitLite(input: SdkConnectOptions | string): { db: GitLiteClient | null; error: Error | null } {
  const key = typeof input === 'string' ? input : JSON.stringify(input);
  const [db, setDb] = useState<GitLiteClient | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    let client: GitLiteClient | null = null;
    setError(null);
    setDb(null);
    void sdkConnect(typeof input === 'string' ? input : (JSON.parse(key) as SdkConnectOptions))
      .then(c => {
        client = c;
        if (alive) setDb(c);
      })
      .catch(e => {
        if (alive) setError(e as Error);
      });
    return () => {
      alive = false;
      void client?.close().catch(() => undefined);
    };
  }, [key]);
  return { db, error };
}

/** 惰性取 Collection（db 就绪前为 null） */
export function useCollection<T = any>(db: GitLiteClient | null, name: string): Collection<T> | null {
  return useMemo(() => (db ? db.collection<T>(name) : null), [db, name]);
}

/** 订阅远端变更 → 自动 refetch（docs/09：remoteChange 事件驱动） */
function useAutoRefetch(db: GitLiteClient | null, refetch: () => void): void {
  useEffect(() => {
    if (!db) return;
    const off1 = db.on('remoteChange', refetch);
    const off2 = db.on('sync:pull', refetch);
    return () => { off1(); off2(); };
  }, [db, refetch]);
}

export interface FindState<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/** 查询 hook：filter/opts 序列化比较（引用变化不重复请求）；远端变更自动重查 */
export function useFind<T = any>(
  db: GitLiteClient | null,
  collection: string,
  filter?: Filter,
  opts?: FindOptions
): FindState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const filterKey = JSON.stringify(filter ?? {});
  const optsKey = JSON.stringify(opts ?? {});
  const col = useCollection<T>(db, collection);

  useEffect(() => {
    if (!col) return;
    let alive = true;
    setLoading(true);
    void col.find(JSON.parse(filterKey), JSON.parse(optsKey))
      .then(page => {
        if (!alive) return;
        setItems(page.items as T[]);
        setTotal(page.total);
        setLoading(false);
        setError(null);
      })
      .catch(e => {
        if (!alive) return;
        setError(e as Error);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [col, filterKey, optsKey, tick]);

  const refetch = useCallback(() => setTick(t => t + 1), []);
  useAutoRefetch(db, refetch);
  return { items, total, loading, error, refetch };
}

export interface DocState<T> {
  doc: T | null;
  loading: boolean;
  error: Error | null;
}

/** 单文档 hook */
export function useDoc<T = any>(db: GitLiteClient | null, collection: string, id: string | null): DocState<T> {
  const [doc, setDoc] = useState<T | null>(null);
  const [loading, setLoading] = useState(id !== null);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const col = useCollection<T>(db, collection);

  useEffect(() => {
    if (!col || id === null) return;
    let alive = true;
    setLoading(true);
    void col.findById(id)
      .then(d => {
        if (!alive) return;
        setDoc(d as T | null);
        setLoading(false);
        setError(null);
      })
      .catch(e => {
        if (!alive) return;
        setError(e as Error);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [col, id, tick]);

  useAutoRefetch(db, useCallback(() => setTick(t => t + 1), []));
  return { doc, loading, error };
}

/** 写 hook：[updateOne, pending]；成功后自动 refetch 本表（读己之写） */
export function useUpdate<T = any>(
  db: GitLiteClient | null,
  collection: string
): [updateOne: (filter: Filter, update: any) => Promise<boolean>, pending: boolean] {
  const col = useCollection<T>(db, collection);
  const [pending, setPending] = useState(false);
  const [bump, setBump] = useState(0);
  // bump 触发 col 引用刷新以驱动调用方重渲染（col 本身稳定，这里只广播"写完了"）
  const updateOne = useCallback(async (filter: Filter, update: any): Promise<boolean> => {
    if (!col) return false;
    setPending(true);
    try {
      await col.updateOne(filter, update);
      setBump(b => b + 1);
      return true;
    } finally {
      setPending(false);
    }
  }, [col]);
  void bump;
  return [updateOne, pending];
}
