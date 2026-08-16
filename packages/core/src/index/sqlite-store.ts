// P4 本地 SQLite 索引后端（docs/08 §六 / docs/14 P4，内圈唯一「换部件」项）：
// - 突破全内存镜像（Pager 分页缓存对位）：索引条目落盘，数据 > 内存时索引不占 JS 堆
// - 重启 / 未变 pull：docHash 指纹命中 → 跳过全量重建（启动 O(未变) 而非 O(全表)）
// - 仓库仍是唯一事实源（ADR-002）：_indexes/*.idx.json 照常随数据 commit、格式不变；
//   本库是可丢弃的本地缓存——删 index.db 后下次启动 importFiles + rebuild 全量重建
// - core 零 node 依赖（FR I4）：SqliteDb 由宿主经 RuntimeAdapter.sqlite 注入（node:sqlite 等）
// 键编码与内存后端完全一致（keys.ts），等值/复合/范围语义对齐（差异见 manager.rangeCandidates 注）。
import { UniqueConstraintError } from '../errors.js';
import type { SqliteDb } from '../runtime.js';
import type { Document } from '../types.js';
import type { IndexDef, IndexStore } from './manager.js';
import { displayValue, entryKey, indexFilePath, isNumericKey, keyOf, rawOf, renderIndexJson } from './keys.js';

const DDL = `
CREATE TABLE IF NOT EXISTS idx_def (
  collection TEXT NOT NULL,
  name       TEXT NOT NULL,
  numeric    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection, name)
);
CREATE TABLE IF NOT EXISTS idx_entry (
  collection TEXT NOT NULL,
  name       TEXT NOT NULL,
  k          TEXT NOT NULL,
  kn         REAL,
  id         TEXT NOT NULL,
  PRIMARY KEY (collection, name, k, id)
);
CREATE INDEX IF NOT EXISTS idx_entry_num ON idx_entry (collection, name, kn);
CREATE TABLE IF NOT EXISTS idx_meta (
  collection TEXT PRIMARY KEY,
  defsFp      TEXT,
  xor1        INTEGER NOT NULL DEFAULT 0,
  xor2        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS idx_file (
  path    TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
`;

export class SqliteIndexStore implements IndexStore {
  readonly kind = 'sqlite' as const;
  /** entries 变更后待重渲染的索引（c::name）；导入/渲染后即与缓存一致，清除 */
  private stale = new Set<string>();

  constructor(private db: SqliteDb) {
    db.exec(DDL);
  }

  rebuild(c: string, defs: IndexDef[], docs: Document[]): void {
    const fp = fingerprint(defs, docs);
    // 分页缓存核心收益：当前 docs 与索引内容一致（指纹命中）→ 跳过全量重建
    if (this.fingerprintOf(c) === fp && this.indexNames(c).length === defs.length) return;
    this.tx(() => {
      this.db.run('DELETE FROM idx_entry WHERE collection = ?', [c]);
      this.db.run('DELETE FROM idx_def WHERE collection = ?', [c]);
      for (const def of defs) {
        const rows = docs.map(d => ({ k: entryKey(def, d), id: d._id }));
        const numeric = rows.length > 0 && rows.every(({ k }) => isNumericKey(k));
        this.db.run('INSERT INTO idx_def (collection, name, numeric) VALUES (?, ?, ?)',
          [c, def.name, numeric ? 1 : 0]);
        for (const { k, id } of rows) {
          this.db.run('INSERT OR IGNORE INTO idx_entry (collection, name, k, kn, id) VALUES (?, ?, ?, ?, ?)',
            [c, def.name, k, numeric ? Number(rawOf(k)) : null, id]);
        }
        this.stale.add(ref(c, def.name));
      }
      this.saveFingerprint(c, fp);
    });
  }

  onWrite(c: string, defs: IndexDef[], before: Document | null, after: Document | null): void {
    const numeric = this.numericByName(c);
    if (numeric.size === 0) return; // 索引未构建（rebuild 前）——由 rebuild 全量补齐（与内存后端一致）
    this.tx(() => {
      for (const def of defs) {
        const num = numeric.get(def.name);
        if (num === undefined) continue; // 该索引未构建（schema 新增索引且尚未 rebuild）
        if (before) {
          this.db.run('DELETE FROM idx_entry WHERE collection = ? AND name = ? AND k = ? AND id = ?',
            [c, def.name, entryKey(def, before), before._id]);
        }
        if (after) {
          const k = entryKey(def, after);
          if (def.unique) this.assertFree(c, def, k, after);
          this.db.run('INSERT OR IGNORE INTO idx_entry (collection, name, k, kn, id) VALUES (?, ?, ?, ?, ?)',
            [c, def.name, k, num ? Number(rawOf(k)) : null, after._id]);
        }
        this.stale.add(ref(c, def.name));
      }
      // 指纹增量维护：XOR 累积可交换 → onWrite 后指纹仍等价于「按当前 docs 全量计算」。
      // 注：SQLite 无 ^ 运算符，XOR 在 JS 侧完成（读-算-写）。
      let x1 = 0, x2 = 0;
      if (before) { const [a, b] = perDocFp(defs, before); x1 = (x1 ^ a) >>> 0; x2 = (x2 ^ b) >>> 0; }
      if (after) { const [a, b] = perDocFp(defs, after); x1 = (x1 ^ a) >>> 0; x2 = (x2 ^ b) >>> 0; }
      const meta = this.db.all('SELECT xor1, xor2 FROM idx_meta WHERE collection = ?', [c])[0];
      if (meta) {
        this.db.run('UPDATE idx_meta SET xor1 = ?, xor2 = ? WHERE collection = ?',
          [(((meta.xor1 ?? 0) >>> 0) ^ x1) >>> 0, (((meta.xor2 ?? 0) >>> 0) ^ x2) >>> 0, c]);
      }
    });
  }

