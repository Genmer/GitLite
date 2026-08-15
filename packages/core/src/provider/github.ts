// GitHubProvider：REST v3 + Git DB API（blobs→trees→commits→refs 四步原子 commit，CAS ref 更新）
// fetch 经构造注入（I4：core 零 node 依赖）；HTTP 错误统一映射进错误模型（B5）
import {
  AuthError, ConflictError, NetworkError, NotFoundError, RateLimitError
} from '../errors.js';
import type {
  CreateRepoInput, FileChange, RepoInfo, RepoRef
} from '../types.js';
import type { GitProvider } from './memory.js';

const API = 'https://api.github.com';

export class GitHubProvider implements GitProvider {
  readonly id = 'github';

  constructor(private token: string, private doFetch: typeof fetch = fetch) {}

  private async req<T>(method: string, path: string, body?: any): Promise<{ status: number; data: T | null }> {
    let res: Response;
    try {
      res = await this.doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'gitlite/0.1'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new NetworkError(`github api unreachable: ${String(e)}`);
    }
    if (res.status === 204) return { status: 204, data: null };
    const data = (await res.json().catch(() => null)) as T | null;
    if (res.status === 401) throw new AuthError('github token invalid or expired');
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
        throw new RateLimitError(Math.max(reset - Date.now(), 1000));
      }
      throw new AuthError(`github 403: ${JSON.stringify(data)?.slice(0, 200)}`);
    }
    if (res.status === 422) {
      throw new ConflictError(`github 422 on ${method} ${path}`);
    }
    if (res.status >= 500) throw new NetworkError(`github ${res.status} on ${method} ${path}`);
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
      ref, fullName: data.full_name, private: !!data.private,
      defaultBranch: data.default_branch ?? 'main', size: data.size ?? 0
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
      ref, fullName: data.full_name, private: !!data.private,
      defaultBranch: data.default_branch ?? 'main', size: 0
    };
  }

  async listBranches(ref: RepoRef): Promise<string[]> {
    const { data } = await this.req<any[]>('GET',
      `/repos/${ref.owner}/${ref.repo}/branches?per_page=100`);
    return (data ?? []).map(b => b.name);
  }

  async getHead(ref: RepoRef, branch: string): Promise<string | null> {
    const { status, data } = await this.req<any>('GET',
      `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (status === 404 || !data) return null;
    return data.object?.sha ?? null;
  }

  async createBranch(ref: RepoRef, name: string, from: string): Promise<void> {
    const baseSha = await this.getHead(ref, from);
    if (!baseSha) throw new NotFoundError(`base branch ${from}`);
    try {
      await this.req('POST', `/repos/${ref.owner}/${ref.repo}/git/refs`, {
        ref: `refs/heads/${name}`, sha: baseSha
      });
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotFoundError) return; // 已存在（幂等）
      throw e;
    }
  }

  async getFiles(ref: RepoRef, branch: string): Promise<Map<string, string> | null> {
    const { status, data } = await this.req<any>('GET',
      `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (status === 404 || !data) return null;
    const out = new Map<string, string>();
    for (const entry of data.tree ?? []) {
      if (entry.type !== 'blob') continue;
      const blob = await this.req<any>('GET',
        `/repos/${ref.owner}/${ref.repo}/git/blobs/${entry.sha}`);
      out.set(entry.path, decodeBlob(blob?.data?.content ?? '', blob?.data?.encoding ?? 'base64'));
    }
    return out;
  }

  async commit(ref: RepoRef, branch: string, message: string,
               changes: FileChange[], expectedHeadOid?: string): Promise<{ oid: string }> {
    const base = `/repos/${ref.owner}/${ref.repo}`;

    // 1. base commit / tree
    let parentSha = expectedHeadOid ?? await this.getHead(ref, branch);
    if (!parentSha) throw new NotFoundError(`branch ${branch}`);
    const headCommit = await this.req<any>('GET', `${base}/git/commits/${parentSha}`);
    const baseTree = headCommit.data?.tree?.sha;

    // 2. blobs
    const treeItems: any[] = [];
    for (const ch of changes) {
      if (ch.kind === 'put') {
        const blob = await this.req<any>('POST', `${base}/git/blobs`, {
          content: ch.content, encoding: 'utf-8'
        });
        treeItems.push({ path: ch.path, mode: '100644', type: 'blob', sha: blob.data?.sha });
      } else {
        treeItems.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
      }
    }

    // 3. tree（base_tree 复用未变部分）
    const tree = await this.req<any>('POST', `${base}/git/trees`, {
      base_tree: baseTree, tree: treeItems
    });

    // 4. commit + 5. ref 更新（CAS：expected sha 不符 → 422 → ConflictError）
    const commit = await this.req<any>('POST', `${base}/git/commits`, {
      message, tree: tree.data?.sha, parents: [parentSha]
    });
    try {
      await this.req('PATCH', `${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha: commit.data?.sha, force: false
      });
    } catch (e) {
      if (e instanceof ConflictError) {
        throw new ConflictError('non-fast-forward: remote head moved', { expected: parentSha });
      }
      throw e;
    }
    return { oid: commit.data?.sha };
  }
}

function decodeBlob(content: string, encoding: string): string {
  if (encoding !== 'base64') return content;
  const bin = atob(content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
