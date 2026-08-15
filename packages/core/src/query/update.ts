// update 应用器（FR E4）：$set $unset $inc $push $pull $addToSet
import { GitLiteError } from '../errors.js';
import type { Document, Update } from '../types.js';

const OPS = new Set(['$set', '$unset', '$inc', '$push', '$pull', '$addToSet']);

export function applyUpdate(doc: Document, update: Update): Document {
  for (const k of Object.keys(update)) {
    if (!OPS.has(k)) throw new GitLiteError('BAD_UPDATE', `unknown update operator "${k}"`);
  }
  const next: Document = structuredClone(doc) as Document;

  for (const [field, v] of Object.entries(update.$set ?? {})) {
    setPath(next, field, v as any);
  }
  for (const field of Object.keys(update.$unset ?? {})) {
    deletePath(next, field);
  }
  for (const [field, delta] of Object.entries(update.$inc ?? {})) {
    const cur = getPath(next, field);
    if (typeof cur !== 'number' || typeof delta !== 'number') {
      throw new GitLiteError('BAD_UPDATE', `$inc: field "${field}" is not numeric`);
    }
    setPath(next, field, cur + delta);
  }
  for (const [field, item] of Object.entries(update.$push ?? {})) {
    const cur = getPath(next, field);
    if (!Array.isArray(cur)) throw new GitLiteError('BAD_UPDATE', `$push: field "${field}" is not array`);
    cur.push(item as any);
  }
  for (const [field, item] of Object.entries(update.$pull ?? {})) {
    const cur = getPath(next, field);
    if (!Array.isArray(cur)) throw new GitLiteError('BAD_UPDATE', `$pull: field "${field}" is not array`);
    const kept = cur.filter(v => !deepEq(v, item));
    cur.length = 0; cur.push(...kept);
  }
  for (const [field, item] of Object.entries(update.$addToSet ?? {})) {
    const cur = getPath(next, field);
    if (!Array.isArray(cur)) throw new GitLiteError('BAD_UPDATE', `$addToSet: field "${field}" is not array`);
    if (!cur.some(v => deepEq(v, item))) cur.push(item as any);
  }
  return next;
}

function getPath(obj: any, path: string): any {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setPath(obj: any, path: string, value: any): void {
  const segs = path.split('.');
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    if (cur[seg] === undefined || cur[seg] === null) cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]!] = value;
}

function deletePath(obj: any, path: string): void {
  const segs = path.split('.');
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    if (cur === undefined || cur === null) return;
    cur = cur[seg];
  }
  if (cur !== undefined && cur !== null) delete cur[segs[segs.length - 1]!];
}

function deepEq(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
