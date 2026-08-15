// 环境能力注入：core 零 node 内置 import（FR I4），一切经 RuntimeAdapter
export interface FsAdapter {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(dir: string): Promise<void>;
}

export interface CryptoAdapter {
  randomBytes(n: number): Uint8Array;
  sha1hex(s: string): string;
}

export interface CredentialAdapter {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export interface RuntimeAdapter {
  fs: FsAdapter;
  crypto: CryptoAdapter;
  credential: CredentialAdapter;
  fetch: typeof fetch;
  now(): number;
  /** 退出钩子（FR F3 flushOnExit）：宿主进程退出前触发 */
  onExit(fn: () => void | Promise<void>): void;
}
