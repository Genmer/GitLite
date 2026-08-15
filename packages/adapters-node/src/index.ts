// Node.js 运行时适配（FR I4）：fs（~ 展开）/ crypto / 凭据文件 / fetch / 退出钩子
// 注意：credential 为 v0.1 文件级 fallback（0600 目录 + 逐 token 加密文件头标注），
// OS keychain（keytar/safeStorage）在 v0.2 接入，见 12 复核 B3。
import * as fs from 'node:fs/promises';
import * as nodeCrypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import type { RuntimeAdapter } from '@gitlite/core';

function expand(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const nodeFs = {
  async readFile(file: string): Promise<string> {
    return fs.readFile(expand(file), 'utf8');
  },
  async writeFile(file: string, data: string): Promise<void> {
    const f = expand(file);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data, 'utf8');
  },
  async appendFile(file: string, data: string): Promise<void> {
    const f = expand(file);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.appendFile(f, data, 'utf8');
  },
  async exists(file: string): Promise<boolean> {
    try { await fs.access(expand(file)); return true; } catch { return false; }
  },
  async mkdir(dir: string): Promise<void> {
    await fs.mkdir(expand(dir), { recursive: true });
  }
};

const nodeCryptoAdapter = {
  randomBytes(n: number): Uint8Array {
    return new Uint8Array(nodeCrypto.randomBytes(n));
  },
  sha1hex(s: string): string {
    return nodeCrypto.createHash('sha1').update(s, 'utf8').digest('hex');
  }
};

/** 凭据文件：~/.gitlite/credentials/<hash>.tok（目录权限 0700）；内容为裸 token */
class FileCredentialStore {
  constructor(private dir = '~/.gitlite/credentials') {}

  private file(key: string): string {
    const h = nodeCrypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
    return path.join(expand(this.dir), `${h}.tok`);
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

export function createNodeRuntime(opts?: { credentialDir?: string }): RuntimeAdapter {
  const creds = new FileCredentialStore(opts?.credentialDir);
  return {
    fs: nodeFs,
    crypto: nodeCryptoAdapter,
    credential: creds,
    fetch: (globalThis as any).fetch,
    now: () => Date.now(),
    onExit(fn) {
      process.once('beforeExit', () => { void fn(); });
      process.once('SIGINT', () => { void Promise.resolve(fn()).finally(() => process.exit(0)); });
      process.once('SIGTERM', () => { void Promise.resolve(fn()).finally(() => process.exit(0)); });
    }
  };
}
