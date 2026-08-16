// 同步引擎：economy 低频 flush / 强制启动退出 / 离线重放 / CAS 冲突重试 / pull 合并
//（FR F2~F8，ADR-001）
import { ConflictError, FormatVersionError, QuotaExceededError } from '../errors.js';
import type { EventBus } from '../event.js';
import type { GitProvider } from '../provider/memory.js';
import type { RuntimeAdapter } from '../runtime.js';
import { parseJsonc } from '../schema/jsonc.js';
import { parseDocs, StorageEngine, dataFileOwner } from '../storage/engine.js';
import type { IndexManager } from '../index/manager.js';
import type { QuotaTracker } from '../quota/tracker.js';
import { SYS, type RepoRef, type SyncPolicy, type SyncStatus, type Document } from '../types.js';
import type { FileChange } from '../types.js';
import type { CommitQueue } from './queue.js';
import { FieldCipher, encryptDoc, decryptDoc } from '../crypto/cipher.js';

const COMMIT_CALL_COST = 4; // Git DB API 四步的预算估计（K2）

export class SyncEngine {
  private headOid: string | null = null;
  /** 上次同步的远端树（path→blob sha），P1c 增量 pull 的比对基准；null = 会话内未同步过 */
  private remoteTree: Map<string, string> | null = null;
  /** 字段级加密器（ADR-003）；null = 不加密（向后兼容）。只在 commit/pull 边界生效。 */
  private cipher: FieldCipher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private lastSyncAt: string | null = null;
  private mode: 'normal' | 'fully-local' = 'normal';
  private conflictCount = 0;

