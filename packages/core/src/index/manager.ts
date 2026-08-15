// 索引管理：单字段 + 唯一（FR H1/H2/H3）；索引文件随数据同 commit
import { UniqueConstraintError } from '../errors.js';
import { SYS, type Document } from '../types.js';

interface IndexDef { name: string; field: string; unique: boolean }

/** 从 schema（JSON Schema + x-gitlite-*）提取索引定义 */
export function indexDefsFromSchema(schema: any): IndexDef[] {
  if (!schema) return [];
  const defs: IndexDef[] = [];
  for (const [field, sub] of Object.entries<any>(schema.properties ?? {})) {
    if (sub?.['x-gitlite-indexed'] || sub?.['x-gitlite-unique']) {
      defs.push({ name: field, field, unique: !!sub?.['x-gitlite-unique'] });
    }
  }
  for (const idx of schema['x-gitlite-indexes'] ?? []) {
    if (idx.fields?.length === 1) {
      defs.push({ name: idx.name, field: idx.fields[0], unique: !!idx.unique });
    }
    // 复合索引 v0.3（MVP 边界）
  }
  return defs;
}

export class IndexManager {
  /** collection → indexName → value → ids[] */
  private data = new Map<string, Map<string, Map<string, string[]>>>();
  private schemas = new Map<string, any>();
  /** 降级标记：损坏/缺失时 false，查询走全表（FR H2） */
  private healthy = new Map<string, boolean>();

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
    const m = new Map<string, Map<string, string[]>>();
    for (const def of defs) m.set(def.name, new Map());
    for (const d of docs) {
      for (const def of defs) {
        const v = keyOf(d[def.field]);
        const bucket = m.get(def.name)!;
        if (!bucket.has(v)) bucket.set(v, []);
        bucket.get(v)!.push(d._id);
      }
    }
    this.data.set(c, m);
    this.healthy.set(c, true);
  }

  /** 写路径同步维护；before=null 为插入，after=null 为删除。
   *  索引尚未构建（无 data）时跳过——由 rebuild 全量补齐（putSchema/pull 时触发）。 */
  onWrite(c: string, before: Document | null, after: Document | null): void {
    const defs = this.indexDefs(c);
    if (!defs.length) return;
    const m = this.data.get(c);
    if (!m) return;
    for (const def of defs) {
      const bucket = m.get(def.name)!;
      if (before) removeFrom(bucket, keyOf(before[def.field]), before._id);
      if (after) {
        const v = keyOf(after[def.field]);
        if (def.unique) {
          const existing = bucket.get(v) ?? [];
          if (existing.some(id => id !== after._id)) {
            throw new UniqueConstraintError(def.field, String(after[def.field]));
          }
        }
        if (!bucket.has(v)) bucket.set(v, []);
        bucket.get(v)!.push(after._id);
      }
    }
  }

  checkUnique(c: string, doc: Document): void {
    for (const def of this.indexDefs(c).filter(d => d.unique)) {
      const v = keyOf(doc[def.field]);
      const ids = this.data.get(c)?.get(def.name)?.get(v) ?? [];
      if (ids.some(id => id !== doc._id)) {
        throw new UniqueConstraintError(def.field, String(doc[def.field]));
      }
    }
  }

  /** 索引可用时返回候选 id 集；索引缺失/未建/损坏返回 null（查询层降级全表，H2） */
  candidates(c: string, field: string, value: any): string[] | null {
    const defs = this.indexDefs(c);
    const def = defs.find(d => d.field === field);
    if (!def || !this.healthy.get(c)) return null;
    const m = this.data.get(c);
    if (!m) return null;                        // 索引未构建 → 全表
    const bucket = m.get(def.name);
    if (!bucket) return null;
    return bucket.get(keyOf(value)) ?? [];      // bucket 存在但无该值 → 空候选（合法）
  }

  exportFiles(): Map<string, string> {
    const out = new Map<string, string>();
    out.set(`${SYS.indexDir}/_manifest.json`, JSON.stringify({
      formatVersion: 1,
      indexes: [...this.data.entries()].flatMap(([c, m]) =>
        [...m.keys()].map(name => ({ collection: c, name, file: `${c}.${name}.idx.json` })))
    }, null, 2));
    for (const [c, m] of this.data) {
      for (const [name, entries] of m) {
        out.set(`${SYS.indexDir}/${c}.${name}.idx.json`, JSON.stringify({ entries }, null, 2));
      }
    }
    return out;
  }

  importFiles(files: Map<string, string>): void {
    this.data.clear();
    for (const [path, content] of files) {
      const m = /^_indexes\/(.+)\.([^.]+)\.idx\.json$/.exec(path);
      if (!m || m[1] === '_manifest') continue;
      try {
        const { entries } = JSON.parse(content);
        const c = m[1]!, name = m[2]!;
        if (!this.data.has(c)) this.data.set(c, new Map());
        this.data.get(c)!.set(name, new Map(Object.entries(entries)));
        this.healthy.set(c, true);
      } catch {
        this.healthy.set(m[1]!, false); // 损坏 → 降级（H2）
      }
    }
  }
}

function keyOf(v: any): string {
  return v === undefined || v === null ? '_null' : JSON.stringify(v);
}

function removeFrom(bucket: Map<string, string[]>, key: string, id: string): void {
  const arr = bucket.get(key);
  if (!arr) return;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
}
