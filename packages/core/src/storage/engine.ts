// 存储引擎：DB 概念 ↔ 文件映射 + 行级分层序列化 + schema 注册（FR D1/D3/D4/A5）
import { ValidationError } from '../errors.js';
import { parseJsonc } from '../schema/jsonc.js';
import { SchemaValidator } from '../schema/validate.js';
import { SYS, type Document, type FileChange, type Json } from '../types.js';

const TIER_THRESHOLDS = { inline: 50, docPerFile: 5000 } as const;
const HYSTERESIS = 1.2;

export type Tier = 'inline' | 'doc-per-file' | 'sharded';

interface CollectionState {
  docs: Map<string, Document>;
  schema: any | null;
  tier: Tier;          // 当前序列化级别（带迟滞）
  prevTier: Tier | null;
}

export class StorageEngine {
  private collections = new Map<string, CollectionState>();
  private baseline = new Map<string, string>();   // 上次同步快照（diff 基准 + 三路合并 base）
  private validator = new SchemaValidator();
  private migrationSeq = 0;
  /** 索引文件提供者（client 注入 IndexManager，H3：索引随数据同 commit） */
  private indexFilesProvider: (() => Map<string, string>) | null = null;

  setIndexFilesProvider(fn: () => Map<string, string>): void {
    this.indexFilesProvider = fn;
  }

  // ---------- 装载 ----------

  /** pull/bootstrap 后调用：建立镜像 + 基线 */
  importFiles(files: Map<string, string>): void {
    this.collections.clear();
    // schema 先行
    for (const [path, content] of files) {
      if (path.startsWith(`${SYS.schemaDir}/`) && path.endsWith('.schema.jsonc')) {
        const name = path.slice(SYS.schemaDir.length + 1, -'.schema.jsonc'.length);
        this.putSchema(name, parseJsonc(content));
      }
    }
    // 数据文件
    for (const [path, content] of files) {
      if (path.startsWith('_')) continue;                    // 系统目录
      if (path.endsWith('.jsonl')) {
        const c = collectionOfInline(path);
        if (c) { this.loadInline(c, content); continue; }
        const s = collectionOfShard(path);
        if (s) { this.loadShard(s, content); continue; }
      }
      if (path.endsWith('.json')) {
        const m = /^([^/]+)\/([^.]+)\.json$/.exec(path);
        if (m && !m[1]!.startsWith('_')) {
          this.state(m[1]!).docs.set(m[2]!, JSON.parse(content));
        }
      }
    }
    // 推断当前级别（避免首次 flush 误迁移）
    for (const [name, st] of this.collections) {
      st.tier = inferTier(st.docs.size);
      st.prevTier = st.tier;
    }
    this.baseline = new Map(files);
  }

  /** 生成全量文件（含系统文件）；flush diff 的输入 */
  exportFiles(): Map<string, string> {
    const out = new Map<string, string>();
    out.set(SYS.configPath, JSON.stringify({
      formatVersion: SYS.formatVersion, createdBy: `gitlite@${SYS.clientVersion}`
    }, null, 2));
    // 冻结结构：_meta/head.json 必须存在；v0.1 为占位内容（水位由 SyncEngine 内存态+队列维护）
    out.set(SYS.headPath, JSON.stringify({ remoteHeadOid: null, lastSyncAt: null }, null, 2));
    for (const [name, st] of this.collections) {
      if (st.schema) {
        out.set(`${SYS.schemaDir}/${name}.schema.jsonc`, JSON.stringify(st.schema, null, 2));
      }
    }
    for (const [name, st] of this.collections) {
      const docs = [...st.docs.values()].sort((a, b) => a._id < b._id ? -1 : 1);
      const tier = decideTier(st, docs.length);
      if (tier !== st.tier) {
        this.migrationSeq++;
        out.set(`${SYS.migrationsDir}/${ts()}-tier-${st.tier}-to-${tier}-${name}.json`,
          JSON.stringify({ id: `tier-${st.tier}-to-${tier}`, collection: name, from: st.tier, to: tier, docCount: docs.length }, null, 2));
        st.prevTier = st.tier;
        st.tier = tier;
      }
      switch (tier) {
        case 'inline':
          out.set(`${name}.jsonl`, docs.map(d => JSON.stringify(d)).join('\n') + (docs.length ? '\n' : ''));
          break;
        case 'doc-per-file':
          for (const d of docs) out.set(`${name}/${d._id}.json`, JSON.stringify(d, null, 2));
          break;
        case 'sharded': {
          const shards = shardDocs(docs);
          for (const [i, shard] of shards.entries()) {
            out.set(`${name}/shard-${String(i).padStart(4, '0')}.jsonl`,
              shard.map(d => JSON.stringify(d)).join('\n') + '\n');
          }
          break;
        }
      }
    }
    // 索引文件合并进导出（若注入）
    if (this.indexFilesProvider) {
      for (const [p, c] of this.indexFilesProvider()) out.set(p, c);
    }
    return out;
  }

