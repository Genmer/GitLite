// 浏览器与移动端运行时适配（基于原生 IndexedDB 与 WebCrypto，零第三方依赖）
import type { CredentialAdapter, FsAdapter, RuntimeAdapter } from '../runtime.js';

/** 原生纯 JS 同步 SHA-1 实现（RFC 3174，用于 CryptoAdapter.sha1hex 同步接口） */
export function sha1(str: string): string {
  const utf8 = new TextEncoder().encode(str);
  const words: number[] = [];
  for (let i = 0; i < utf8.length; i++) {
    const b = utf8[i] ?? 0;
    const idx = i >> 2;
    words[idx] = (words[idx] ?? 0) | (b << (24 - (i % 4) * 8));
  }
  const byteLen = utf8.length;
  const bitLen = byteLen * 8;
  const padIdx = byteLen >> 2;
  words[padIdx] = (words[padIdx] ?? 0) | (0x80 << (24 - (byteLen % 4) * 8));
  words[(((byteLen + 8) >> 6) << 4) + 15] = bitLen;

  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0] as [number, number, number, number, number];
  const w = new Int32Array(80);

  for (let i = 0; i < words.length; i += 16) {
    for (let j = 0; j < 16; j++) w[j] = (words[i + j] ?? 0) | 0;
    for (let j = 16; j < 80; j++) {
      const v = (w[j - 3] ?? 0) ^ (w[j - 8] ?? 0) ^ (w[j - 14] ?? 0) ^ (w[j - 16] ?? 0);
      w[j] = (v << 1) | (v >>> 31);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[j] ?? 0)) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** 基于 IndexedDB 的大容量文件系统适配器（突破 localStorage 5MB 配额） */
export class IndexedDbFsAdapter implements FsAdapter {
  private dbPromise: Promise<any | null> | null = null;
  private memFallback = new Map<string, string>();

  constructor(private dbName: string = 'gitlite-storage') {}

  private async getDb(): Promise<any | null> {
    const g = globalThis as any;
    if (typeof g === 'undefined' || !g.indexedDB) {
      return null;
    }
    if (!this.dbPromise) {
      this.dbPromise = new Promise<any | null>((resolve) => {
        try {
          const req = g.indexedDB.open(this.dbName, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('files')) {
              db.createObjectStore('files', { keyPath: 'path' });
            }
            if (!db.objectStoreNames.contains('credentials')) {
              db.createObjectStore('credentials', { keyPath: 'key' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return this.dbPromise;
  }

  async readFile(path: string): Promise<string> {
    const db = await this.getDb();
    if (!db) {
      if (!this.memFallback.has(path)) throw new Error(`ENOENT ${path}`);
      return this.memFallback.get(path)!;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const req = store.get(path);
      req.onsuccess = () => {
        if (!req.result) reject(new Error(`ENOENT ${path}`));
        else resolve(req.result.content);
      };
      req.onerror = () => reject(new Error(`Failed to read file ${path}: ${req.error?.message}`));
    });
  }

  async writeFile(path: string, data: string): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      this.memFallback.set(path, data);
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      const req = store.put({ path, content: data, mtime: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to write file ${path}: ${req.error?.message}`));
    });
  }

  async appendFile(path: string, data: string): Promise<void> {
    let existing = '';
    try {
      existing = await this.readFile(path);
    } catch {
      // not exists
    }
    await this.writeFile(path, existing + data);
  }

  async exists(path: string): Promise<boolean> {
    const db = await this.getDb();
    if (!db) {
      return this.memFallback.has(path);
    }
    return new Promise((resolve) => {
      const tx = db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const req = store.get(path);
      req.onsuccess = () => resolve(Boolean(req.result));
      req.onerror = () => resolve(false);
    });
  }

  async mkdir(_dir: string): Promise<void> {
    // 扁平键值文件存储，无需物理目录
  }
}

/** 基于 IndexedDB / sessionStorage 的浏览器凭据存储 */
export class IndexedDbCredentialStore implements CredentialAdapter {
  private dbPromise: Promise<any | null> | null = null;
  private memFallback = new Map<string, string>();

  constructor(private dbName: string = 'gitlite-storage') {}

  private async getDb(): Promise<any | null> {
    const g = globalThis as any;
    if (typeof g === 'undefined' || !g.indexedDB) {
      return null;
    }
    if (!this.dbPromise) {
      this.dbPromise = new Promise<any | null>((resolve) => {
        try {
          const req = g.indexedDB.open(this.dbName, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('files')) {
              db.createObjectStore('files', { keyPath: 'path' });
            }
            if (!db.objectStoreNames.contains('credentials')) {
              db.createObjectStore('credentials', { keyPath: 'key' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return this.dbPromise;
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      this.memFallback.set(key, value);
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction('credentials', 'readwrite');
      const store = tx.objectStore('credentials');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async get(key: string): Promise<string | null> {
    const db = await this.getDb();
    if (!db) {
      return this.memFallback.get(key) ?? null;
    }
    return new Promise((resolve) => {
      const tx = db.transaction('credentials', 'readonly');
      const store = tx.objectStore('credentials');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => resolve(null);
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      this.memFallback.delete(key);
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction('credentials', 'readwrite');
      const store = tx.objectStore('credentials');
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

export interface BrowserRuntimeOptions {
  /** IndexedDB 数据库名称（默认 'gitlite-storage'） */
  dbName?: string;
  /** 自定义 fetch 实现（如跨域代理 SmartFetch / Cloudflare Worker / Tauri Rust 代理） */
  customFetch?: typeof fetch;
}

/** 创建开箱即用的浏览器/PWA/移动端 RuntimeAdapter */
export function createBrowserRuntime(opts?: BrowserRuntimeOptions): RuntimeAdapter {
  const dbName = opts?.dbName ?? 'gitlite-storage';
  const g = globalThis as any;
  return {
    fs: new IndexedDbFsAdapter(dbName),
    crypto: {
      randomBytes: (n: number) => {
        const arr = new Uint8Array(n);
        if (typeof g !== 'undefined' && g.crypto?.getRandomValues) {
          return g.crypto.getRandomValues(arr);
        }
        for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
      sha1hex: sha1
    },
    credential: new IndexedDbCredentialStore(dbName),
    fetch: opts?.customFetch ?? (typeof g !== 'undefined' && g.fetch ? g.fetch.bind(g) : fetch),
    now: () => Date.now(),
    onExit: (fn: () => void | Promise<void>) => {
      if (typeof g !== 'undefined' && g.window && typeof g.window.addEventListener === 'function') {
        g.window.addEventListener('beforeunload', () => {
          void fn();
        });
      }
    }
  };
}