  /** 设置字段加密 passphrase（ADR-003）；null/空 = 关闭加密（兼容无加密库） */
  setPassphrase(p: string | null | undefined): void {
    this.cipher = p ? new FieldCipher(p) : null;
  }

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
      files = await this.decryptFiles(files);   // ADR-003：远端密文 → 明文镜像
      this.storage.importFiles(files);
      this.indexMgr.importFiles(files);
      // 初始树（path→content）：P1c 增量 pull 的比对基准；首次 flush 后 commit 返回真实树
      this.remoteTree = new Map(files);
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
        const committed = new Set(this.storage.dirtyCollections()); // diff 的脏集快照（同步相邻，无竞态）
        const plain = this.storage.diff();           // diff 在明文上（diff 稳定，P1b）
        if (plain.length === 0) {
          this.storage.clearDirty(); // 有脏但内容与基线一致 → 清脏，避免悬挂
          await this.queue.clear();
          return;
        }
        if (!this.quota.canSpend(COMMIT_CALL_COST)) {
          this.bus.emit('quota:warning', this.quota.status());
          throw new QuotaExceededError(60_000); // 保留队列，等下个窗口
        }
        try {
          const changes = await this.encryptChanges(plain); // ADR-003：commit 前加密
          const { oid, tree } = await this.track(() =>
            this.provider.commit(this.ref, this.branch, commitMessage(), changes, this.headOid ?? undefined));
          this.headOid = oid;
          if (tree) this.remoteTree = tree; // P1c：提交后的真实树，作下次增量 pull 基准
          this.storage.markSynced(plain, committed); // 基线=远端状态（明文），只清已提交集合脏标记
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

    // 远端全量（重构：有增量能力且已有树 → 基线 + 增量；否则全量拉取）
    let remoteFiles: Map<string, string> | null;
    if (this.provider.getChangedFiles) {
      const res = await this.track(() =>
        this.provider.getChangedFiles!(this.ref, this.branch, this.remoteTree));
      if (!res) return;
      remoteFiles = this.remoteTree === null
        ? new Map(res.files)                                // 会话首拉：返回即全量
        : applyRemoteDelta(this.storage.getBaseline(), res); // 基线 + 远端增量 = 远端全量
      this.remoteTree = res.tree;
    } else {
      remoteFiles = await this.track(() => this.provider.getFiles(this.ref, this.branch));
      if (!remoteFiles) return;
    }
    remoteFiles = await this.decryptFiles(remoteFiles); // ADR-003：远端密文 → 明文镜像/基线

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

  // ---------- 字段级加密（ADR-003）：仅 commit/pull 边界，diff/基线/镜像全明文 ----------

  /** commit 前：对变更中的数据文件按 schema 加密（远端只存密文；diff 稳定不受随机 IV 影响） */
  private async encryptChanges(plain: FileChange[]): Promise<FileChange[]> {
    if (!this.cipher) return plain;
    const out: FileChange[] = [];
    for (const ch of plain) {
      if (ch.kind === 'delete') { out.push(ch); continue; }
      const owner = dataFileOwner(ch.path);
      if (owner === null) { out.push(ch); continue; }            // 系统/schema/索引文件不加密
      const fields = this.storage.encryptedFields(owner);
      if (!fields.length) { out.push(ch); continue; }            // 该表无加密字段
      out.push({ kind: 'put', path: ch.path, content: await this.transformFile(ch.content, ch.path, fields, 'enc') });
    }
    return out;
  }

  /** pull/启动：远端文件解密为明文（幂等：非密文原样保留）。
   *  注意：此时 importFiles 尚未加载 schema → 加密字段映射从文件集内 `_schema/` 自行解析。 */
  private async decryptFiles(files: Map<string, string>): Promise<Map<string, string>> {
    if (!this.cipher) return files;
    const encFields = new Map<string, string[]>();
    for (const [path, content] of files) {
      const m = /^_schema\/(.+)\.schema\.jsonc$/.exec(path);
      if (!m) continue;
      const schema = parseJsonc(content) as any;
      const fields = Object.entries<any>(schema?.properties ?? {})
        .filter(([, v]) => v?.['x-gitlite-encrypted'])
        .map(([k]) => k);
      if (fields.length) encFields.set(m[1]!, fields);
    }
    if (!encFields.size) return files;
    const out = new Map<string, string>();
    for (const [path, content] of files) {
      const owner = dataFileOwner(path);
      const fields = owner === null ? undefined : encFields.get(owner);
      out.set(path, fields?.length ? await this.transformFile(content, path, fields, 'dec') : content);
    }
    return out;
  }

  /** 文件级字段变换：L0/L2 JSONL 逐行 / L1 单 JSON 文件 */
  private async transformFile(content: string, path: string, fields: string[], mode: 'enc' | 'dec'): Promise<string> {
    const t = mode === 'enc' ? encryptDoc : decryptDoc;
    if (path.endsWith('.jsonl')) {
      const lines = content.split('\n');
      const out: string[] = [];
      for (const line of lines) {
        if (!line.trim()) { out.push(line); continue; }
        out.push(JSON.stringify(await t(JSON.parse(line) as Document, fields, this.cipher!)));
      }
      return out.join('\n');
    }
    const doc = JSON.parse(content) as Document;
    return JSON.stringify(await t(doc, fields, this.cipher!), null, 2);
  }
}

function commitMessage(): string {
  return `gitlite sync ${new Date().toISOString()}`;
}

/** P1c：基线（上次同步的远端全量）+ 远端增量 → 远端当前全量 */
function applyRemoteDelta(base: Map<string, string>,
                          res: { files: Map<string, string>; deleted: string[] }): Map<string, string> {
  const out = new Map(base);
  for (const p of res.deleted) out.delete(p);
  for (const [p, c] of res.files) out.set(p, c);
  return out;
}

function checkFormatVersion(v: string, bus: EventBus): void {
  const repoMajor = Number(v.split('.')[0]);
  const clientMajor = Number(SYS.formatVersion.split('.')[0]);
  if (repoMajor > clientMajor) {
    throw new FormatVersionError(v, SYS.formatVersion);
  }
  if (v !== SYS.formatVersion) {
    // 1.0.0 冻结后的读旧策略：0.x 仓库是 1.0.0 的子集（additive-only），告警一次后继续
    bus.emit('format:warn', {
      repo: v, client: SYS.formatVersion,
      note: `repo written by older format ${v}; additive-only guarantees read compatibility, proceeding`
    });
  }
}

function isNetwork(e: unknown): boolean {
  return e instanceof Error && /fetch|network|ENOTFOUND|ECONNREFUSED|timeout/i.test(e.message);
}
