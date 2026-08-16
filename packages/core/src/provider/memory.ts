// GitProvider 接口 + MemoryProvider（测试/离线仿真）
// provider 是唯一网络出口（P1 §1 依赖规则）
import type { CreateRepoInput, FileChange, RepoInfo, RepoRef } from '../types.js';
import { ConflictError, NotFoundError } from '../errors.js';

export interface GitProvider {
  readonly id: string;
  /** 当前 token 对应的用户（initDB 自动识别 owner，模式 B） */
  getUser?(): Promise<{ login: string }>;
  getRepo(ref: RepoRef): Promise<RepoInfo | null>;
  createRepo(ref: RepoRef, input: CreateRepoInput): Promise<RepoInfo>;
  listBranches(ref: RepoRef): Promise<string[]>;
  createBranch(ref: RepoRef, name: string, from: string): Promise<void>;
  /** 删除分支（databases.drop）；分支不存在幂等 */
  deleteBranch?(ref: RepoRef, name: string): Promise<void>;
  /** @returns 分支 HEAD commit oid；分支不存在返回 null */
  getHead(ref: RepoRef, branch: string): Promise<string | null>;
  /** 全量文件快照；分支不存在返回 null */
  getFiles(ref: RepoRef, branch: string): Promise<Map<string, string> | null>;
  /** 增量拉取（P1c）：给定上次同步的远端树（path→blob sha），仅返回变更/新增文件 + 删除清单 + 新树。
   *  prevTree 为 null → 返回全量（files 即全量，deleted=[]，tree=全量）。
   *  @returns 分支不存在返回 null。 */
  getChangedFiles?(ref: RepoRef, branch: string, prevTree: Map<string, string> | null):
    Promise<ChangedFiles | null>;
  /** 原子提交全部变更；expectedHeadOid 不符抛 ConflictError（CAS，FR F6）。
   *  实现方应尽量返回提交后的全量树（path→blob sha），供 remoteTree 增量追踪（P1c）。 */
  commit(ref: RepoRef, branch: string, message: string,
         changes: FileChange[], expectedHeadOid?: string): Promise<{ oid: string; tree?: Map<string, string> }>;
}

/** 增量拉取结果（P1c）：files=变更/新增（path→content），deleted=远端删除清单，tree=远端新全树 */
export interface ChangedFiles {
  files: Map<string, string>;
  deleted: string[];
  tree: Map<string, string>;
}

/** 内存仓库仿真：用于全部单测/集成测试；CAS 语义与 GitHub 对齐 */
export class MemoryProvider implements GitProvider {
  readonly id = 'memory';
  private repos = new Map<string, { info: RepoInfo; branches: Map<string, { oid: string; files: Map<string, string> }> }>();
  private seq = 0;
  private login = 'memory-user';
  /** 测试观测：调用计数（配合 QuotaTracker/预算断言） */
  callCount = 0;

  setUser(login: string): void { this.login = login; }

  async getUser(): Promise<{ login: string }> {
    return { login: this.login };
  }

  private key(ref: RepoRef) { return `${ref.owner}/${ref.repo}`; }

  async getRepo(ref: RepoRef): Promise<RepoInfo | null> {
    this.callCount++;
    return this.repos.get(this.key(ref))?.info ?? null;
  }

  async createRepo(ref: RepoRef, input: CreateRepoInput): Promise<RepoInfo> {
    this.callCount++;
    const k = this.key(ref);
    if (this.repos.has(k)) throw new ConflictError(`repo exists: ${k}`);
    const info: RepoInfo = {
      ref, fullName: k, private: input.private ?? true,
      defaultBranch: 'main', size: 0
    };
    const files = new Map<string, string>();
    if (input.autoInit) files.set('README.md', `# ${ref.repo}\n`);
    this.repos.set(k, { info, branches: new Map([['main', { oid: this.nextOid(), files }]]) });
    return info;
  }

  async listBranches(ref: RepoRef): Promise<string[]> {
    this.callCount++;
    const r = this.repos.get(this.key(ref));
    if (!r) throw new NotFoundError(`repo ${this.key(ref)}`);
    return [...r.branches.keys()];
  }

  async createBranch(ref: RepoRef, name: string, from: string): Promise<void> {
    this.callCount++;
    const r = this.repos.get(this.key(ref));
    if (!r) throw new NotFoundError(`repo ${this.key(ref)}`);
    const base = r.branches.get(from);
    if (!base) throw new NotFoundError(`branch ${from}`);
    if (r.branches.has(name)) return; // 幂等
    r.branches.set(name, { oid: this.nextOid(), files: new Map(base.files) });
  }

  async deleteBranch(ref: RepoRef, name: string): Promise<void> {
    this.callCount++;
    const r = this.repos.get(this.key(ref));
    if (!r) return;
    r.branches.delete(name); // 幂等
  }

  async getHead(ref: RepoRef, branch: string): Promise<string | null> {
    this.callCount++;
    return this.repos.get(this.key(ref))?.branches.get(branch)?.oid ?? null;
  }

  async getFiles(ref: RepoRef, branch: string): Promise<Map<string, string> | null> {
    this.callCount++;
    const b = this.repos.get(this.key(ref))?.branches.get(branch);
    return b ? new Map(b.files) : null;
  }

  /** P1c 增量拉取：内容即「sha」；prevTree=null → 全量。分支不存在返回 null。 */
  async getChangedFiles(ref: RepoRef, branch: string, prevTree: Map<string, string> | null):
    Promise<{ files: Map<string, string>; deleted: string[]; tree: Map<string, string> } | null> {
    this.callCount++;
    const b = this.repos.get(this.key(ref))?.branches.get(branch);
    if (!b) return null;
    const files = new Map(b.files);
    const tree = new Map(files);
    if (prevTree === null) return { files, deleted: [], tree };
    const changed = new Map<string, string>();
    for (const [p, content] of files) {
      if (prevTree.get(p) !== content) changed.set(p, content); // 变更/新增
    }
    const deleted = [...prevTree.keys()].filter(p => !files.has(p));
    return { files: changed, deleted, tree };
  }

  async commit(ref: RepoRef, branch: string, _message: string,
               changes: FileChange[], expectedHeadOid?: string): Promise<{ oid: string; tree?: Map<string, string> }> {
    this.callCount++;
    const r = this.repos.get(this.key(ref));
    if (!r) throw new NotFoundError(`repo ${this.key(ref)}`);
    const b = r.branches.get(branch);
    if (!b) throw new NotFoundError(`branch ${branch}`);
    if (expectedHeadOid !== undefined && expectedHeadOid !== b.oid) {
      throw new ConflictError('non-fast-forward: remote head moved', {
        expected: expectedHeadOid, actual: b.oid
      });
    }
    for (const ch of changes) {
      if (ch.kind === 'put') b.files.set(ch.path, ch.content);
      else b.files.delete(ch.path);
    }
    b.oid = this.nextOid();
    return { oid: b.oid, tree: new Map(b.files) };
  }

  private nextOid(): string {
    return `mem${String(++this.seq).padStart(40, '0')}`;
  }
}
