// 短/长事务（FR G1/G2）+ SAVEPOINT（P3：SQLite SAVEPOINT 对位）：
// buffer 覆盖层 → commit 批量应用 + 单次强制 flush（单 commit 原子）；
// savepoint/rollbackTo 支持长事务内部分回滚（纯本地，不破坏单 commit 原子性）
import { ValidationError } from '../errors.js';
import type { EventBus } from '../event.js';
import type { StorageEngine } from '../storage/engine.js';
import type { IndexManager } from '../index/manager.js';
import type { CommitQueue } from '../sync/queue.js';
import { Collection, type CollectionDeps } from '../query/collection.js';
import { applyUpdate } from '../query/update.js';
import { matches } from '../query/filter.js';
import { computeRev } from '../model/rev.js';
import type { Document } from '../types.js';

interface TxCtxState {
  upserts: Map<string, { collection: string; doc: Document }>;
  deletes: Map<string, { collection: string; id: string }>;
  /** SAVEPOINT 栈（P3）：每层保存当时 buffer 快照 */
  savepoints: { name: string; upserts: Map<string, { collection: string; doc: Document }>;
    deletes: Map<string, { collection: string; id: string }> }[];
}

function snapshotBuffer(state: TxCtxState): { upserts: TxCtxState['upserts']; deletes: TxCtxState['deletes'] } {
  return { upserts: new Map(state.upserts), deletes: new Map(state.deletes) };
}

export class TransactionManager {
  private active: TxCtxState | null = null;

  constructor(
    private deps: () => CollectionDeps,
    private storage: StorageEngine,
    private indexMgr: IndexManager,
    private queue: CommitQueue,
    private bus: EventBus,
    private flushNow: () => Promise<void>
  ) {}

  isActive(): boolean { return this.active !== null; }

  /** 事务内 collection：读=镜像+buffer，写=入 buffer（read-your-writes，G2） */
  collection<T>(name: string): TxCollection<T> {
    return new TxCollection<T>(name, this.deps(), this.active!);
  }

