// 索引管理：单字段 + 复合 + 唯一（FR H1/H2/H3）；索引文件随数据同 commit
// P4（docs/14）：IndexStore 双后端——内存（默认，行为与 v0.2 前一致）/ 本地 SQLite
//（分页缓存对位：条目落盘不占 JS 堆，重启/未变 pull 经 docHash 跳过全量重建）。
// 仓库仍是唯一事实源（ADR-002）：无论后端，_indexes/*.idx.json 照常随数据 commit。
import { UniqueConstraintError } from '../errors.js';
import { SYS, type Document } from '../types.js';
import type { SqliteDb } from '../runtime.js';
import { SqliteIndexStore } from './sqlite-store.js';
import { displayValue, entryKey, indexFilePath, isNumericKey, keyOf, rawOf, renderIndexJson } from './keys.js';

export interface IndexDef {
  name: string;
  /** 前导列（fields[0]）；单字段索引即该字段 */
  field: string;
  /** 全部字段：单字段 [f]；复合 ≥2 */
  fields: string[];
  unique: boolean;
}

/** 索引存储后端（P4「换部件」切面）。内存实现 = v0.2 前行为；SQLite 实现 = 本地分页缓存。
 *  全部同步——planner/Collection/事务/同步引擎零改动；适配器错误由 IndexManager 统一降级（H2）。 */
export interface IndexStore {
  readonly kind: 'memory' | 'sqlite';
  rebuild(c: string, defs: IndexDef[], docs: Document[]): void;
  /** 写路径同步维护；before=null 为插入，after=null 为删除；唯一冲突抛 UniqueConstraintError */
  onWrite(c: string, defs: IndexDef[], before: Document | null, after: Document | null): void;
  checkUnique(c: string, defs: IndexDef[], doc: Document): void;
  /** 等值点查（单字段/复合共用同一 key 编码）；该索引未构建返回 null（查询层降级全表） */
  eq(c: string, def: IndexDef, key: string): string[] | null;
  /** 范围扫描（B-Tree 范围查找对位）；该索引未构建返回 null */
  range(c: string, def: IndexDef, bounds: { gt?: any; gte?: any; lt?: any; lte?: any }): string[] | null;
  builtCollections(): string[];
  indexNames(c: string): string[];
  /** 渲染 idx.json 内容；该索引无数据（未建）返回 null */
  renderIndex(c: string, name: string): string | null;
  /** 全量替换（启动/pull 导入）；逐文件健康上报（损坏 → false，查询降级 H2） */
  importFiles(files: Map<string, string>, onHealth: (c: string, ok: boolean) => void): void;
  close(): void;
}

/** 从 schema（JSON Schema + x-gitlite-*）提取索引定义 */
export function indexDefsFromSchema(schema: any): IndexDef[] {
  if (!schema) return [];
  const defs: IndexDef[] = [];
  for (const [field, sub] of Object.entries<any>(schema.properties ?? {})) {
    if (sub?.['x-gitlite-indexed'] || sub?.['x-gitlite-unique']) {
      defs.push({ name: field, field, fields: [field], unique: !!sub?.['x-gitlite-unique'] });
    }
  }
  for (const idx of schema['x-gitlite-indexes'] ?? []) {
    if (idx.fields?.length >= 1) {
      defs.push({ name: idx.name, field: idx.fields[0], fields: idx.fields, unique: !!idx.unique });
    }
  }
  return defs;
}

export class IndexManager {
  private schemas = new Map<string, any>();
  /** 降级标记：损坏/缺失时 false，查询走全表（FR H2） */
  private healthy = new Map<string, boolean>();

  constructor(private store: IndexStore = new MemoryIndexStore()) {}

  /** P4：本地 SQLite 索引后端（db 由宿主经 RuntimeAdapter.sqlite 打开） */
  static openSqlite(db: SqliteDb): IndexManager {
    return new IndexManager(new SqliteIndexStore(db));
  }

  get backend(): 'memory' | 'sqlite' { return this.store.kind; }

  registerSchema(c: string, schema: any | null): void {
    if (schema) this.schemas.set(c, schema);
  }

  isIndexed(c: string): boolean {
    return this.indexDefs(c).length > 0 && (this.healthy.get(c) ?? true);
  }

  indexDefs(c: string): IndexDef[] {
    return indexDefsFromSchema(this.schemas.get(c) ?? null);
  }

