// GiteeProvider：API v5 + Contents 降级提交（docs/02 §2.2 关键不对称：无 Git DB 低层 API）。
// - 批量 commit = 逐文件 contents 调用（POST 创建 / PUT 更新按 sha 区分），**非原子**（中途失败幂等重试）
// - CAS = 提交前 getHead 预检（expectedHeadOid 不符即 ConflictError），尽力缩小竞态窗口
// - 树/增量 pull：无 trees API → 目录递归列表（每目录 1 调用）得 path→sha，仅拉变更文件内容
// - 认证 Bearer 头（fetch 注入，I4：core 零 node 依赖）；错误映射与 GitHubProvider 对齐（B5）
import {
  AuthError, ConflictError, NetworkError, NotFoundError, RateLimitError
} from '../errors.js';
import type {
  CreateRepoInput, FileChange, RepoInfo, RepoRef
} from '../types.js';
import type { ChangedFiles, GitProvider } from './memory.js';
import { rateLimitBackoffMs } from './rate-limit.js';

const API = 'https://gitee.com/api/v5';

export class GiteeProvider implements GitProvider {
  readonly id = 'gitee';

  constructor(private token: string, private doFetch: typeof fetch = fetch) {}

  private async req<T>(method: string, path: string, body?: any): Promise<{ status: number; data: T | null }> {
    let res: Response;
    try {
      res = await this.doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'gitlite/0.1'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new NetworkError(`gitee api unreachable: ${String(e)}`);
    }
    if (res.status === 204) return { status: 204, data: null };
    const data = (await res.json().catch(() => null)) as T | null;
    if (res.status === 401) throw new AuthError('gitee token invalid or expired');
    // 限流精确解析：429（Retry-After）；403 仅在可识别限流头时报 RateLimit，否则按权限错误（AuthError）
    if (res.status === 429) {
      throw new RateLimitError(rateLimitBackoffMs(res.headers) ?? 60_000);
    }
    if (res.status === 403) {
      const backoff = rateLimitBackoffMs(res.headers);
      if (backoff !== null) throw new RateLimitError(backoff);
      throw new AuthError(`gitee 403: ${JSON.stringify(data)?.slice(0, 200)}`);
    }
    if (res.status === 409 || res.status === 422) {
      throw new ConflictError(`gitee ${res.status} on ${method} ${path}`);
    }
    if (res.status >= 500) throw new NetworkError(`gitee ${res.status} on ${method} ${path}`);
    return { status: res.status, data };
  }

  async getUser(): Promise<{ login: string }> {
    const { data } = await this.req<any>('GET', '/user');
    if (!data?.login) throw new AuthError('cannot resolve authenticated user');
    return { login: data.login };
  }

  async getRepo(ref: RepoRef): Promise<RepoInfo | null> {
    const { status, data } = await this.req<any>('GET', `/repos/${ref.owner}/${ref.repo}`);
    if (status === 404 || !data) return null;
    return {
      ref, fullName: data.full_name ?? `${ref.owner}/${ref.repo}`, private: !!data.private,
      defaultBranch: data.default_branch ?? 'master', size: 0
    };
  }

  async createRepo(ref: RepoRef, input: CreateRepoInput): Promise<RepoInfo> {
    const { data } = await this.req<any>('POST', '/user/repos', {
      name: ref.repo,
      description: input.description ?? 'GitLite database',
      private: input.private ?? true,
      auto_init: input.autoInit ?? true
    });
    return {
      ref, fullName: data?.full_name ?? `${ref.owner}/${ref.repo}`, private: input.private ?? true,
      defaultBranch: data?.default_branch ?? 'master', size: 0
    };
  }

