// 测试辅助：内存 RuntimeAdapter（fs=Map、crypto=node:crypto、credential=Map）
// 仅测试代码 import node 内置（core src 生产代码零 node 依赖，NFR I4）
import * as nodeCrypto from 'node:crypto';
import type { RuntimeAdapter } from '../runtime.js';

export function createTestRuntime(): RuntimeAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const creds = new Map<string, string>();
  return {
    files,
    fs: {
      readFile: async p => {
        if (!files.has(p)) throw new Error(`ENOENT ${p}`);
        return files.get(p)!;
      },
      writeFile: async (p, d) => { files.set(p, d); },
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      exists: async p => files.has(p),
      mkdir: async () => {}
    },
    crypto: {
      randomBytes: n => new Uint8Array(nodeCrypto.randomBytes(n)),
      sha1hex: s => nodeCrypto.createHash('sha1').update(s).digest('hex')
    },
    credential: {
      set: async (k, v) => { creds.set(k, v); },
      get: async k => creds.get(k) ?? null,
      delete: async k => { creds.delete(k); }
    },
    fetch: (() => { throw new Error('network disabled in unit tests'); }) as any,
    now: () => Date.now(),
    onExit: () => {}
  };
}