  rebuild(c: string, docs: Document[]): void {
    const defs = this.indexDefs(c);
    if (!defs.length) return;
    try {
      this.store.rebuild(c, defs, docs);
      this.healthy.set(c, true);
    } catch {
      this.healthy.set(c, false);
    }
  }

  /** 写路径同步维护；before=null 为插入，after=null 为删除。
   *  索引尚未构建（无数据）时跳过——由 rebuild 全量补齐（putSchema/pull 时触发）。 */
  onWrite(c: string, before: Document | null, after: Document | null): void {
    const defs = this.indexDefs(c);
    if (!defs.length) return;
    try {
      this.store.onWrite(c, defs, before, after);
    } catch (e) {
      if (e instanceof UniqueConstraintError) throw e;
      this.healthy.set(c, false); // 存储故障 → 降级全表（数据写不受影响）
    }
  }

  checkUnique(c: string, doc: Document): void {
    const defs = this.indexDefs(c).filter(d => d.unique);
    if (!defs.length) return;
    try {
      this.store.checkUnique(c, defs, doc);
    } catch (e) {
      if (e instanceof UniqueConstraintError) throw e;
      this.healthy.set(c, false);
    }
  }

  /** 索引可用时返回候选 id 集（仅单字段索引）；索引缺失/未建/损坏返回 null（查询层降级全表，H2） */
  candidates(c: string, field: string, value: any): string[] | null {
    const def = this.indexDefs(c).find(d => d.fields.length === 1 && d.field === field);
    if (!def || !this.healthy.get(c)) return null;
    return this.guard(c, () => this.store.eq(c, def, keyOf(value)), null);
  }

  /** 复合索引等值匹配（P2：联合索引对位，全字段等值契约）。
   *  values = filter 顶层等值字段（裸标量 或 $eq）；需覆盖索引全部字段。
   *  @returns 候选 id 集；无可用的复合索引/字段不全/未构建/损坏返回 null（查询层降级）。
   *  部分前缀 / 前导列单查（复合范围扫描）留待 v0.3。 */
  compositeCandidates(c: string, values: Map<string, any>): string[] | null {
    const defs = this.indexDefs(c).filter(d => d.fields.length > 1);
    if (!defs.length || !this.healthy.get(c)) return null;
    const def = defs.find(d => d.fields.every(f => values.has(f)));
    if (!def) return null;
    const key = JSON.stringify(def.fields.map(f => keyOf(values.get(f))));
    return this.guard(c, () => this.store.eq(c, def, key), null);
  }

  /** 范围扫描（P1a：B-Tree 范围查找对位）：定位区间，收集 ids。
   *  range 兼容 {$gt,...}（filter 原生词表）与 {gt,...} 两种键形。
   *  索引不可用 / 空 range → null（降级全表）。
   *  SQLite 后端注：文本键按 UTF-8 字节序比较，与内存后端的 UTF-16 序在 BMP 内一致；
   *  增补面字符（代理对）邻界的极端边界可能多/少纳个别候选，Collection 侧 matches 复核兜底。 */
  rangeCandidates(c: string, field: string,
                  range: { gt?: any; gte?: any; lt?: any; lte?: any;
                           $gt?: any; $gte?: any; $lt?: any; $lte?: any }): string[] | null {
    const def = this.indexDefs(c).find(d => d.fields.length === 1 && d.field === field);
    if (!def || !this.healthy.get(c)) return null;
    const r = range as Record<string, any>;
    const gt = r.gt ?? r.$gt, gte = r.gte ?? r.$gte,
          lt = r.lt ?? r.$lt, lte = r.lte ?? r.$lte;
    // 防御：空 range（无任何边界）不视为合法扫描 → 降级全表，杜绝静默全集
    if (gt === undefined && gte === undefined && lt === undefined && lte === undefined) return null;
    return this.guard(c, () => this.store.range(c, def, { gt, gte, lt, lte }), null);
  }

  /** 索引文件导出；collections 缺省 = 全量，传入脏集合 → 只导出脏表索引（P1b）。
   *  manifest 常驻全量（信息性；importFiles 按 idx.json 扫描，不读 manifest）。 */
  exportFiles(collections?: Set<string>): Map<string, string> {
    const out = new Map<string, string>();
    const indexes = this.store.builtCollections().flatMap(c =>
      this.store.indexNames(c).map(name => ({ collection: c, name, file: `${c}.${name}.idx.json` })));
    out.set(`${SYS.indexDir}/_manifest.json`, JSON.stringify({ formatVersion: 1, indexes }, null, 2));
    const want = (c: string) => collections === undefined || collections.has(c);
    for (const { collection: c, name } of indexes) {
      if (!want(c)) continue;
      const content = this.guard(c, () => this.store.renderIndex(c, name), null);
      if (content !== null) out.set(indexFilePath(c, name), content);
    }
    return out;
  }

