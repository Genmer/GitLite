// _rev：文档规范化 JSON（键排序，剔除 _rev）的 SHA-1 前 12 位（FR D4，算法已冻结）
import type { CryptoAdapter } from '../runtime.js';
import type { Document } from '../types.js';

export function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => k !== '_rev').sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function computeRev(crypto: CryptoAdapter, doc: Document): string {
  return crypto.sha1hex(canonicalJson(doc)).slice(0, 12);
}
