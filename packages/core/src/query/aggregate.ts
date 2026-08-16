// 聚合管道（P2：SQLite GROUP BY/聚合对位）：$match/$group/$sort/$skip/$limit/$project/$count
// v0.2 范围：$group 支持 $sum/$avg/$min/$max/$push；_id 支持 "$field"/null；嵌套路径走点路径。
// $first/$last 依赖排序后分组语义，留待 v0.3。
import { matches } from './filter.js';

export type AggStage =
  | { $match?: Record<string, any> }
  | { $group?: { _id: any; [k: string]: any } }
  | { $sort?: Record<string, 1 | -1> }
  | { $skip?: number }
  | { $limit?: number }
  | { $project?: Record<string, any> }
  | { $count?: string };

type AccFn =
  | { kind: 'sum'; field?: string; literal?: number }
  | { kind: 'avg'; field: string }
  | { kind: 'min'; field: string }
  | { kind: 'max'; field: string }
  | { kind: 'push'; field: string };

export function aggregate(docs: Array<Record<string, any>>, pipeline: AggStage[]): Array<Record<string, any>> {
  let cur: Array<Record<string, any>> = docs;
  for (const stage of pipeline) {
    const s = stage as Record<string, any>;             // 联合类型按 key 收窄不可靠，统一 cast
    const key = Object.keys(s)[0]!;
    switch (key) {
      case '$match': cur = cur.filter(d => matches(d as any, s.$match)); break;
      case '$group': cur = group(cur, s.$group); break;
      case '$sort': cur = sortDocs(cur, s.$sort); break;
      case '$skip': cur = cur.slice(s.$skip ?? 0); break;
      case '$limit': cur = cur.slice(0, s.$limit ?? 0); break;
      case '$project': cur = cur.map(d => projectDoc(d, s.$project)); break;
      case '$count': {
        const name = s.$count ?? 'count';
        cur = [{ _id: 1, [name]: cur.length }];
        break;
      }
      default: throw new Error(`unsupported aggregation stage "${key}"`);
    }
  }
  return cur;
}

// ---------- $group ----------

function group(docs: Array<Record<string, any>>, spec: { _id: any; [k: string]: any }): Array<Record<string, any>> {
  const accSpec = { ...spec } as Record<string, any>;
  delete accSpec._id;
  const groups = new Map<string, { key: any; acc: Record<string, any> }>();
  for (const d of docs) {
    const key = groupKey(spec._id, d);
    const k = JSON.stringify(key);
    let g = groups.get(k);
    if (!g) {
      g = { key, acc: {} };
      for (const [name, expr] of Object.entries(accSpec)) {
        const fn = accOf(expr);
        g.acc[name] = initAcc(fn);
      }
      groups.set(k, g);
    }
    for (const [name, expr] of Object.entries(accSpec)) {
      applyAcc(g.acc, name, accOf(expr), d);
    }
  }
  return [...groups.values()].map(g => {
    const out: Record<string, any> = { _id: g.key };
    for (const [name, v] of Object.entries(g.acc)) {
      out[name] = finalizeAcc(accOf(accSpec[name]!), v);
    }
    return out;
  });
}

function groupKey(idSpec: any, d: Record<string, any>): any {
  if (typeof idSpec === 'string' && idSpec.startsWith('$')) {
    const path = idSpec.slice(1);
    return path === 'ROOT' ? d : getPath(d, path);
  }
  if (idSpec === null || idSpec === undefined) return null;   // 单组聚合
  return idSpec;                                              // 字面量（恒等分组键）
}

function accOf(expr: any): AccFn {
  if (typeof expr === 'number') return { kind: 'sum', literal: expr };
  if (expr && typeof expr === 'object') {
    const op = Object.keys(expr)[0]!;
    const arg = (expr as any)[op];
    switch (op) {
      case '$sum': return typeof arg === 'number' ? { kind: 'sum', literal: arg } : { kind: 'sum', field: pathOf(arg) };
      case '$avg': return { kind: 'avg', field: pathOf(arg) };
      case '$min': return { kind: 'min', field: pathOf(arg) };
      case '$max': return { kind: 'max', field: pathOf(arg) };
      case '$push': return { kind: 'push', field: pathOf(arg) };
    }
  }
  throw new Error(`unsupported accumulator expression: ${JSON.stringify(expr)}`);
}

function pathOf(arg: any): string {
  return typeof arg === 'string' && arg.startsWith('$') ? arg.slice(1) : arg;
}

function initAcc(fn: AccFn): any {
  switch (fn.kind) {
    case 'sum': return 0;
    case 'avg': return { sum: 0, count: 0 };
    case 'min': return { has: false, v: undefined };
    case 'max': return { has: false, v: undefined };
    case 'push': return [];
  }
}

function applyAcc(acc: Record<string, any>, name: string, fn: AccFn, d: Record<string, any>): void {
  const value = fn.kind === 'sum' && fn.literal !== undefined ? fn.literal : getPath(d, fn.field ?? '');
  switch (fn.kind) {
    case 'sum': acc[name]! += value ?? 0; break;
    case 'avg':
      if (value !== undefined && value !== null) { acc[name]!.sum += value; acc[name]!.count++; }
      break;
    case 'min':
      if (value !== undefined && value !== null && (!acc[name]!.has || value < acc[name]!.v)) { acc[name] = { has: true, v: value }; }
      break;
    case 'max':
      if (value !== undefined && value !== null && (!acc[name]!.has || value > acc[name]!.v)) { acc[name] = { has: true, v: value }; }
      break;
    case 'push': acc[name]!.push(value); break;
  }
}

function finalizeAcc(fn: AccFn, v: any): any {
  switch (fn.kind) {
    case 'avg': return v.count ? v.sum / v.count : null;
    case 'min':
    case 'max': return v.has ? v.v : null;
    default: return v;
  }
}

// ---------- $sort / $project ----------

function sortDocs(docs: Array<Record<string, any>>, sort: Record<string, 1 | -1>): Array<Record<string, any>> {
  return [...docs].sort((a, b) => {
    for (const [k, dir] of Object.entries(sort)) {
      const av = getPath(a, k), bv = getPath(b, k);
      if (av === bv) continue;
      return (av > bv ? 1 : -1) * (dir === 1 ? 1 : -1);
    }
    return 0;
  });
}

function projectDoc(doc: Record<string, any>, spec: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const includes = Object.entries(spec).filter(([, v]) => v === 1).map(([k]) => k);
  if (includes.length) {
    for (const k of includes) out[k] = getPath(doc, k);
  } else {
    const excludes = Object.entries(spec).filter(([, v]) => v === 0).map(([k]) => k);
    for (const [k, v] of Object.entries(doc)) if (!excludes.includes(k)) out[k] = v;
  }
  // 计算字段：{newField: "$src"}
  for (const [k, v] of Object.entries(spec)) {
    if (typeof v === 'string' && v.startsWith('$')) out[k] = getPath(doc, v.slice(1));
    else if (v !== 1 && v !== 0) out[k] = v;   // 字面量
  }
  return out;
}

export function getPath(doc: any, path: string): any {
  if (!path) return undefined;
  if (path.includes('.')) {
    const [head, ...rest] = path.split('.');
    if (head!.includes('[')) return undefined;
    return getPath(doc?.[head!], rest.join('.'));
  }
  return doc?.[path];
}