  async run<T>(fn: (tx: TransactionManager) => Promise<T>): Promise<T> {
    if (this.active) throw new ValidationError(['nested transaction not supported in v0.1']);
    this.active = { upserts: new Map(), deletes: new Map(), savepoints: [] };
    try {
      const result = await fn(this);
      await this.commit();
      return result;
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  /** SAVEPOINT（P3）：保存当前 buffer 快照。同名 savepoint 隐式释放旧同名（SQLite 语义）。 */
  savepoint(name: string): void {
    if (!this.active) throw new Error('no active transaction');
    // 移除旧同名（隐式释放，SQLite 语义）
    this.active.savepoints = this.active.savepoints.filter(s => s.name !== name);
    this.active.savepoints.push({ name, ...snapshotBuffer(this.active) });
  }

  /** 回滚到指定 SAVEPOINT。释放该点之后的所有 savepoint。 */
  rollbackTo(name: string): void {
    if (!this.active) throw new Error('no active transaction');
    // 从栈顶往下找最后一个同名点（lib 未启用 es2023，手动反向查找）
    let idx = -1;
    for (let i = this.active.savepoints.length - 1; i >= 0; i--) {
      if (this.active.savepoints[i]!.name === name) { idx = i; break; }
    }
    if (idx < 0) throw new Error(`savepoint not found: "${name}"`);
    const sp = this.active.savepoints[idx]!;
    // 恢复 buffer
    this.active.upserts = new Map(sp.upserts);
    this.active.deletes = new Map(sp.deletes);
    // 释放该点及之后的所有 savepoint
    this.active.savepoints = this.active.savepoints.slice(0, idx);
  }

  /** 提交：全部校验 → 批量应用镜像+索引+队列 → 单次 flush（G1 单 commit） */
  private async commit(): Promise<void> {
    const tx = this.active!;
    this.active = null;
    const d = this.deps();
    try {
      // 终算元字段（buffer 中 update 未重算 _rev）+ 整体校验
      for (const { collection, doc } of tx.upserts.values()) {
        doc.updatedAt = new Date().toISOString();
        doc._rev = computeRev(d.crypto, doc);
        this.storage.validate(collection, doc);
      }
      // 应用 upsert
      for (const { collection, doc } of tx.upserts.values()) {
        const before = this.storage.read(collection, doc._id);
        this.indexMgr.checkUnique(collection, doc);
        this.storage.upsert(collection, doc);
        this.indexMgr.onWrite(collection, before, doc);
        await this.queue.enqueue({ kind: 'upsert', collection, doc });
        this.bus.emit(before ? `update:${collection}` : `insert:${collection}`, before ?? doc);
      }
      // 应用 delete
      for (const { collection, id } of tx.deletes.values()) {
        if (tx.upserts.has(`${collection}::${id}`)) continue; // 同事务先写后删 → 净效果删
        const before = this.storage.read(collection, id);
        if (before) {
          this.storage.delete(collection, id);
          this.indexMgr.onWrite(collection, before, null);
          await this.queue.enqueue({ kind: 'delete', collection, id });
          this.bus.emit(`delete:${collection}`, before);
        }
      }
      // 单次原子 flush（全部变更打包进一个 commit）
      await this.flushNow();
    } catch (e) {
      // flush 失败：镜像已应用但未推远端——保留在队列（下次 flush 补推），镜像不回滚
      // （原子性语义 = 单 commit；本地镜像与远端最终一致，F5 重放兜底）
      throw e;
    }
  }

  private rollback(): void {
    this.active = null; // 弃 buffer，镜像零残留（G1 失败语义）
  }

  bufferUpsert(collection: string, doc: Document): void {
    this.active!.upserts.set(`${collection}::${doc._id}`, { collection, doc });
    this.active!.deletes.delete(`${collection}::${doc._id}`);
  }

  bufferDelete(collection: string, id: string): void {
    this.active!.deletes.set(`${collection}::${id}`, { collection, id });
    this.active!.upserts.delete(`${collection}::${id}`);
  }

  bufferedUpserts(): { collection: string; doc: Document }[] {
    return [...(this.active?.upserts.values() ?? [])];
  }

  bufferedDeletes(): { collection: string; id: string }[] {
    return [...(this.active?.deletes.values() ?? [])];
  }
}

/** 事务内 Collection：写进 buffer；读合并 buffer */
export class TxCollection<T = any> {
  private c: Collection<T>;

  constructor(
    public readonly name: string,
    private d: CollectionDeps,
    private tx: TxCtxState
  ) {
    // 显式在构造体内创建：字段初始化器早于参数属性赋值，会捕获到 undefined
    this.c = new Collection<T>(name, d);
  }

  async insertOne(doc: any): Promise<string> {
    const prepared = (this.c as any).prepareInsert(doc);
    this.d.storage.validate(this.name, prepared);
    this.tx.upserts.set(`${this.name}::${prepared._id}`, { collection: this.name, doc: prepared });
    return prepared._id;
  }

  async updateOne(filter: any, update: any, opts?: any): Promise<any> {
    const targets = (this.c as any).targets(filter);
    if (!targets.length) return { matchedCount: 0, modifiedCount: 0 };
    const old = this.bufferedOrStored(targets[0]!);
    const next = applyUpdate(old, update);
    next._rev = undefined; // commit 时重算
    this.tx.upserts.set(`${this.name}::${next._id}`, { collection: this.name, doc: next });
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter: any): Promise<any> {
    const targets = (this.c as any).targets(filter);
    if (!targets.length) return { deletedCount: 0 };
    this.tx.deletes.set(`${this.name}::${targets[0]!}`, { collection: this.name, id: targets[0]! });
    return { deletedCount: 1 };
  }

  async findOne(filter?: any, opts?: any): Promise<T | null> {
    // buffer 优先（read-your-writes）
    for (const { collection, doc } of this.tx.upserts.values()) {
      if (collection === this.name && matches(doc, filter)) {
        return doc as T;
      }
    }
    return this.c.findOne(filter, opts);
  }

  async find(filter?: any, opts?: any): Promise<any> {
    const stored = await this.c.find(filter, opts);
    const buffered: Document[] = [];
    for (const u of this.tx.upserts.values()) {
      if (u.collection === this.name && matches(u.doc, filter)) buffered.push(u.doc);
    }
    const seen = new Set(stored.items.map((d: any) => d._id));
    const extra = buffered.filter(d => !seen.has(d._id) && !this.tx.deletes.has(`${this.name}::${d._id}`));
    return { ...stored, items: [...stored.items, ...extra] };
  }

  private bufferedOrStored(id: string): Document {
    const buf = this.tx.upserts.get(`${this.name}::${id}`);
    return buf?.doc ?? this.d.storage.read(this.name, id)!;
  }
}
