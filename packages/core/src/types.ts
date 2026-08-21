// 公共类型定义（core 全模块共享）
export type Json =
  | string | number | boolean | null | Json[] | { [k: string]: Json };

/** 文档 = 带保留元字段的 JSON 对象 */
export interface Document {
  _id: string;
  _rev?: string;
  [k: string]: Json | undefined;
}

export type OptionalId<T> = T & { _id?: string };

export interface RepoRef { owner: string; repo: string }

export interface RepoInfo {
  ref: RepoRef;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  size: number;
}

export interface CreateRepoInput {
  description?: string;
  private?: boolean;
  autoInit?: boolean;
}

export type FileChange =
  | { kind: 'put'; path: string; content: string }
  | { kind: 'delete'; path: string };

// ---- Filter（v0.1 操作符集，见 requirements E2）----
export type FieldOperator =
  | { $eq?: Json } | { $ne?: Json }
  | { $gt?: Json } | { $gte?: Json } | { $lt?: Json } | { $lte?: Json }
  | { $in?: Json[] } | { $nin?: Json[] }
  | { $exists?: boolean }
  | { $regex?: string; $options?: string };

export type Filter = {
  [k: string]: Json | FieldOperator | Filter[] | Filter;
} & {
  $and?: Filter[];
  $or?: Filter[];
  $not?: Filter;
};

// ---- Update ----
export type Update = {
  $set?: Record<string, Json>;
  $unset?: Record<string, true>;
  $inc?: Record<string, number>;
  $push?: Record<string, Json>;
  $pull?: Record<string, Json>;
  $addToSet?: Record<string, Json>;
};

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  projection?: Record<string, 0 | 1>;
  consistency?: 'cache' | 'synced' | 'fresh';
}

export interface Page<T> { items: T[]; total: number; hasMore: boolean }

export interface UpdateOptions {
  upsert?: boolean;
  expectedRev?: string;
}

export interface UpdateResult { matchedCount: number; modifiedCount: number; upsertedId?: string }
export interface DeleteResult { deletedCount: number }

// ---- 系统文件常量（格式宪法冻结清单）----
export const SYS = {
  configPath: 'gitlite.config.jsonc',
  schemaDir: '_schema',
  indexDir: '_indexes',
  migrationsDir: '_migrations',
  metaDir: '_meta',
  headPath: '_meta/head.json',
  dbBranchPrefix: 'gitlite/',
  /** 仓库格式契约版本（ADR-002）：1.0.0 = 冻结（additive-only 具约束力）；
   *  读兼容策略：0.x 仓库可读（告警一次后继续）；2.x 仓库拒读（FormatVersionError）。 */
  formatVersion: '1.0.0',
  clientVersion: '0.1.0',
} as const;

export interface SyncPolicy {
  timeWindowMs: number;
  batchSize: number;
  maxRetries: number;
  maxRemoteCallsPerHour: number;
}

export const POLICIES: Record<'economy' | 'balanced' | 'realtime', SyncPolicy> = {
  economy: { timeWindowMs: 600_000, batchSize: 100, maxRetries: 3, maxRemoteCallsPerHour: 60 },
  balanced: { timeWindowMs: 300_000, batchSize: 50, maxRetries: 3, maxRemoteCallsPerHour: 200 },
  realtime: { timeWindowMs: 60_000, batchSize: 20, maxRetries: 3, maxRemoteCallsPerHour: 800 }
};

export type SyncState = 'connecting' | 'ready' | 'syncing' | 'synced' | 'offline' | 'error';

export interface SyncStatus {
  online: boolean;
  state: SyncState;
  mode: 'normal' | 'fully-local';
  pendingOps: number;
  lastSyncAt: string | null;
  remoteHeadOid: string | null;
  conflicts: number;
}
