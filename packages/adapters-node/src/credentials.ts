// 凭据存储（adapters-node）：
// - FileCredentialStore：0600 文件回退（v0.1 行为，win32/无 CLI 工具平台）
// - createOsCredentialStore：OS 钥匙串——darwin 走 `security` CLI、linux 走 `secret-tool`（docs/04）；
//   零原生依赖（不用 keytar）；工具缺失（ENOENT）自动粘性降级文件存储
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as nodeCrypto from 'node:crypto';
import type { CredentialAdapter } from '@gitlite/core';

const execFileP = promisify(execFile);

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], opts?: { stdin?: string }) => Promise<ExecResult>;

const defaultRunner: Runner = async (cmd, args, opts) => {
  if (opts?.stdin !== undefined) {
    return await new Promise<ExecResult>((resolve, reject) => {
      const p = spawn(cmd, args);
      let stdout = '', stderr = '';
      p.stdout.on('data', d => { stdout += d; });
      p.stderr.on('data', d => { stderr += d; });
      p.on('error', reject);                       // ENOENT：工具未安装
      p.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
      p.stdin.on('error', () => { });              // 工具提前退出时的 EPIPE
      p.stdin.end(opts.stdin);
    });
  }
  try {
    const { stdout, stderr } = await execFileP(cmd, args);
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new Error(`ENOENT: ${cmd}`);
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

/** 凭据文件：~/.gitlite/credentials/<hash>.tok（目录权限 0700）；内容为裸 token */
export class FileCredentialStore {
  constructor(private dir = '~/.gitlite/credentials') {}

  private file(key: string): string {
    const h = nodeCrypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
    return path.join(this.expandDir(), `${h}.tok`);
  }

  private expandDir(): string {
    return this.dir.startsWith('~/') ? path.join(os.homedir(), this.dir.slice(2)) : this.dir;
  }

  async set(key: string, value: string): Promise<void> {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.chmod(path.dirname(f), 0o700).catch(() => {});
    await fs.writeFile(f, value, { encoding: 'utf8', mode: 0o600 });
  }

  async get(key: string): Promise<string | null> {
    try { return await fs.readFile(this.file(key), 'utf8'); } catch { return null; }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}

const SERVICE = 'gitlite';
const DARWIN_NOT_FOUND = 44; // security find 的「不存在」退出码

/** OS 钥匙串凭据库：darwin=security CLI / linux=secret-tool / 其余=文件回退。
 *  CLI 工具缺失（ENOENT）→ 粘性降级文件存储（后续调用不再尝试 CLI）。
 *  runner/platform 可注入（测试与宿主覆盖）。 */
export function createOsCredentialStore(opts?: {
  runner?: Runner;
  platform?: NodeJS.Platform;
  fallbackDir?: string;
}): CredentialAdapter & { backend(): 'os' | 'file' } {
  const runner = opts?.runner ?? defaultRunner;
  const platform = opts?.platform ?? process.platform;
  const file = new FileCredentialStore(opts?.fallbackDir);
  const osBackend = platform === 'darwin' || platform === 'linux';
  let mode: 'os' | 'file' = osBackend ? 'os' : 'file';

  if (!osBackend) {
    return { set: (k, v) => file.set(k, v), get: k => file.get(k), delete: k => file.delete(k), backend: () => 'file' };
  }

  const runOrFallback = async (op: () => Promise<void>, fileOp: () => Promise<void>): Promise<void> => {
    if (mode === 'file') return fileOp();
    try {
      await op();
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('ENOENT')) {
        mode = 'file';
        await fileOp();
        return;
      }
      throw e;
    }
  };
  const getOrFallback = async (op: () => Promise<string | null>, fileOp: () => Promise<string | null>): Promise<string | null> => {
    if (mode === 'file') return fileOp();
    try {
      return await op();
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('ENOENT')) {
        mode = 'file';
        return fileOp();
      }
      throw e;
    }
  };

  if (platform === 'darwin') {
    return {
      set: (k, v) => runOrFallback(
        async () => { await exec('security', ['add-generic-password', '-a', k, '-s', SERVICE, '-w', v, '-U']); },
        () => file.set(k, v)),
      get: k => getOrFallback(async () => {
        const r = await exec('security', ['find-generic-password', '-a', k, '-s', SERVICE, '-w']);
        if (r.code === DARWIN_NOT_FOUND) return null;
        if (r.code !== 0) throw new Error(`security find failed (${r.code}): ${r.stderr.slice(0, 120)}`);
        return r.stdout.trim();
      }, () => file.get(k)),
      delete: k => runOrFallback(async () => {
        const r = await exec('security', ['delete-generic-password', '-a', k, '-s', SERVICE]);
        if (r.code !== 0 && r.code !== DARWIN_NOT_FOUND) {
          throw new Error(`security delete failed (${r.code}): ${r.stderr.slice(0, 120)}`);
        }
      }, () => file.delete(k)),
      backend: () => mode
    };
  }

  // linux: secret-tool（store 从 stdin 读密文，避免 argv 泄露进程列表）
  return {
    set: (k, v) => runOrFallback(
      async () => { await exec('secret-tool', ['store', '--label=GitLite', 'service', SERVICE, 'account', k], { stdin: v }); },
      () => file.set(k, v)),
    get: k => getOrFallback(async () => {
      const r = await exec('secret-tool', ['lookup', 'service', SERVICE, 'account', k]);
      if (r.code !== 0) throw new Error(`secret-tool lookup failed (${r.code}): ${r.stderr.slice(0, 120)}`);
      return r.stdout === '' ? null : r.stdout;
    }, () => file.get(k)),
    delete: k => runOrFallback(
      async () => { await exec('secret-tool', ['clear', 'service', SERVICE, 'account', k]); },
      () => file.delete(k)),
    backend: () => mode
  };

  async function exec(cmd: string, args: string[], opts?: { stdin?: string }): Promise<ExecResult> {
    return runner(cmd, args, opts);
  }
}