  /** exportFiles() vs 基线 → 增量变更（commit 输入）。
   *  删除仅限 GitLite 自有文件（数据/schema/索引/系统目录）——
   *  永不删除用户已有文件（foreign 仓库承诺，FR A4）。 */
  diff(): FileChange[] {
    const current = this.exportFiles();
    const changes: FileChange[] = [];
    for (const [path, content] of current) {
      if (this.baseline.get(path) !== content) {
        changes.push({ kind: 'put', path, content });
      }
    }
    for (const path of this.baseline.keys()) {
      if (!current.has(path) && isGitLiteOwned(path)) {
        changes.push({ kind: 'delete', path });
      }
    }
    return changes;
  }

  /** commit 成功后调用：基线 = 当前导出（远端 == 镜像） */
  markSynced(): void {
    this.baseline = this.exportFiles();
  }

  /** pull 合并后调用：基线 = 远端文件（本地 dirty 保留为 diff） */
  setBaseline(files: Map<string, string>): void {
    this.baseline = new Map(files);
  }

  getBaseline(): Map<string, string> {
    return new Map(this.baseline);
  }

  /** 当前镜像全量文档快照（合并计算用） */
  currentDocs(): Map<string, Map<string, Document>> {
    const out = new Map<string, Map<string, Document>>();
    for (const [c, st] of this.collections) out.set(c, new Map(st.docs));
    return out;
  }

  // ---------- 读写（打在镜像上）----------

  read(c: string, id: string): Document | null {
    return this.collections.get(c)?.docs.get(id) ?? null;
  }

  scan(c: string): Document[] {
    const st = this.collections.get(c);
    return st ? [...st.docs.values()] : [];
  }

  upsert(c: string, doc: Document): void {
    this.state(c).docs.set(doc._id, doc);
  }

  delete(c: string, id: string): boolean {
    return this.collections.get(c)?.docs.delete(id) ?? false;
  }

  collectionNames(): string[] {
    return [...this.collections.keys()];
  }

  // ---------- schema ----------

  putSchema(c: string, schema: object): void {
    // 校验 schema 自身合法性（用空对象探测结构错误：未知关键字）
    const issues = this.validator.validate({}, schema);
    if (issues.some(i => i.message.includes('unsupported schema keyword'))) {
      throw new ValidationError(issues.map(i => `${i.path}: ${i.message}`));
    }
    this.state(c).schema = schema;
  }

  getSchema(c: string): any | null {
    return this.collections.get(c)?.schema ?? null;
  }

  validate(c: string, doc: Document): void {
    const schema = this.getSchema(c);
    if (!schema) return; // schemaless collection 合法（D3 弹性）
    const issues = this.validator.validate(doc, schema);
    if (issues.length) throw new ValidationError(issues.map(i => `${i.path || '(root)'}: ${i.message}`));
  }

  tierOf(c: string): Tier {
    return this.collections.get(c)?.tier ?? 'doc-per-file';
  }

  // ---------- 内部 ----------

  private state(c: string): CollectionState {
    if (c.startsWith('_')) throw new ValidationError([`collection name "${c}" must not start with "_"`]);
    let st = this.collections.get(c);
    if (!st) {
      st = { docs: new Map(), schema: null, tier: 'inline', prevTier: null };
      this.collections.set(c, st);
    }
    return st;
  }