  async listBranches(ref: RepoRef): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; ; page++) {           // Gitee 分页：page 参数，默认 20/页
      const { data } = await this.req<any[]>('GET',
        `/repos/${ref.owner}/${ref.repo}/branches?page=${page}&per_page=100`);
      const batch = data ?? [];
      out.push(...batch.map(b => b.name));
      if (batch.length < 100) return out;
    }
  }

  async deleteBranch(ref: RepoRef, name: string): Promise<void> {
    // DELETE /branches/{name}；404 = 不存在（幂等）
    await this.req('DELETE', `/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(name)}`);
  }

  async getHead(ref: RepoRef, branch: string): Promise<string | null> {
    const { status, data } = await this.req<any>('GET',
      `/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(branch)}`);
    if (status === 404 || !data) return null;
    return data.commit?.sha ?? null;
  }

  async createBranch(ref: RepoRef, name: string, from: string): Promise<void> {
    // Gitee 建分支按源分支名（refs），非 sha；已存在 → 400/409 → 幂等通过
    try {
      await this.req('POST', `/repos/${ref.owner}/${ref.repo}/branches`, {
        branch_name: name, refs: from
      });
    } catch (e) {
      if (e instanceof ConflictError) return;
      if (e instanceof NetworkError && /gitee 4(0[09])/i.test(e.message ?? '')) return;
      throw e;
    }
  }

  async getFiles(ref: RepoRef, branch: string): Promise<Map<string, string> | null> {
    const tree = await this.listTree(ref, branch);
    if (tree === null) return null;
    const out = new Map<string, string>();
    for (const [path, sha] of tree) {
      out.set(path, await this.readFile(ref, branch, path, sha));
    }
    return out;
  }

  /** 目录递归列表 → path→blob sha（每目录 1 调用；无 trees API 的 Gitee 税）。
   *  分支不存在返回 null。 */
  private async listTree(ref: RepoRef, branch: string): Promise<Map<string, string> | null> {
    const root = await this.listDir(ref, branch, '');
    if (root === null) return null;
    const tree = new Map<string, string>();
    const dirs: string[] = [''];
    while (dirs.length) {
      const dir = dirs.shift()!;
      const entries = dir === '' ? root : await this.listDir(ref, branch, dir);
      if (entries === null) continue;      // 目录在遍历中被并发删除（竞态）→ 跳过
      for (const e of entries) {
        if (e.type === 'dir') dirs.push(e.path);
        else if (e.type === 'file') tree.set(e.path, e.sha);
      }
    }
    return tree;
  }

  /** 单层目录列表；分支/目录不存在返回 null（上层判定） */
  private async listDir(ref: RepoRef, branch: string, dir: string):
    Promise<Array<{ path: string; type: string; sha: string }> | null> {
    const p = dir ? `/${dir}` : '';
    const { status, data } = await this.req<any>(
      'GET', `/repos/${ref.owner}/${ref.repo}/contents${p}?ref=${encodeURIComponent(branch)}`);
    if (status === 404) return null;
    if (!Array.isArray(data)) return [];   // 单文件响应（空仓库根路径边缘）→ 视作空目录
    return data.map((e: any) => ({ path: e.path as string, type: e.type as string, sha: e.sha as string }));
  }

  private async readFile(ref: RepoRef, branch: string, path: string, sha?: string): Promise<string> {
    const { status, data } = await this.req<any>(
      'GET', `/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    if (status !== 200 || !data?.content) {
      throw new NotFoundError(`gitee file ${path}@${branch} (sha ${sha ?? '?'})`);
    }
    return decodeBase64(data.content, data.encoding ?? 'base64');
  }

  /** 增量拉取（P1c 对位，Gitee 形态）：目录列表得新树 → 与 prevTree 比对 → 仅拉变更文件内容。
   *  prevTree=null → 全量。分支不存在返回 null。 */
  async getChangedFiles(ref: RepoRef, branch: string, prevTree: Map<string, string> | null):
    Promise<ChangedFiles | null> {
    const tree = await this.listTree(ref, branch);
    if (tree === null) return null;
    const want = [...tree.entries()]
      .filter(([p, sha]) => prevTree === null || prevTree.get(p) !== sha)
      .map(([p]) => p);
    const deleted = prevTree === null ? [] : [...prevTree.keys()].filter(p => !tree.has(p));
    const files = new Map<string, string>();
    for (const p of want) files.set(p, await this.readFile(ref, branch, p, tree.get(p)));
    return { files, deleted, tree };
  }

  /** 降级提交（docs/02 §2.2）：逐文件 contents 调用，每文件一个 commit，非原子。
   *  CAS：expectedHeadOid 与当前 head 预检不符 → ConflictError（缩小而非消除竞态窗口）。 */
  async commit(ref: RepoRef, branch: string, message: string,
               changes: FileChange[], expectedHeadOid?: string): Promise<{ oid: string; tree?: Map<string, string> }> {
    if (!changes.length) throw new Error('gitee commit: empty changes');
    for (const ch of changes) {
      if (!/\.[^/]+$/.test(ch.path)) {
        throw new Error(`gitee contents api requires file extension: ${ch.path} (docs/02)`);
      }
    }
    const head = await this.getHead(ref, branch);
    if (head === null) throw new NotFoundError(`branch ${branch}`);
    if (expectedHeadOid !== undefined && head !== expectedHeadOid) {
      throw new ConflictError('non-fast-forward: remote head moved', { expected: expectedHeadOid, actual: head });
    }

    let lastSha = head;
    for (const [i, ch] of changes.entries()) {
      const msg = changes.length > 1 ? `${message} (${i + 1}/${changes.length})` : message;
      if (ch.kind === 'put') {
        const existing = await this.existingSha(ref, branch, ch.path);
        const { data } = existing
          ? await this.req<any>('PUT', `/repos/${ref.owner}/${ref.repo}/contents/${ch.path}`, {
            content: encodeBase64(ch.content), sha: existing, message: msg, branch
          })
          : await this.req<any>('POST', `/repos/${ref.owner}/${ref.repo}/contents/${ch.path}`, {
            content: encodeBase64(ch.content), message: msg, branch
          });
        lastSha = data?.commit?.sha ?? lastSha;
      } else {
        const existing = await this.existingSha(ref, branch, ch.path);
        if (existing === null) continue;    // 已不存在（幂等删除）
        const { data } = await this.req<any>(
          'DELETE', `/repos/${ref.owner}/${ref.repo}/contents/${ch.path}`, {
            sha: existing, message: msg, branch
          });
        lastSha = data?.commit?.sha ?? lastSha;
      }
    }
    // 提交后目录列表一遍 → 全量树（供 SyncEngine remoteTree 增量追踪，P1c）
    const tree = await this.listTree(ref, branch);
    return { oid: lastSha, tree: tree ?? undefined };
  }

  private async existingSha(ref: RepoRef, branch: string, path: string): Promise<string | null> {
    const { status, data } = await this.req<any>(
      'GET', `/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    if (status === 404 || !data) return null;
    return data.sha ?? null;
  }
}

function decodeBase64(content: string, encoding: string): string {
  if (encoding !== 'base64') return content;
  const bin = atob(content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** UTF-8 安全 base64（btoa 直接编码多字节字符会抛错；TextEncoder/TextDecoder 为跨运行时全局） */
function encodeBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
