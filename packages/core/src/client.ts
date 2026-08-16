// GitLiteClient：连接编排（A1~A5）+ 组装各引擎；core 顶层门面（sdk 在此之上加 URI/initDB/auth）
import { ForeignRepoError, NotFoundError } from './errors.js';
import { EventBus } from './event.js';
import { IndexManager } from './index/manager.js';
import { Ulid } from './model/ulid.js';
import type { GitProvider } from './provider/memory.js';
import { Collection, type CollectionDeps } from './query/collection.js';
import type { RuntimeAdapter } from './runtime.js';
import { StorageEngine } from './storage/engine.js';
import { SyncEngine } from './sync/engine.js';
import { CommitQueue } from './sync/queue.js';
import { TransactionManager } from './tx/transaction.js';
import { QuotaTracker } from './quota/tracker.js';
import { SYS, type CreateRepoInput, type RepoRef, type SyncPolicy } from './types.js';

/** 连接流程步骤（initDB 向导 UI 依据这些事件渲染进度） */
export type ConnectStep =
  | 'probe-repo' | 'create-repo'
  | 'probe-branch' | 'create-branch'
  | 'check-repo' | 'startup' | 'ready';

export interface ConnectOptions {
  provider: GitProvider;
  runtime: RuntimeAdapter;
  ref: RepoRef;
  /** database 名 → 分支 gitlite/<database>；缺省 = 仓库模式（整仓即库，分支=默认分支） */
  database?: string;
  policy?: SyncPolicy;
  queuePath?: string;
  /** foreign 仓库显式确认（FR A4） */
  allowForeignRepo?: boolean;
  /** 字段级加密 passphrase（ADR-003）：提供则启用该库加密；缺省尝试凭据库缓存，未配置则明文（兼容） */
  passphrase?: string;
  /** 索引后端（P4，docs/14）：'memory'（默认，行为不变）/ 'sqlite'（本地分页缓存，
   *  需 runtime.sqlite；缓存位于 ~/.gitlite/cache/<连接指纹>/index.db，可随时删除重建） */
  indexBackend?: 'memory' | 'sqlite';
  /** 进度回调（向导 UI 双通道：内置 UI 与自建页面共用） */
  onProgress?: (step: ConnectStep, detail?: any) => void;
}

export class GitLiteClient {
  readonly bus = new EventBus();
  readonly storage = new StorageEngine();
  readonly indexMgr: IndexManager;
  readonly sync: SyncEngine;
  private queue: CommitQueue;
  private txMgr: TransactionManager;
  private foreignReadOnly = false;
  private closed = false;

  private constructor(
    readonly provider: GitProvider,
    readonly ref: RepoRef,
    readonly branch: string,
    private runtime: RuntimeAdapter,
    private policy: SyncPolicy,
    indexMgr: IndexManager
  ) {
    this.indexMgr = indexMgr;
    const hash = connHash(provider.id, ref, branch);
    this.queue = new CommitQueue(runtime.fs, `~/.gitlite/queues/${hash}.json`); // adapters-node 展开 ~
    this.sync = new SyncEngine(provider, ref, branch, this.storage, this.indexMgr,
      this.queue, policy, new QuotaTracker(policy.maxRemoteCallsPerHour), this.bus, runtime);
    this.txMgr = new TransactionManager(
      () => this.collectionDeps(), this.storage, this.indexMgr, this.queue, this.bus,
      () => this.sync.flush()
    );
    // 索引文件随数据同一 commit（FR H3）；脏集合过滤（P1b）
    this.storage.setIndexFilesProvider((cols) => this.indexMgr.exportFiles(cols));
  }

