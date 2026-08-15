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
  /** @returns 分支 HEAD commit oid；分支不存在返回 null */
  getHead(ref: RepoRef, branch: string): Promise<string | null>;
  /** 全量文件快照；分支不存在返回 null */
  getFiles(ref: RepoRef, branch: string): Promise<Map<string, string> | null>;
  /** 原子提交全部变更；expectedHeadOid 不符抛 ConflictError（CAS，FR F6） */
  commit(ref: RepoRef, branch: string, message: string,
         changes: FileChange[], expectedHeadOid?: string): Promise<{ oid: string }>;
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

  async getHead(ref: RepoRef, branch: string): Promise<string | null> {
    this.callCount++;
    return this.repos.get(this.key(ref))?.branches.get(branch)?.oid ?? null;
  }

  async getFiles(ref: RepoRef, branch: string): Promise<Map<string, string> | null> {
    this.callCount++;
    const b = this.repos.get(this.key(ref))?.branches.get(branch);
    return b ? new Map(b.files) : null;
  }

  async commit(ref: RepoRef, branch: string, _message: string,
               changes: FileChange[], expectedHeadOid?: string): Promise<{ oid: string }> {
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
    return { oid: b.oid };
  }

  private nextOid(): string {
    return `mem${String(++this.seq).padStart(40, '0')}`;
  }
}
