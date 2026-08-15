// 同步引擎：economy 低频 flush / 强制启动退出 / 离线重放 / CAS 冲突重试 / pull 合并
//（FR F2~F8，ADR-001）
import { ConflictError, FormatVersionError, QuotaExceededError } from '../errors.js';
import type { EventBus } from '../event.js';
import type { GitProvider } from '../provider/memory.js';
import type { RuntimeAdapter } from '../runtime.js';
import { parseJsonc } from '../schema/jsonc.js';
import { parseDocs, StorageEngine } from '../storage/engine.js';
import type { IndexManager } from '../index/manager.js';
import type { QuotaTracker } from '../quota/tracker.js';
import { SYS, type RepoRef, type SyncPolicy, type SyncStatus } from '../types.js';
import type { CommitQueue } from './queue.js';

const COMMIT_CALL_COST = 4; // Git DB API 四步的预算估计（K2）

export class SyncEngine {
  private headOid: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private lastSyncAt: string | null = null;
  private mode: 'normal' | 'fully-local' = 'normal';
  private conflictCount = 0;

  constructor(
    private provider: GitProvider,
    private ref: RepoRef,
    private branch: string,
    private storage: StorageEngine,
    private indexMgr: IndexManager,
    private queue: CommitQueue,
    private policy: SyncPolicy,
    private quota: QuotaTracker,
    private bus: EventBus,
    private runtime: RuntimeAdapter
  ) {}

  // ---------- 连接流程 ----------

  /** 首次/重启：重放遗留队列 → pull → flush（FR F3 强制） */
  async startup(files: Map<string, string> | null): Promise<void> {
    if (files) {
      this.storage.importFiles(files);
      this.indexMgr.importFiles(files);
      const cfg = files.get(SYS.configPath);
      if (cfg) {
        const { formatVersion } = JSON.parse(cfg);
        checkFormatVersion(formatVersion, this.bus);
      }
      const docs = parseDocs(files);
      for (const [c, m] of docs) this.indexMgr.rebuild(c, [...m.values()]);
    }
    this.headOid = await this.track(() => this.provider.getHead(this.ref, this.branch));

    // 重放本地遗留队列（进程崩溃场景，NFR-4）
    const pending = await this.queue.load();
    if (pending.length && files) {
      this.replay(pending);
    }
    await this.flush(); // 启动强制同步（含 bootstrap 空 commit）
  }

  // ---------- 写调度（economy）----------

