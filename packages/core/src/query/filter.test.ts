import { describe, expect, it } from 'vitest';
import { matches } from './filter.js';

const doc: any = {
  _id: 'u1', email: 'alice@x.com', name: 'Alice', age: 30,
  role: 'admin', tags: ['staff', 'early'],
  address: { city: 'Shanghai', zip: '200000' },
  score: null
};

describe('filter 求值器（FR E2）', () => {
  it('隐式等值 + 数组包含（Mongo 语义）', () => {
    expect(matches(doc, { email: 'alice@x.com' })).toBe(true);
    expect(matches(doc, { tags: 'staff' })).toBe(true);
    expect(matches(doc, { tags: 'nope' })).toBe(false);
  });

  it('比较操作符', () => {
    expect(matches(doc, { age: { $gte: 18, $lt: 60 } })).toBe(true);
    expect(matches(doc, { age: { $gt: 30 } })).toBe(false);
    expect(matches(doc, { age: { $ne: 31 } })).toBe(true);
  });

  it('$in / $nin', () => {
    expect(matches(doc, { role: { $in: ['admin', 'owner'] } })).toBe(true);
    expect(matches(doc, { role: { $nin: ['admin'] } })).toBe(false);
  });

  it('$exists（null 算存在）', () => {
    expect(matches(doc, { score: { $exists: true } })).toBe(true);
    expect(matches(doc, { missing: { $exists: false } })).toBe(true);
  });

  it('$regex + $options', () => {
    expect(matches(doc, { name: { $regex: '^al', $options: 'i' } })).toBe(true);
    expect(matches(doc, { email: { $regex: '@x\\.com$' } })).toBe(true);
  });

  it('$and / $or / $not', () => {
    expect(matches(doc, { $and: [{ age: { $gte: 18 } }, { $or: [{ role: 'admin' }, { role: 'user' }] }] })).toBe(true);
    expect(matches(doc, { $not: { age: { $lt: 18 } } })).toBe(true);
  });

  it('点路径嵌套', () => {
    expect(matches(doc, { 'address.city': 'Shanghai' })).toBe(true);
    expect(matches(doc, { 'address.zip': { $regex: '^200' } })).toBe(true);
    expect(matches(doc, { 'address.city': 'Beijing' })).toBe(false);
  });

  it('空 filter 全匹配；未知操作符报错', () => {
    expect(matches(doc, {})).toBe(true);
    expect(() => matches(doc, { age: { $weird: 1 } as any })).toThrow(/unsupported filter operator/);
  });
});
