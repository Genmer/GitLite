// 索引键编码与文件渲染共享层（内存 / SQLite 双后端共用，P4）
import { SYS, type Document } from '../types.js';
import type { IndexDef } from './manager.js';

/** 索引值 → 可比较字符串键：null/undefined → '_null'；其余 JSON 编码（数字裸写、字符串带引号） */
export function keyOf(v: any): string {
  return v === undefined || v === null ? '_null' : JSON.stringify(v);
}

/** 数值 key（"5"）→ 原值；字符串 key（"\"a\""）→ 去引号 */
export function rawOf(k: string): string {
  return k.startsWith('"') && k.endsWith('"') ? k.slice(1, -1) : k;
}

/** 裸数值键判定（类型感知排序用）：排除 _null 与字符串键 */
export function isNumericKey(k: string): boolean {
  return k !== '_null' && !k.startsWith('"') && isFinite(Number(rawOf(k)));
}

/** 索引条目 key：单字段 = 值编码；复合 = 各字段值编码的 JSON 数组 */
export function entryKey(def: IndexDef, doc: Document | Record<string, any>): string {
  return def.fields.length === 1
    ? keyOf((doc as any)[def.fields[0]!])
    : JSON.stringify(def.fields.map(f => keyOf((doc as any)[f])));
}

/** 唯一冲突报错用的展示值（与 v0.2 前行为一致） */
export function displayValue(def: IndexDef, doc: Document | Record<string, any>): string {
  return def.fields.length === 1
    ? String((doc as any)[def.field])
    : JSON.stringify(def.fields.map(f => (doc as any)[f]));
}

/** in-band 索引文件路径（H3：随数据同 commit；ADR-002：格式不变） */
export function indexFilePath(c: string, name: string): string {
  return `${SYS.indexDir}/${c}.${name}.idx.json`;
}

/** idx.json 渲染：entries 为 value→ids 映射。
 *  修复注：曾直接 JSON.stringify(Map) 得 {"entries":{}}（空壳文件，靠启动 rebuild 兜底）——
 *  P4 起显式转对象，importFiles 本就按填充形态解析，新老客户端双向兼容。 */
export function renderIndexJson(entries: Map<string, string[]>): string {
  return JSON.stringify({ entries: Object.fromEntries(entries) }, null, 2);
}
