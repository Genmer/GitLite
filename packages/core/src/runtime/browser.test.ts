import { describe, it, expect } from 'vitest';
import { IndexedDbFsAdapter, IndexedDbCredentialStore, createBrowserRuntime, sha1 } from './browser.js';

describe('Browser Runtime & IndexedDB Adapter', () => {
  it('sha1 计算准确（与标准测试向量一致）', () => {
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    expect(sha1('gitlite-v0.3.0-database')).toBe(sha1('gitlite-v0.3.0-database'));
  });

  it('IndexedDbFsAdapter 读写、追加、存在性检查（无浏览器原生 indexedDB 时自动平滑回退内存）', async () => {
    const fs = new IndexedDbFsAdapter('test-db');
    expect(await fs.exists('file1.txt')).toBe(false);
    await expect(fs.readFile('file1.txt')).rejects.toThrow('ENOENT');

    await fs.writeFile('file1.txt', 'hello');
    expect(await fs.exists('file1.txt')).toBe(true);
    expect(await fs.readFile('file1.txt')).toBe('hello');

    await fs.appendFile('file1.txt', ' world');
    expect(await fs.readFile('file1.txt')).toBe('hello world');

    await fs.mkdir('any/dir'); // no-op
  });

  it('IndexedDbCredentialStore 凭据设置、读取、删除（自动降级与隔离）', async () => {
    const cred = new IndexedDbCredentialStore('test-cred-db');
    expect(await cred.get('token')).toBeNull();

    await cred.set('token', 'secret-token-123');
    expect(await cred.get('token')).toBe('secret-token-123');

    await cred.delete('token');
    expect(await cred.get('token')).toBeNull();
  });

  it('createBrowserRuntime 组装完整 RuntimeAdapter', async () => {
    const runtime = createBrowserRuntime({ dbName: 'test-runtime-db' });
    expect(runtime.fs).toBeDefined();
    expect(runtime.crypto).toBeDefined();
    expect(runtime.credential).toBeDefined();
    expect(typeof runtime.now()).toBe('number');

    const bytes = runtime.crypto.randomBytes(16);
    expect(bytes.length).toBe(16);

    const hash = runtime.crypto.sha1hex('test-string');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(40);

    let exitCalled = false;
    runtime.onExit(() => { exitCalled = true; });
    expect(exitCalled).toBe(false);
  });

  it('IndexedDbFsAdapter 与 IndexedDbCredentialStore 在 IDB 环境下正常调用 transaction', async () => {
    const mockStorage = new Map<string, any>();
    const mockDb: any = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => {},
      transaction: (storeName: string, mode: string) => {
        return {
          objectStore: () => ({
            get: (key: string) => {
              const req: any = { result: mockStorage.get(`${storeName}:${key}`), onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess?.(), 0);
              return req;
            },
            put: (val: any) => {
              const key = val.path ?? val.key;
              mockStorage.set(`${storeName}:${key}`, val);
              const req: any = { onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess?.(), 0);
              return req;
            },
            delete: (key: string) => {
              mockStorage.delete(`${storeName}:${key}`);
              const req: any = { onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess?.(), 0);
              return req;
            }
          })
        };
      }
    };

    const originalIDB = (globalThis as any).indexedDB;
    (globalThis as any).indexedDB = {
      open: () => {
        const req: any = { result: mockDb, onsuccess: null, onerror: null, onupgradeneeded: null };
        setTimeout(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      }
    };

    try {
      const fs = new IndexedDbFsAdapter('mock-idb');
      expect(await fs.exists('notes.json')).toBe(false);
      await fs.writeFile('notes.json', '{"a":1}');
      expect(await fs.exists('notes.json')).toBe(true);
      expect(await fs.readFile('notes.json')).toBe('{"a":1}');
      await fs.appendFile('notes.json', '\n{"b":2}');
      expect(await fs.readFile('notes.json')).toBe('{"a":1}\n{"b":2}');

      const cred = new IndexedDbCredentialStore('mock-idb');
      await cred.set('my-key', 'my-val');
      expect(await cred.get('my-key')).toBe('my-val');
      await cred.delete('my-key');
      expect(await cred.get('my-key')).toBeNull();
    } finally {
      (globalThis as any).indexedDB = originalIDB;
    }
  });
});
