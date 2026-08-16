// 最小查询计划器（P2：SQLite 代价优化器对位的第一步）：
// 单一事实源——既决定实际访问路径（index-eq / index-range / full-scan），也供 explain 内省。
// 统计信息：内存索引直接给出候选基数（精确），totalRows 由镜像行数给出。
import type { IndexManager } from '../index/manager.js';
import type { Filter } from '../types.js';

export type AccessPath = 'index-eq' | 'index-range' | 'index-composite' | 'full-scan';

export interface QueryPlan {
  collection: string;
  accessPath: AccessPath;
  /** 命中索引的字段（index-* 路径；复合为逗号连接的前缀字段） */
  field?: string;
  /** 预估扫描行数（index-* 为精确候选基数；full-scan 为全表行数） */
  estimatedRows: number;
  totalRows: number;
  /** 是否走索引（selective=true 表示命中索引且候选 < 全表） */
  selective: boolean;
  filter: Filter;
}

export interface Selection {
  plan: QueryPlan;
  /** 候选 id 集；null = 计划器判定无法走索引（调用方降级全表） */
  ids: string[] | null;
}

/** 含 $ 操作符键的条件对象（非普通对象等值/嵌套简写） */
function isOp(v: any): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) &&
    Object.keys(v).some(k => k.startsWith('$'));
}

/** 生成访问计划：复合等值 > 单字段等值 > 范围 > 全表 */
export function select(indexMgr: IndexManager, totalRows: number, c: string, filter?: Filter): Selection {
  const base: Omit<QueryPlan, 'accessPath' | 'estimatedRows' | 'selective'> = {
    collection: c, totalRows, filter: filter ?? {}
  };
  if (!filter || Object.keys(filter).length === 0) {
    return {
      plan: { ...base, accessPath: 'full-scan', estimatedRows: totalRows, selective: false },
      ids: null
    };
  }
  // 收集顶层等值字段（裸标量 或 {$eq}）
  const eqValues = new Map<string, any>();
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) continue;
    if (isOp(v)) {
      if ('$eq' in (v as any)) eqValues.set(k, (v as any).$eq);
    } else {
      eqValues.set(k, v);
    }
  }
  // 0) 复合索引最左前缀等值（多个等值条件 AND 时选择性最优）
  if (eqValues.size > 1) {
    const ids = indexMgr.compositeCandidates(c, eqValues);
    if (ids !== null) {
      return {
        plan: {
          ...base, accessPath: 'index-composite',
          field: [...eqValues.keys()].join(','),
          estimatedRows: ids.length, selective: ids.length < totalRows
        },
        ids
      };
    }
  }
  // 1) 单字段等值走索引点查
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) continue;
    if (isOp(v) && !('$eq' in (v as any))) continue;   // 其他操作符让位给范围/全表
    const value = isOp(v) ? (v as any).$eq : v;
    const ids = indexMgr.candidates(c, k, value);
    if (ids !== null) {
      return {
        plan: { ...base, accessPath: 'index-eq', field: k, estimatedRows: ids.length, selective: ids.length < totalRows },
        ids
      };
    }
  }
  // 2) 范围（$gt/$gte/$lt/$lte）走索引二分扫描
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) continue;
    if (!isOp(v)) continue;
    const ids = indexMgr.rangeCandidates(c, k, v as Record<string, any>);
    if (ids !== null) {
      return {
        plan: { ...base, accessPath: 'index-range', field: k, estimatedRows: ids.length, selective: ids.length < totalRows },
        ids
      };
    }
  }
  // 3) 全表
  return {
    plan: { ...base, accessPath: 'full-scan', estimatedRows: totalRows, selective: false },
    ids: null
  };
}
