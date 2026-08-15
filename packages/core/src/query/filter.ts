// filter 求值器（FR E2）：$eq $ne $gt $gte $lt $lte $in $nin $exists $regex
//                    $and $or $not + 点路径；数组字段等值=包含匹配（Mongo 语义）
import type { Document, Filter } from '../types.js';

export function getPath(doc: any, path: string): any {
  if (path.includes('.')) {
    const [head, ...rest] = path.split('.');
    if (head!.includes('[')) return undefined; // v0.1 不支持下标路径
    return getPath(doc?.[head!], rest.join('.'));
  }
  return doc?.[path];
}

export function matches(doc: Document, filter: Filter | undefined): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;

  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!((cond as Filter[]).every(f => matches(doc, f)))) return false;
      continue;
    }
    if (key === '$or') {
      if (!((cond as Filter[]).some(f => matches(doc, f)))) return false;
      continue;
    }
    if (key === '$not') {
      if (matches(doc, cond as Filter)) return false;
      continue;
    }

    const value = getPath(doc, key);

    if (isOperator(cond)) {
      if (!matchOperator(value, cond as Record<string, any>, key)) return false;
    } else if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) {
      // 裸对象 = 嵌套 filter（Mongo 简写）或混合操作符对象
      for (const [sub, subCond] of Object.entries(cond as Record<string, any>)) {
        if (sub.startsWith('$')) continue; // 已由 isOperator 分支处理
        if (!matches((value ?? {}) as Document, { [`${key}.${sub}`]: subCond } as Filter)) return false;
      }
      // 检查对象内是否还有 $ 操作符要对该 key 整体求值
      const ops = pickOperators(cond);
      if (ops && !matchOperator(value, ops, key)) return false;
    } else {
      // 等值：标量相等 或 数组包含
      if (!eqOrIncludes(value, cond)) return false;
    }
  }
  return true;
}

function pickOperators(obj: Record<string, any>): Record<string, any> | null {
  const ops: Record<string, any> = {};
  let has = false;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('$')) { ops[k] = v; has = true; }
  }
  return has ? ops : null;
}

function isOperator(cond: any): boolean {
  return typeof cond === 'object' && cond !== null && !Array.isArray(cond) &&
    Object.keys(cond).length > 0 &&
    Object.keys(cond).every(k => k.startsWith('$'));
}

function eqOrIncludes(value: any, target: any): boolean {
  if (Array.isArray(value)) {
    return value.some(v => v === target || (typeof v === 'object' && JSON.stringify(v) === JSON.stringify(target)));
  }
  return value === target || (value !== null && target !== null && typeof value === 'object' &&
    JSON.stringify(value) === JSON.stringify(target));
}

function matchOperator(value: any, op: Record<string, any>, field: string): boolean {
  for (const [opName, opVal] of Object.entries(op)) {
    switch (opName) {
      case '$eq': if (!eqOrIncludes(value, opVal)) return false; break;
      case '$ne': if (eqOrIncludes(value, opVal)) return false; break;
      case '$gt': if (!(compare(value, opVal) > 0)) return false; break;
      case '$gte': if (!(compare(value, opVal) >= 0)) return false; break;
      case '$lt': if (!(compare(value, opVal) < 0)) return false; break;
      case '$lte': if (!(compare(value, opVal) <= 0)) return false; break;
      case '$in': {
        const arr = opVal as any[];
        const hit = arr.some(v => eqOrIncludes(value, v));
        if (!hit) return false;
        break;
      }
      case '$nin': {
        const arr = opVal as any[];
        if (arr.some(v => eqOrIncludes(value, v))) return false;
        break;
      }
      case '$exists': {
        const exists = value !== undefined; // null 算存在（Mongo 语义）
        if (opVal && !exists) return false;
        if (!opVal && exists) return false;
        break;
      }
      case '$regex': {
        if (typeof value !== 'string') return false;
        const flags = (op.$options as string) ?? '';
        if (!new RegExp(opVal as string, flags).test(value)) return false;
        break;
      }
      case '$options': break; // 与 $regex 配对消费
      default:
        throw new Error(`unsupported filter operator "${opName}" on field "${field}" (v0.1)`);
    }
  }
  return true;
}

function compare(a: any, b: any): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a !== typeof b) {
    throw new Error(`cannot compare ${typeof a} with ${typeof b}`);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
