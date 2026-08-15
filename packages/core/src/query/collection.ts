// Collection API（FR E1~E6）：Mongo 风格 CRUD；写=镜像+队列+调度，读=镜像（+一致性选项）
import { ConflictError, NotFoundError } from '../errors.js';
import type { EventBus } from '../event.js';
import type { CryptoAdapter } from '../runtime.js';
import type { IndexManager } from '../index/manager.js';
import { matches } from '../query/filter.js';
import { applyUpdate } from '../query/update.js';
import { computeRev } from '../model/rev.js';
import type { Ulid } from '../model/ulid.js';
import type { StorageEngine } from '../storage/engine.js';
import type { CommitQueue } from '../sync/queue.js';
import type {
  DeleteResult, Document, Filter, FindOptions, Json, OptionalId,
  Page, Update, UpdateOptions, UpdateResult
} from '../types.js';

export interface CollectionDeps {
  storage: StorageEngine;
  indexMgr: IndexManager;
  queue: CommitQueue;
  crypto: CryptoAdapter;
  ulid: Ulid;
  bus: EventBus;
  schedule: () => void;
  flushNow: () => Promise<void>;
  pullNow: () => Promise<void>;
  /** foreign 仓库未确认 → 写操作拦截（FR A4） */
  readOnly: () => boolean;
}

export class Collection<T = any> {
  constructor(public readonly name: string, private d: CollectionDeps) {}

  // ---------- Create ----------

  async insertOne(doc: OptionalId<T>): Promise<string> {
    this.assertWritable();
    const d = this.prepareInsert(doc);
    this.d.storage.validate(this.name, d);
    this.d.indexMgr.checkUnique(this.name, d);
    this.d.storage.upsert(this.name, d);
    this.d.indexMgr.onWrite(this.name, null, d);
    await this.d.queue.enqueue({ kind: 'upsert', collection: this.name, doc: d });
    this.d.schedule();
    this.d.bus.emit(`insert:${this.name}`, d);
    return d._id;
  }

  async insertMany(docs: OptionalId<T>[]): Promise<string[]> {
    const ids: string[] = [];
    for (const doc of docs) ids.push(await this.insertOne(doc));
    return ids;
  }

  // ---------- Read ----------

  async findOne(filter?: Filter, opts?: FindOptions): Promise<T | null> {
    await this.consistency(opts?.consistency);
    const docs = this.candidates(filter).map(id => this.d.storage.read(this.name, id)!);
    const hit = docs.filter(d => matches(d, filter));
    const sorted = sortDocs(hit, opts?.sort);
    return (sorted[0] ?? null) as T | null;
  }

  async findById(id: string, opts?: FindOptions): Promise<T | null> {
    await this.consistency(opts?.consistency);
    const d = this.d.storage.read(this.name, id);
    return (d ? project(d, opts?.projection) : null) as T | null;
  }

  async find(filter?: Filter, opts?: FindOptions): Promise<Page<T>> {
    await this.consistency(opts?.consistency);
    let docs = this.candidates(filter).map(id => this.d.storage.read(this.name, id)!);
    docs = docs.filter(d => matches(d, filter));
    docs = sortDocs(docs, opts?.sort);
    const total = docs.length;
    const skip = opts?.skip ?? 0;
    const limit = opts?.limit ?? total;
    const items = docs.slice(skip, skip + limit).map(d => project(d, opts?.projection));
    return { items: items as T[], total, hasMore: skip + limit < total };
  }

  async count(filter?: Filter, opts?: FindOptions): Promise<number> {
    await this.consistency(opts?.consistency);
    return this.candidates(filter).filter(id => matches(this.d.storage.read(this.name, id)!, filter)).length;
  }

  async exists(filter?: Filter): Promise<boolean> {
    return (await this.findOne(filter)) !== null;
  }

  // ---------- Update ----------

