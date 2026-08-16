// 存储引擎：DB 概念 ↔ 文件映射 + 行级分层序列化 + schema 注册（FR D1/D3/D4/A5）
// 字段级加密（ADR-003）：镜像/基线/diff 全明文；加密仅在 SyncEngine 的 commit/pull 边界
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
  /** 脏集合（P1b：写路径标记，flush 只导出/比对脏表 → O(全仓库) 变 O(改动)） */
  private dirty = new Set<string>();
  /** 索引文件提供者（client 注入 IndexManager，H3：索引随数据同 commit） */
  private indexFilesProvider: ((collections?: Set<string>) => Map<string, string>) | null = null;

  setIndexFilesProvider(fn: (collections?: Set<string>) => Map<string, string>): void {
    this.indexFilesProvider = fn;
  }

  /** 返回 schema 中标记 `x-gitlite-encrypted` 的字段列表（ADR-003，供 SyncEngine 边界加解密） */
  encryptedFields(c: string): string[] {
    const schema = this.getSchema(c);
    if (!schema?.properties) return [];
    return Object.entries(schema.properties)
      .filter(([, v]: [string, any]) => v?.['x-gitlite-encrypted'])
      .map(([k]) => k);
  }

  // ---------- 装载 ----------

  /** pull/bootstrap 后调用：建立镜像 + 基线（远端数据 clean，清空脏集合）。
   *  传入文件须已由 SyncEngine 解密为明文（ADR-003：镜像/基线全明文，diff 稳定）。 */
  importFiles(files: Map<string, string>): void {
    this.collections.clear();
    this.dirty.clear();
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

  /** 生成文件（含系统文件，全明文）；diff 输入。
   *  collections 缺省 = 全量；传入脏集合 → 只导出脏表 + 系统文件（P1b）。 */
  exportFiles(collections?: Set<string>): Map<string, string> {
    const out = new Map<string, string>();
    out.set(SYS.configPath, JSON.stringify({
      formatVersion: SYS.formatVersion, createdBy: `gitlite@${SYS.clientVersion}`
    }, null, 2));
    // 冻结结构：_meta/head.json 必须存在；v0.1 为占位内容（水位由 SyncEngine 内存态+队列维护）
    out.set(SYS.headPath, JSON.stringify({ remoteHeadOid: null, lastSyncAt: null }, null, 2));
    const want = (c: string) => collections === undefined || collections.has(c);
    for (const [name, st] of this.collections) {
      if (!want(name)) continue;
      if (st.schema) {
        out.set(`${SYS.schemaDir}/${name}.schema.jsonc`, JSON.stringify(st.schema, null, 2));
      }
    }
    for (const [name, st] of this.collections) {
      if (!want(name)) continue;
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
    // 索引文件合并进导出（若注入）：只导出脏表的索引（P1b）；索引不含加密字段（明文结构）
    if (this.indexFilesProvider) {
      for (const [p, c] of this.indexFilesProvider(collections)) out.set(p, c);
    }
    return out;
  }

  /** 脏导出 vs 基线 → 增量变更（commit 输入，P1b：O(全仓库) → O(改动)）。
   *  删除仅限脏表自有文件 + 系统目录；clean 表文件与用户文件永不删（FR A4）。 */
  diff(): FileChange[] {
    const current = this.exportFiles(this.dirty);
    const changes: FileChange[] = [];
    for (const [path, content] of current) {
      if (this.baseline.get(path) !== content) {
        changes.push({ kind: 'put', path, content });
      }
    }
    for (const path of this.baseline.keys()) {
      if (current.has(path) || !isGitLiteOwned(path)) continue;
      const owner = ownerOf(path);
      if (owner === null) continue;                    // 系统文件（config/head/manifest 常驻导出）
      if (!this.dirty.has(owner)) continue;            // clean 表文件（仍存在于远端）不删
      changes.push({ kind: 'delete', path });
    }
    return changes;
  }

  /** commit 成功后调用：把「本次提交的明文变更」增量应用到基线（基线 == 远端状态），
   *  只清除「基线已与当前镜像一致」的已提交集合的脏标记——flush 期间晚到的新写保持脏，下轮再推。 */
  markSynced(changes: FileChange[], committed: Set<string>): void {
    for (const ch of changes) {
      if (ch.kind === 'put') this.baseline.set(ch.path, ch.content);
      else this.baseline.delete(ch.path);
    }
    for (const c of committed) {
      if (this.exportEquals(c)) this.dirty.delete(c);
    }
  }

  /** 该集合当前导出是否与基线一致（commit 期间无新写 → 可清脏；有新写 → 保持脏） */
  private exportEquals(c: string): boolean {
    const cur = this.exportFiles(new Set([c]));
    for (const [p, v] of cur) if (this.baseline.get(p) !== v) return false;
    for (const p of this.baseline.keys()) {
      if (cur.has(p)) continue;
      if (isGitLiteOwned(p) && ownerOf(p) === c) return false;
    }
    return true;
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

  // ---------- 脏集合（P1b 增量 diff 基础）----------

  /** 标记一个 collection 为脏（写路径自动调用，外部禁调） */
  markDirty(c: string): void { this.dirty.add(c); }

  /** 清空脏集合（flush 成功 / pull 后调用） */
  clearDirty(): void { this.dirty.clear(); }

  /** 当前脏集合（只读快照） */
  dirtyCollections(): ReadonlySet<string> { return new Set(this.dirty); }

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
    this.dirty.add(c);
  }

  delete(c: string, id: string): boolean {
    const ok = this.collections.get(c)?.docs.delete(id) ?? false;
    if (ok) this.dirty.add(c);
    return ok;
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
    // ADR-003：加密字段禁止索引/唯一/复合（密文不可比较）
    this.assertEncryptedNotIndexed(c, schema);
    this.state(c).schema = schema;
    this.dirty.add(c);
  }

  /** 加密字段互斥校验（ADR-003 §2.4）：x-gitlite-encrypted 与 indexed/unique/复合索引冲突 → 报错 */
  private assertEncryptedNotIndexed(c: string, schema: any): void {
    const props = schema?.properties ?? {};
    const encrypted = Object.entries<any>(props)
      .filter(([, v]) => v?.['x-gitlite-encrypted'])
      .map(([k]) => k);
    if (!encrypted.length) return;
    const conflicts: string[] = [];
    for (const f of encrypted) {
      const sub = props[f];
      if (sub?.['x-gitlite-indexed'] || sub?.['x-gitlite-unique']) conflicts.push(f);
    }
    for (const idx of schema?.['x-gitlite-indexes'] ?? []) {
      if (idx.fields?.some((f: string) => encrypted.includes(f))) {
        conflicts.push(`${idx.name}(${idx.fields.join(',')})`);
      }
    }
    if (conflicts.length) {
      throw new ValidationError([`collection "${c}": encrypted field(s) cannot be indexed/unique: ${conflicts.join(', ')} (ADR-003)`]);
    }
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

/** 数据文件所属 collection（仅数据文件：L0/L1/L2；schema/索引/系统文件 → null）。
 *  供 SyncEngine 边界定位加密字段（ADR-003）。 */
export function dataFileOwner(path: string): string | null {
  if (path.endsWith('.jsonl')) {
    const c = collectionOfInline(path);
    if (c) return c;
    return collectionOfShard(path);
  }
  const single = /^([^/]+)\/([^.]+)\.json$/.exec(path);
  return single && !single[1]!.startsWith('_') ? single[1]! : null;
}

// ---------- 分层辅助 ----------

/** 文件所属 collection：数据/schema/索引文件 → collection 名；系统文件/未知 → null（P1b 删除判定用） */
function ownerOf(path: string): string | null {
  if (path.endsWith('.jsonl')) {
    const c = collectionOfInline(path);
    if (c) return c;
    return collectionOfShard(path);
  }
  if (path.startsWith(`${SYS.schemaDir}/`) && path.endsWith('.schema.jsonc')) {
    return path.slice(SYS.schemaDir.length + 1, -'.schema.jsonc'.length);
  }
  const idx = /^_indexes\/(.+)\.([^.]+)\.idx\.json$/.exec(path);
  if (idx) return idx[1] === '_manifest' ? null : idx[1]!;
  const single = /^([^/]+)\/([^.]+)\.json$/.exec(path);
  return single && !single[1]!.startsWith('_') ? single[1]! : null;
}

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

/** 从文件集合解析全部数据文档（pull 合并计算用；输入须为已解密明文） */
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
