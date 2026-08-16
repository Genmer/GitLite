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

/** 同步 SQLite 能力（P4 索引后端，docs/14）：宿主可选注入。
 *  必须同步——IndexManager 查询路径是同步的（planner/Collection 零改动）。
 *  Node ≥22.5 可用 node:sqlite（DatabaseSync，见 adapters-node createNodeSqlite）；
 *  无法提供的宿主（部分浏览器运行时）不注入即可——索引自动回退纯内存后端。 */
export interface SqliteDb {
  exec(sql: string): void;
  /** @returns 受影响行数 */
  run(sql: string, params?: unknown[]): number;
  all(sql: string, params?: unknown[]): Record<string, any>[];
  close(): void;
}

export interface SqliteAdapterFactory {
  /** 打开（或创建）一个 SQLite 数据库文件；同一路径重复打开 = 恢复该库的本地索引缓存 */
  open(path: string): SqliteDb;
}

export interface RuntimeAdapter {
  fs: FsAdapter;
  crypto: CryptoAdapter;
  credential: CredentialAdapter;
  fetch: typeof fetch;
  now(): number;
  /** 退出钩子（FR F3 flushOnExit）：宿主进程退出前触发 */
  onExit(fn: () => void | Promise<void>): void;
  /** 可选：本地 SQLite 索引后端（P4）；缺省 = 纯内存索引 */
  sqlite?: SqliteAdapterFactory;
}