  async updateOne(filter: Filter, update: Update, opts?: UpdateOptions): Promise<UpdateResult> {
    this.assertWritable();
    await this.consistency(undefined);
    const targets = this.targets(filter);
    if (targets.length === 0) {
      if (opts?.upsert) {
        const seed = filterToSeed(filter);
        const id = await this.insertOne({ ...seed, ...plainSet(update) } as OptionalId<T>);
        return { matchedCount: 0, modifiedCount: 0, upsertedId: id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const target = targets[0]!;
    await this.applyUpdateOne(target, update, opts);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    this.assertWritable();
    const targets = this.targets(filter);
    for (const t of targets) await this.applyUpdateOne(t, update);
    return { matchedCount: targets.length, modifiedCount: targets.length };
  }

  async replaceOne(filter: Filter, doc: OptionalId<T>, opts?: UpdateOptions): Promise<UpdateResult> {
    this.assertWritable();
    const targets = this.targets(filter);
    if (!targets.length) {
      if (opts?.upsert) {
        const id = await this.insertOne(doc);
        return { matchedCount: 0, modifiedCount: 0, upsertedId: id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const old = this.d.storage.read(this.name, targets[0]!)!;
    const next = this.prepareUpdate(old, { ...doc, _id: old._id } as Document, opts);
    this.d.storage.validate(this.name, next);
    this.d.indexMgr.checkUnique(this.name, next);
    this.d.storage.upsert(this.name, next);
    this.d.indexMgr.onWrite(this.name, old, next);
    await this.d.queue.enqueue({ kind: 'upsert', collection: this.name, doc: next });
    this.d.schedule();
    this.d.bus.emit(`update:${this.name}`, { before: old, after: next });
    return { matchedCount: 1, modifiedCount: 1 };
  }

  // ---------- Delete ----------

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    this.assertWritable();
    const targets = this.targets(filter);
    if (!targets.length) return { deletedCount: 0 };
    await this.applyDelete(targets[0]!);
    return { deletedCount: 1 };
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    this.assertWritable();
    const targets = this.targets(filter);
    for (const id of targets) await this.applyDelete(id);
    return { deletedCount: targets.length };
  }

  // ---------- 内部 ----------

  private assertWritable(): void {
    if (this.d.readOnly()) {
      throw new Error(`collection "${this.name}" is read-only: bound repo is foreign and not confirmed (FR A4)`);
    }
  }

  private async consistency(mode?: 'cache' | 'synced' | 'fresh'): Promise<void> {
    if (mode === 'fresh') await this.d.pullNow();
    else if (mode === 'synced') await this.d.flushNow();
  }

  /** 索引可用→候选集；否则全表（FR H2 降级） */
  private candidates(filter?: Filter): string[] {
    if (filter) {
      const eq = firstIndexedEq(this.d.indexMgr, this.name, filter);
      if (eq) return eq;
    }
    return this.d.storage.scan(this.name).map(d => d._id);
  }

  private targets(filter: Filter): string[] {
    return this.candidates(filter)
      .filter(id => matches(this.d.storage.read(this.name, id)!, filter));
  }

  private prepareInsert(input: OptionalId<T>): Document {
    const base = { ...(input as object) } as Document;
    if (!base._id) base._id = this.d.ulid.generate();
    const schema = this.d.storage.getSchema(this.name);
    const timestamps = schema?.gitliteDescriptor?.timestamps !== false; // 默认 true（D5）
    const now = new Date().toISOString();
    if (timestamps && base.createdAt === undefined) base.createdAt = now;
    if (timestamps && base.updatedAt === undefined) base.updatedAt = now;
    base._rev = computeRev(this.d.crypto, stripRev(base));
    return base;
  }

  private prepareUpdate(old: Document, next: Document, opts?: UpdateOptions): Document {
    if (opts?.expectedRev !== undefined && old._rev !== opts.expectedRev) {
      throw new ConflictError('OCC: _rev mismatch', { expected: opts.expectedRev, actual: old._rev });
    }
    next.createdAt = old.createdAt; // 不可变
    next._rev = computeRev(this.d.crypto, stripRev(next));
    return next;
  }

  private async applyUpdateOne(id: string, update: Update, opts?: UpdateOptions): Promise<void> {
    const old = this.d.storage.read(this.name, id)!;
    const merged = applyUpdate(old, update);
    const next = this.prepareUpdate(old, merged, opts);
    this.d.storage.validate(this.name, next);
    this.d.indexMgr.checkUnique(this.name, next);
    this.d.storage.upsert(this.name, next);
    this.d.indexMgr.onWrite(this.name, old, next);
    await this.d.queue.enqueue({ kind: 'upsert', collection: this.name, doc: next });
    this.d.schedule();
    this.d.bus.emit(`update:${this.name}`, { before: old, after: next });
  }

  private async applyDelete(id: string): Promise<void> {
    const old = this.d.storage.read(this.name, id);
    if (!old) return;
    this.d.storage.delete(this.name, id);
    this.d.indexMgr.onWrite(this.name, old, null);
    await this.d.queue.enqueue({ kind: 'delete', collection: this.name, id });
    this.d.schedule();
    this.d.bus.emit(`delete:${this.name}`, old);
  }
}

// ---------- 辅助 ----------

function stripRev(d: Document): Document {
  const { _rev, ...rest } = d as any;
  return rest;
}

function sortDocs(docs: Document[], sort?: Record<string, 1 | -1>): Document[] {
  if (!sort || !Object.keys(sort).length) return docs;
  return [...docs].sort((a, b) => {
    for (const [k, dir] of Object.entries(sort)) {
      const av = getPath(a, k), bv = getPath(b, k);
      if (av === bv) continue;
      return (av > bv ? 1 : -1) * (dir === 1 ? 1 : -1);
    }
    return 0;
  });
}

function getPath(doc: any, path: string): any {
  let cur = doc;
  for (const seg of path.split('.')) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function project(doc: Document, projection?: Record<string, 0 | 1>): Document {
  if (!projection) return doc;
  const out: any = { _id: doc._id };
  const include = Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k);
  if (include.length) {
    for (const k of include) out[k] = getPath(doc, k);
  } else {
    const exclude = Object.entries(projection).filter(([, v]) => v === 0).map(([k]) => k);
    for (const [k, v] of Object.entries(doc)) if (!exclude.includes(k)) out[k] = v;
  }
  return out;
}

/** 简单等值条件优先走索引 */
function firstIndexedEq(indexMgr: IndexManager, c: string, filter: Filter): string[] | null {
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) continue;
    const value = (typeof v === 'object' && v !== null && '$eq' in (v as any))
      ? (v as any).$eq : v;
    const ids = indexMgr.candidates(c, k, value);
    if (ids !== null) return ids;
  }
  return null;
}

/** upsert 种子：从 filter 提取无操作符的等值字段 */
function filterToSeed(filter: Filter): Record<string, Json> {
  const seed: Record<string, Json> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) continue;
    if (v === null || typeof v !== 'object') seed[k] = v as Json;
  }
  return seed;
}

function plainSet(update: Update): Record<string, Json> {
  return update.$set ?? {};
}