  /** 连接编排（11 §3.1）：repo → branch → 探测/建 → 检查 → import → startup */
  static async create(opts: ConnectOptions): Promise<GitLiteClient> {
    const p = opts.onProgress;
    const branch = opts.database ? `${SYS.dbBranchPrefix}${opts.database}` : 'main';
    const policy = opts.policy ?? { timeWindowMs: 600_000, batchSize: 100, maxRetries: 3, maxRemoteCallsPerHour: 60 };

    // repo 存在性（A3）
    p?.('probe-repo', { ref: opts.ref });
    let repo = await opts.provider.getRepo(opts.ref);
    if (!repo) {
      p?.('create-repo', { ref: opts.ref });
      const input: CreateRepoInput = { private: true, autoInit: true, description: 'GitLite database' };
      repo = await opts.provider.createRepo(opts.ref, input);
    }

    // 分支存在性（A2/A3）
    p?.('probe-branch', { branch });
    let head = await opts.provider.getHead(opts.ref, branch);
    if (head === null) {
      const base = await opts.provider.getHead(opts.ref, repo.defaultBranch) !== null
        ? repo.defaultBranch : 'main';
      p?.('create-branch', { branch, base });
      await opts.provider.createBranch(opts.ref, branch, base);
      head = null;
    }

    // P4：本地 SQLite 索引后端（可选；默认 memory 与 v0.2 前行为一致）
    let mgr = new IndexManager();
    if (opts.indexBackend === 'sqlite') {
      const factory = opts.runtime.sqlite;
      if (!factory) {
        throw new Error('indexBackend "sqlite" requires runtime.sqlite (synchronous SQLite adapter; adapters-node provides createNodeSqlite() via node:sqlite)');
      }
      const dir = `~/.gitlite/cache/${connHash(opts.provider.id, opts.ref, branch)}`;
      await opts.runtime.fs.mkdir(dir);
      mgr = IndexManager.openSqlite(factory.open(`${dir}/index.db`));
    }

    const client = new GitLiteClient(opts.provider, opts.ref, branch, opts.runtime, policy, mgr);

    // 字段级加密（ADR-003）：显式 passphrase 优先；否则尝试凭据库缓存；都无 → 明文（兼容）
    const encKey = encCredKey(opts.provider.id, opts.ref.owner, opts.ref.repo, branch);
    let passphrase = opts.passphrase ?? await opts.runtime.credential.get(encKey).catch(() => null) ?? undefined;
    if (opts.passphrase) {
      await opts.runtime.credential.set(encKey, opts.passphrase).catch(() => undefined); // 缓存免二次输入
    }
    client.sync.setPassphrase(passphrase);

    p?.('check-repo');
    const files = await opts.provider.getFiles(opts.ref, branch);
    const isGitLite = files?.has(SYS.configPath) ?? false;
    const nonEmpty = files !== null && [...files.keys()].some(p => p !== 'README.md');

    if (nonEmpty && !isGitLite && !opts.allowForeignRepo) {
      throw new ForeignRepoError([...files!.keys()].slice(0, 100));
    }
    // 确认后可写（警告页「继续初始化」语义：只添加 _ 系统文件，永不删除用户文件——diff 已保证）

    p?.('startup', { bootstrap: !isGitLite });
    await client.sync.startup(files ?? new Map());
    p?.('ready', { branch, database: opts.database ?? null });
    return client;
  }

  collection<T = any>(name: string): Collection<T> {
    this.assertOpen();
    return new Collection<T>(name, this.collectionDeps());
  }

  async transaction<T>(fn: (tx: TransactionManager) => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.foreignReadOnly) throw new Error('read-only client (foreign repo)');
    return this.txMgr.run(fn);
  }

  async putSchema(name: string, schema: object): Promise<void> {
    this.assertOpen();
    if (this.foreignReadOnly) throw new Error('read-only client (foreign repo)');
    this.storage.putSchema(name, schema);
    this.indexMgr.registerSchema(name, schema);
    this.indexMgr.rebuild(name, this.storage.scan(name));
    this.sync.schedule(); // 走统一调度（H3）；不做 void flush——避免与随后的写竞态被吞
  }

  on(event: string, fn: (e: any) => void): () => void {
    return this.bus.on(event, fn);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sync.close(); // F3 退出强制 flush
    this.indexMgr.close();  // P4：SQLite 后端关库（WAL 落盘）
  }

  syncStatus() { return this.sync.status(); }

  private collectionDeps(): CollectionDeps {
    return {
      storage: this.storage,
      indexMgr: this.indexMgr,
      queue: this.queue,
      crypto: this.runtime.crypto,
      ulid: new Ulid(this.runtime.crypto),
      bus: this.bus,
      schedule: () => this.sync.schedule(),
      flushNow: () => this.sync.flush(),
      pullNow: () => this.sync.pull(),
      readOnly: () => this.foreignReadOnly
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('client closed');
  }
}

/** 加密 passphrase 的凭据库键（ADR-003：按 provider/仓库/分支隔离） */
function encCredKey(providerId: string, owner: string, repo: string, branch: string): string {
  return `gitlite:enc:${providerId}:${owner}/${repo}:${branch}`;
}

/** 连接指纹（队列 / 索引缓存目录共用）：provider-owner-repo-branch → 文件系统安全 */
function connHash(providerId: string, ref: RepoRef, branch: string): string {
  return `${providerId}-${ref.owner}-${ref.repo}-${branch}`.replace(/[^a-z0-9.-]/gi, '_');
}