  importFiles(files: Map<string, string>): void {
    this.store.importFiles(files, (c, ok) => this.healthy.set(c, ok));
  }

  close(): void {
    this.store.close();
  }

  /** 读路径守卫：存储故障（如 sqlite 损坏/已关闭）→ 标记降级 + 返回 fallback（H2） */
  private guard<T>(c: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      this.healthy.set(c, false);
      return fallback;
    }
  }
}

// ---------- 内存后端（默认；v0.2 前行为的原样迁移） ----------

class MemoryIndexStore implements IndexStore {
  readonly kind = 'memory' as const;
  /** collection → indexName → value → ids[] */
  private data = new Map<string, Map<string, Map<string, string[]>>>();
  /** collection → indexName → 排序后的 strKey 数组（范围扫描用，类型感知排序） */
  private sorted = new Map<string, Map<string, string[]>>();

  rebuild(c: string, defs: IndexDef[], docs: Document[]): void {
    const m = new Map<string, Map<string, string[]>>();
    const sorted = new Map<string, string[]>();
    for (const def of defs) { m.set(def.name, new Map()); sorted.set(def.name, []); }
    for (const d of docs) {
      for (const def of defs) {
        const v = entryKey(def, d);
        const bucket = m.get(def.name)!;
        if (!bucket.has(v)) { bucket.set(v, []); sorted.get(def.name)!.push(v); }
        bucket.get(v)!.push(d._id);
      }
    }
    // 类型感知排序：单字段数值索引按数值序（避免 "10" < "9" 的字典序陷阱）；其余字典序
    for (const def of defs) {
      const keys = sorted.get(def.name)!;
      const single = def.fields.length === 1;
      const numeric = single && keys.every(isNumericKey);
      keys.sort(numeric
        ? (a, b) => Number(rawOf(a)) - Number(rawOf(b))
        : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    this.data.set(c, m);
    this.sorted.set(c, sorted);
  }

  onWrite(c: string, defs: IndexDef[], before: Document | null, after: Document | null): void {
    const m = this.data.get(c);
    if (!m) return;
    const sortedMap = this.sorted.get(c) ?? new Map<string, string[]>();
    for (const def of defs) {
      const bucket = m.get(def.name)!;
      let sortedKeys = sortedMap.get(def.name);
      if (!sortedKeys) { sortedKeys = [...bucket.keys()].sort(); sortedMap.set(def.name, sortedKeys); }
      const cmp = comparatorFor(sortedKeys);
      if (before) {
        const k = entryKey(def, before);
        removeFrom(bucket, k, before._id);
        if (!bucket.get(k)?.length) {
          const i = sortedKeys.indexOf(k);
          if (i >= 0) sortedKeys.splice(i, 1);
          bucket.delete(k); // 修复：清掉空键，否则同值更新时重插入会跳过 insertSorted，排序键永久丢失
        }
      }
      if (after) {
        const v = entryKey(def, after);
        if (def.unique) {
          const existing = bucket.get(v) ?? [];
          if (existing.some(id => id !== after._id)) {
            throw new UniqueConstraintError(def.name, displayValue(def, after));
          }
        }
        if (!bucket.has(v)) {
          bucket.set(v, []);
          insertSorted(sortedKeys, v, cmp);
        }
        bucket.get(v)!.push(after._id);
      }
    }
    this.sorted.set(c, sortedMap);
  }

  checkUnique(c: string, defs: IndexDef[], doc: Document): void {
    for (const def of defs) {
      const v = entryKey(def, doc);
      const ids = this.data.get(c)?.get(def.name)?.get(v) ?? [];
      if (ids.some(id => id !== doc._id)) {
        throw new UniqueConstraintError(def.name, displayValue(def, doc));
      }
    }
  }

  eq(c: string, def: IndexDef, key: string): string[] | null {
    const m = this.data.get(c);
    if (!m) return null;                        // 索引未构建 → 全表
    const bucket = m.get(def.name);
    if (!bucket) return null;
    return bucket.get(key) ?? [];               // bucket 存在但无该值 → 空候选（合法）
  }

  range(c: string, def: IndexDef, b: { gt?: any; gte?: any; lt?: any; lte?: any }): string[] | null {
    const m = this.data.get(c);
    const sortedKeys = this.sorted.get(c)?.get(def.name);
    const bucket = m?.get(def.name);
    if (!m || !sortedKeys || !bucket) return null;

    const cmp = comparatorFor(sortedKeys);
    // 二分：lower = 第一个满足 (>= gt 或 > gt) 的 key；upper = 最后一个满足 (<= lt 或 < lt)
    let lo = 0, hi = sortedKeys.length;        // [lo, hi) 为命中区间
    if (b.gt !== undefined) {
      lo = lowerBound(sortedKeys, keyOf(b.gt), cmp, false);  // 严格大于
    } else if (b.gte !== undefined) {
      lo = lowerBound(sortedKeys, keyOf(b.gte), cmp, true);   // 大于等于
    }
    if (b.lt !== undefined) {
      hi = upperBound(sortedKeys, keyOf(b.lt), cmp, false);   // 严格小于
    } else if (b.lte !== undefined) {
      hi = upperBound(sortedKeys, keyOf(b.lte), cmp, true);   // 小于等于
    }
    if (lo >= hi) return [];
    const ids: string[] = [];
    for (let i = lo; i < hi; i++) ids.push(...(bucket.get(sortedKeys[i]!) ?? []));
    return ids;
  }

  builtCollections(): string[] {
    return [...this.data.keys()];
  }

  indexNames(c: string): string[] {
    return [...(this.data.get(c)?.keys() ?? [])];
  }

  renderIndex(c: string, name: string): string | null {
    const bucket = this.data.get(c)?.get(name);
    return bucket ? renderIndexJson(bucket) : null;
  }

  importFiles(files: Map<string, string>, onHealth: (c: string, ok: boolean) => void): void {
    this.data.clear();
    this.sorted.clear(); // 修复：原实现漏清 sorted（导入后范围扫描会混用旧键集）
    for (const [path, content] of files) {
      const m = /^_indexes\/(.+)\.([^.]+)\.idx\.json$/.exec(path);
      if (!m || m[1] === '_manifest') continue;
      try {
        const { entries } = JSON.parse(content);
        const c = m[1]!, name = m[2]!;
        if (!this.data.has(c)) this.data.set(c, new Map());
        const bucket = new Map<string, string[]>(Object.entries(entries ?? {}) as [string, string[]][]);
        this.data.get(c)!.set(name, bucket);
        // 修复：导入即建排序键集（原实现只建 data，范围扫描在 rebuild 前一直降级）
        const keys = [...bucket.keys()];
        const numeric = keys.length > 0 && keys.every(isNumericKey);
        keys.sort(numeric
          ? (a, b) => Number(rawOf(a)) - Number(rawOf(b))
          : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
        if (!this.sorted.has(c)) this.sorted.set(c, new Map());
        this.sorted.get(c)!.set(name, keys);
        onHealth(c, true);
      } catch {
        onHealth(m[1]!, false); // 损坏 → 降级（H2）
      }
    }
  }

  close(): void {}
}

/** 由现有 key 集合推断比较器：全为裸数值 → 数值比较；否则字典序 */
function comparatorFor(keys: string[]): (a: string, b: string) => number {
  const numeric = keys.length > 0 && keys.every(isNumericKey);
  return numeric
    ? (a, b) => Number(rawOf(a)) - Number(rawOf(b))
    : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
}

function insertSorted(arr: string[], v: string, cmp: (a: string, b: string) => number): void {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(arr[mid]!, v) < 0) lo = mid + 1; else hi = mid;
  }
  arr.splice(lo, 0, v);
}

/** 第一个 cmp(k, target) >= 0（inclusive）或 > 0（exclusive）的下标 */
function lowerBound(keys: string[], target: string,
                    cmp: (a: string, b: string) => number, inclusive: boolean): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = cmp(keys[mid]!, target);
    if (c < 0 || (c === 0 && !inclusive)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 第一个 cmp(k, target) > 0（inclusive: c <= 0 继续）的下标（ exclusive: c < 0 继续） */
function upperBound(keys: string[], target: string,
                    cmp: (a: string, b: string) => number, inclusive: boolean): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = cmp(keys[mid]!, target);
    if (c < 0 || (c === 0 && inclusive)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function removeFrom(bucket: Map<string, string[]>, key: string, id: string): void {
  const arr = bucket.get(key);
  if (!arr) return;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
}