  schedule(): void {
    if (this.queue.size() >= this.policy.batchSize) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.policy.timeWindowMs);
    // 长窗口定时器不阻塞进程退出（Node unref；浏览器无此方法则忽略）
    if (typeof (this.timer as any)?.unref === 'function') (this.timer as any).unref();
  }

  // ---------- flush（push）----------

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (let attempt = 0; attempt <= this.policy.maxRetries; attempt++) {
        const changes = this.storage.diff();
        if (changes.length === 0) {
          await this.queue.clear();
          return;
        }
        if (!this.quota.canSpend(COMMIT_CALL_COST)) {
          this.bus.emit('quota:warning', this.quota.status());
          throw new QuotaExceededError(60_000); // 保留队列，等下个窗口
        }
        try {
          const { oid } = await this.track(() =>
            this.provider.commit(this.ref, this.branch, commitMessage(), changes, this.headOid ?? undefined));
          this.headOid = oid;
          this.storage.markSynced();
          await this.queue.clear();
          this.lastSyncAt = new Date(this.runtime.now()).toISOString();
          this.bus.emit('sync:push', { oid, changes: changes.length });
          return;
        } catch (e) {
          if (e instanceof ConflictError && attempt < this.policy.maxRetries) {
            this.conflictCount++;
            this.bus.emit('sync:conflict', { attempt, expected: e.expected, actual: e.actual });
            await this.pull(); // rebase 前置：拿远端最新
            continue;
          }
          throw e;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // ---------- pull（合并远端变更）----------

  async pull(): Promise<void> {
    const head = await this.track(() => this.provider.getHead(this.ref, this.branch));
    if (head === null) return; // 分支不存在（连接流程已保证存在，防御）
    if (head === this.headOid) return;

    const remoteFiles = await this.track(() => this.provider.getFiles(this.ref, this.branch));
    if (!remoteFiles) return;

    // 本地待提交快照（dirty 集）
    const pending = this.queue.snapshot();
    const dirtyUpserts = new Map<string, any>();
    const dirtyDeletes = new Set<string>();
    for (const op of pending) {
      const key = op.kind === 'upsert' ? `${op.collection}::${op.doc._id}` : `${op.collection}::${op.id}`;
      if (op.kind === 'upsert') dirtyUpserts.set(key, op.doc);
      else dirtyDeletes.add(key);
    }

    const remoteDocs = parseDocs(remoteFiles);
    const conflicts: any[] = [];

    // 以远端为底座重建镜像
    this.storage.importFiles(remoteFiles);

    // 重放本地 pending（与远端同 id 修改 → 本地胜出 + 记冲突，v0.1 简化合并，见 11 §6）
    for (const [key, doc] of dirtyUpserts) {
      const c = key.split('::')[0]!;
      const remoteDoc = remoteDocs.get(c)?.get(doc._id);
      if (remoteDoc && remoteDoc._rev !== doc._rev) {
        conflicts.push({ collection: c, id: doc._id, strategy: 'local-wins' });
      }
      const before = this.storage.read(c, doc._id);
      this.storage.upsert(c, doc);
      this.indexMgr.onWrite(c, before, doc);
    }
    for (const key of dirtyDeletes) {
      const [c, id] = key.split('::');
      const before = this.storage.read(c!, id!);
      if (before) {
        this.storage.delete(c!, id!);
        this.indexMgr.onWrite(c!, before, null);
      }
    }

    // schema / 索引随远端
    for (const [path, content] of remoteFiles) {
      const m = /^_schema\/(.+)\.schema\.jsonc$/.exec(path);
      if (m) {
        const schema = parseJsonc(content);
        this.storage.putSchema(m[1]!, schema);
        this.indexMgr.registerSchema(m[1]!, schema);
      }
    }
    for (const [c, m] of remoteDocs) this.indexMgr.rebuild(c, [...m.values()]);

    this.storage.setBaseline(remoteFiles);
    this.headOid = head;
    this.conflictCount += conflicts.length;
    this.lastSyncAt = new Date(this.runtime.now()).toISOString();
    this.bus.emit('sync:pull', { head, conflicts });
    this.bus.emit('remoteChange', { head });
  }

  // ---------- 生命周期 ----------

  /** 退出强制 flush（FR F3；sdk close 与 onExit 钩子调用） */
  async close(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }

  status(): SyncStatus {
    return {
      online: true,
      mode: this.mode,
      pendingOps: this.queue.size(),
      lastSyncAt: this.lastSyncAt,
      remoteHeadOid: this.headOid,
      conflicts: this.conflictCount
    };
  }

  // ---------- 内部 ----------

  private replay(ops: import('./queue.js').QueueOp[]): void {
    for (const op of ops) {
      if (op.kind === 'upsert') {
        const before = this.storage.read(op.collection, op.doc._id);
        this.storage.upsert(op.collection, op.doc);
        this.indexMgr.onWrite(op.collection, before, op.doc);
      } else {
        const before = this.storage.read(op.collection, op.id);
        if (before) {
          this.storage.delete(op.collection, op.id);
          this.indexMgr.onWrite(op.collection, before, null);
        }
      }
    }
  }

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.quota.track(1);
    try {
      return await fn();
    } catch (e) {
      if (isNetwork(e)) {
        this.mode = 'fully-local';
        this.bus.emit('mode', { mode: this.mode, cause: String(e) });
      }
      throw e;
    }
  }
}

function commitMessage(): string {
  return `gitlite sync ${new Date().toISOString()}`;
}

function checkFormatVersion(v: string, bus: EventBus): void {
  const repoMajor = Number(v.split('.')[0]);
  const clientMajor = Number(SYS.formatVersion.split('.')[0]);
  if (repoMajor > clientMajor) {
    throw new FormatVersionError(v, SYS.formatVersion);
  }
  if (v !== SYS.formatVersion) {
    bus.emit('format:warn', { repo: v, client: SYS.formatVersion, note: '0.x experimental, proceeding' });
  }
}

function isNetwork(e: unknown): boolean {
  return e instanceof Error && /fetch|network|ENOTFOUND|ECONNREFUSED|timeout/i.test(e.message);
}