  checkUnique(c: string, defs: IndexDef[], doc: Document): void {
    for (const def of defs) {
      this.assertFree(c, def, entryKey(def, doc), doc);
    }
  }

  eq(c: string, def: IndexDef, key: string): string[] | null {
    if (!this.hasDef(c, def.name)) return null; // 未构建 → 查询层降级全表
    return this.db.all('SELECT id FROM idx_entry WHERE collection = ? AND name = ? AND k = ? ORDER BY id',
      [c, def.name, key]).map(r => r.id as string);
  }

  range(c: string, def: IndexDef, b: { gt?: any; gte?: any; lt?: any; lte?: any }): string[] | null {
    if (!this.hasDef(c, def.name)) return null;
    const numeric = !!this.numericByName(c).get(def.name);
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const [op, sql] of [['gt', '>'], ['gte', '>='], ['lt', '<'], ['lte', '<=']] as const) {
      const v = b[op];
      if (v === undefined) continue;
      const e = numeric ? Number(v) : keyOf(v);
      if (numeric && !isFinite(e as number)) return null; // 数值索引遇非数值边界 → 降级全表（宁全勿漏）
      conds.push(`${numeric ? 'kn' : 'k'} ${sql} ?`);
      params.push(e);
    }
    const order = numeric ? 'ORDER BY kn, k, id' : 'ORDER BY k, id';
    return this.db.all(
      `SELECT id FROM idx_entry WHERE collection = ? AND name = ? AND ${conds.join(' AND ')} ${order}`,
      [c, def.name, ...params]).map(r => r.id as string);
  }

  builtCollections(): string[] {
    return this.db.all('SELECT DISTINCT collection FROM idx_def').map(r => r.collection as string);
  }

  indexNames(c: string): string[] {
    return this.db.all('SELECT name FROM idx_def WHERE collection = ? ORDER BY rowid', [c])
      .map(r => r.name as string);
  }

  renderIndex(c: string, name: string): string | null {
    if (!this.hasDef(c, name)) return null;
    const path = indexFilePath(c, name);
    // 未变更 → 直接服上次渲染内容（flush 只重渲染脏表索引，P1b 语义在 SQLite 后端延续）
    if (!this.stale.has(ref(c, name))) {
      const hit = this.db.all('SELECT content FROM idx_file WHERE path = ?', [path])[0];
      if (hit) return hit.content as string;
    }
    const numeric = !!this.numericByName(c).get(name);
    const order = numeric ? 'ORDER BY kn, k, id' : 'ORDER BY k, id';
    const rows = this.db.all(`SELECT k, id FROM idx_entry WHERE collection = ? AND name = ? ${order}`, [c, name]);
    const entries = new Map<string, string[]>();
    for (const r of rows) {
      const k = r.k as string;
      if (!entries.has(k)) entries.set(k, []);
      entries.get(k)!.push(r.id as string);
    }
    const content = renderIndexJson(entries);
    this.db.run('INSERT OR REPLACE INTO idx_file (path, content) VALUES (?, ?)', [path, content]);
    this.stale.delete(ref(c, name));
    return content;
  }

  importFiles(files: Map<string, string>, onHealth: (c: string, ok: boolean) => void): void {
    const idxFiles: Array<[string, string, string]> = []; // [path, collection, content]
    for (const [path, content] of files) {
      const m = /^_indexes\/(.+)\.([^.]+)\.idx\.json$/.exec(path);
      if (m && m[1] !== '_manifest') idxFiles.push([path, m[1]!, content]);
    }
    // 零工作快路径：全部 idx 文件与上次渲染缓存逐字节一致（重启/未变 pull）——
    // 条目与缓存均已是当前内容，免解析免写入；配合 rebuild 的指纹命中 = 启动 O(未变)
    const cached = new Map(this.db.all('SELECT path, content FROM idx_file')
      .map(r => [r.path as string, r.content as string]));
    if (idxFiles.length > 0 && cached.size === idxFiles.length &&
        idxFiles.every(([p, , c]) => cached.get(p) === c)) {
      for (const [, c] of idxFiles) onHealth(c, true);
      return;
    }
    this.tx(() => {
      this.db.run('DELETE FROM idx_entry');
      this.db.run('DELETE FROM idx_def');
      this.db.run('DELETE FROM idx_file');
      for (const [path, c, content] of idxFiles) {
        try {
          const name = /^_indexes\/(.+)\.([^.]+)\.idx\.json$/.exec(path)![2]!;
          const { entries } = JSON.parse(content) as { entries?: Record<string, string[]> };
          const keys = Object.keys(entries ?? {});
          const numeric = keys.length > 0 && keys.every(isNumericKey);
          this.db.run('INSERT INTO idx_def (collection, name, numeric) VALUES (?, ?, ?)',
            [c, name, numeric ? 1 : 0]);
          for (const [k, ids] of Object.entries(entries ?? {})) {
            for (const id of ids ?? []) {
              this.db.run('INSERT OR IGNORE INTO idx_entry (collection, name, k, kn, id) VALUES (?, ?, ?, ?, ?)',
                [c, name, k, numeric ? Number(rawOf(k)) : null, id]);
            }
          }
          this.db.run('INSERT INTO idx_file (path, content) VALUES (?, ?)', [path, content]);
          onHealth(c, true);
        } catch {
          onHealth(c, false); // 损坏 → 降级（H2）
        }
      }
    });
    this.stale.clear();
  }

  close(): void {
    this.db.close();
  }

  // ---------- 内部 ----------

  private assertFree(c: string, def: IndexDef, k: string, doc: Document): void {
    const rows = this.db.all('SELECT id FROM idx_entry WHERE collection = ? AND name = ? AND k = ?',
      [c, def.name, k]);
    if (rows.some(r => r.id !== doc._id)) {
      throw new UniqueConstraintError(def.name, displayValue(def, doc));
    }
  }

  private hasDef(c: string, name: string): boolean {
    return this.db.all('SELECT 1 FROM idx_def WHERE collection = ? AND name = ? LIMIT 1', [c, name]).length > 0;
  }

  private fingerprintOf(c: string): string | null {
    const row = this.db.all('SELECT defsFp, xor1, xor2 FROM idx_meta WHERE collection = ?', [c])[0];
    return row ? `${row.defsFp ?? ''}:${(row.xor1 >>> 0).toString(16)}-${(row.xor2 >>> 0).toString(16)}` : null;
  }

  private saveFingerprint(c: string, fp: string): void {
    const [defsFp, rest] = fp.split(':');
    const [a, b] = rest!.split('-');
    this.db.run('INSERT OR REPLACE INTO idx_meta (collection, defsFp, xor1, xor2) VALUES (?, ?, ?, ?)',
      [c, defsFp!, parseInt(a!, 16) >>> 0, parseInt(b!, 16) >>> 0]);
  }

  private numericByName(c: string): Map<string, boolean> {
    return new Map(this.db.all('SELECT name, numeric FROM idx_def WHERE collection = ?', [c])
      .map(r => [r.name as string, !!r.numeric]));
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

function ref(c: string, name: string): string {
  return `${c}::${name}`;
}

/** 集合指纹 = defs 指纹 + 文档集合的 XOR 累积指纹（可交换 → onWrite 可增量维护）。
 *  rebuild 前比对：指纹命中 = 索引内容已与当前 docs 一致 → 跳过全量重建（P4 快路径）。 */
function fingerprint(defs: IndexDef[], docs: Document[]): string {
  const defsFp = fnvHex(defs.map(d => `${d.name}|${d.fields.join(',')}|${d.unique ? 1 : 0}`).join('||'));
  let x1 = 0, x2 = 0;
  for (const doc of docs) {
    const [a, b] = perDocFp(defs, doc);
    x1 = (x1 ^ a) >>> 0;
    x2 = (x2 ^ b) >>> 0;
  }
  return `${defsFp}:${x1.toString(16)}-${x2.toString(16)}`;
}

/** 单文档指纹分量（覆盖全部 defs 的 entryKey；与 fingerprint 全量计算保持同一形式） */
function perDocFp(defs: IndexDef[], doc: Document): [number, number] {
  const s = `${doc._id}=` + defs.map(def => entryKey(def, doc)).join(';');
  return fnv(s);
}

/** FNV-1a 双种子（32bit×2）：返回两半数值；hex 形式用于 defs 指纹 */
function fnv(s: string): [number, number] {
  let h1 = 0x811c9dc5, h2 = 0x9dc5811f;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((ch + i) & 0xffff), 0x85ebca6b) >>> 0;
  }
  return [h1, h2];
}

function fnvHex(s: string): string {
  const [a, b] = fnv(s);
  return `${a.toString(16)}-${b.toString(16)}`;
}
