// Node.js 运行时适配（FR I4）：fs（~ 展开）/ crypto / 凭据（文件或 OS 钥匙串）/ fetch / 退出钩子 / SQLite（P4）
// 凭据两级：FileCredentialStore（默认，v0.1 行为）/ OS 钥匙串（credential:'os' 选入，见 credentials.ts）
import * as fs from 'node:fs/promises';
import * as nodeCrypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import type { RuntimeAdapter, SqliteAdapterFactory, SqliteDb } from '@gitlite/core';
import { createOsCredentialStore, FileCredentialStore } from './credentials.js';
import { waitForRedirect, GITLITE_LOOPBACK_PORT } from './loopback.js';

export { createOsCredentialStore, FileCredentialStore };
export type { Runner, ExecResult } from './credentials.js';
export { waitForRedirect, GITLITE_LOOPBACK_PORT };

function expand(p: string): string {
  // GITLITE_HOME 可整体重定向数据根目录（默认 ~ 即用户主目录）；服务/沙箱写不了用户主目录时用它
  const home = process.env.GITLITE_HOME || os.homedir();
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

const nodeFs = {
  async readFile(file: string): Promise<string> {
    return fs.readFile(expand(file), 'utf8');
  },
  async writeFile(file: string, data: string): Promise<void> {
    const f = expand(file);
    await fs.mkdir(path.dirname(f), { recursive: true });
    // 写临时文件再原子改名覆盖：规避 Windows 下对已存在文件直接写被防病毒/锁拦截的 EPERM
    const tmp = `${f}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data, 'utf8');
    try {
      await fs.rename(tmp, f);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
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

/** 凭据文件存储已迁移至 credentials.ts（FileCredentialStore） */

export function createNodeRuntime(opts?: {
  credentialDir?: string;
  /** 'file'（默认，兼容 v0.1）/ 'os'（darwin=security / linux=secret-tool，缺失自动回退文件） */
  credential?: 'file' | 'os';
}): RuntimeAdapter {
  const creds = opts?.credential === 'os'
    ? createOsCredentialStore({ fallbackDir: opts?.credentialDir })
    : new FileCredentialStore(opts?.credentialDir);
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

/** 本地 SQLite 索引后端工厂（P4，docs/14）：node:sqlite（Node ≥22.5，同步 API）。
 *  低版本 / 缺失返回 null——宿主与 core 均回退纯内存索引，不构成故障。 */
export function createNodeSqlite(): SqliteAdapterFactory | null {
  let DatabaseSync: new (path: string) => any;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  } catch {
    return null;
  }
  return {
    open(path: string): SqliteDb {
      const db = new DatabaseSync(expand(path));
      try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* :memory: 等场景不支持 WAL，忽略 */ }
      return {
        exec: sql => void db.exec(sql),
        run: (sql, params = []) => Number(db.prepare(sql).run(...params).changes),
        all: (sql, params = []) => db.prepare(sql).all(...params),
        close: () => void db.close()
      };
    }
  };
}