  private loadInline(c: string, content: string): void {
    for (const line of content.split('\n')) {
      if (line.trim()) this.state(c).docs.set((JSON.parse(line) as Document)._id, JSON.parse(line));
    }
  }

  private loadShard(c: string, content: string): void {
    for (const line of content.split('\n')) {
      if (line.trim()) {
        const d = JSON.parse(line) as Document;
        this.state(c).docs.set(d._id, d);
      }
    }
  }
}

// ---------- 分层辅助 ----------

/** GitLite 自有文件判定：系统目录 + 数据文件模式；用户文件（README.md、src/…）不算 */
function isGitLiteOwned(path: string): boolean {
  if (path === SYS.configPath) return true;
  if (path.startsWith(`${SYS.schemaDir}/`) || path.startsWith(`${SYS.indexDir}/`) ||
      path.startsWith(`${SYS.metaDir}/`)) return true;
  if (path.startsWith(`${SYS.migrationsDir}/`)) return false; // 不可变日志，不删
  return collectionOfInline(path) !== null || collectionOfShard(path) !== null ||
    /^([^/]+)\/([^.]+)\.json$/.test(path);
}

function collectionOfInline(path: string): string | null {
  const m = /^([^/]+)\.jsonl$/.exec(path);
  return m && !m[1]!.startsWith('_') ? m[1]! : null;
}

function collectionOfShard(path: string): string | null {
  const m = /^([^/]+)\/shard-\d{4}\.jsonl$/.exec(path);
  return m && !m[1]!.startsWith('_') ? m[1]! : null;
}

function inferTier(count: number): Tier {
  if (count < TIER_THRESHOLDS.inline) return 'inline';
  if (count < TIER_THRESHOLDS.docPerFile) return 'doc-per-file';
  return 'sharded';
}

/** 迟滞决策：仅在明显越界时才迁移（D3） */
function decideTier(st: CollectionState, count: number): Tier {
  const natural = inferTier(count);
  if (natural === st.tier) return st.tier;
  // 降级需要跌破阈值/1.2；升级立即
  const goingDown = natural === 'inline' && st.tier !== 'inline'
    || natural === 'doc-per-file' && st.tier === 'sharded';
  if (goingDown) {
    const limit = st.tier === 'sharded'
      ? TIER_THRESHOLDS.docPerFile / HYSTERESIS
      : TIER_THRESHOLDS.inline / HYSTERESIS;
    if (count < limit) return natural;
    return st.tier;
  }
  return natural;
}

/** ULID 前缀序分片：≤min(1000 行, 512KB 目标)（冻结清单） */
function shardDocs(docs: Document[]): Document[][] {
  const MAX_ROWS = 1000;
  const shards: Document[][] = [];
  for (let i = 0; i < docs.length; i += MAX_ROWS) {
    shards.push(docs.slice(i, i + MAX_ROWS));
  }
  return shards.length ? shards : [[]];
}

function ts(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** 从文件集合解析全部数据文档（pull 合并计算用） */
export function parseDocs(files: Map<string, string>): Map<string, Map<string, Document>> {
  const out = new Map<string, Map<string, Document>>();
  const put = (c: string, d: Document) => {
    if (!out.has(c)) out.set(c, new Map());
    out.get(c)!.set(d._id, d);
  };
  for (const [path, content] of files) {
    if (path.startsWith('_')) continue;
    const inline = collectionOfInline(path);
    if (inline) {
      for (const line of content.split('\n')) if (line.trim()) put(inline, JSON.parse(line));
      continue;
    }
    const shard = collectionOfShard(path);
    if (shard) {
      for (const line of content.split('\n')) if (line.trim()) put(shard, JSON.parse(line));
      continue;
    }
    const single = /^([^/]+)\/([^.]+)\.json$/.exec(path);
    if (single && !single[1]!.startsWith('_')) put(single[1]!, JSON.parse(content));
  }
  return out;
}
