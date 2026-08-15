import { describe, expect, it } from 'vitest';
import { applyUpdate } from './update.js';

describe('update 应用器（FR E4）', () => {
  const base: any = { _id: 'u1', name: 'Alice', age: 30, tags: ['a', 'b'], meta: { x: 1 } };

  it('$set（含点路径）与 $unset', () => {
    const d = applyUpdate(base, { $set: { name: 'A2', 'meta.y': 2 }, $unset: { age: true } });
    expect(d.name).toBe('A2');
    expect((d.meta as any).y).toBe(2);
    expect(d.age).toBeUndefined();
    expect(base.name).toBe('Alice'); // 不可变原对象
  });

  it('$inc 数值自增；非数值报错', () => {
    expect(applyUpdate(base, { $inc: { age: 1 } }).age).toBe(31);
    expect(() => applyUpdate(base, { $inc: { name: 1 } })).toThrow(/not numeric/);
  });

  it('$push / $pull / $addToSet', () => {
    expect(applyUpdate(base, { $push: { tags: 'c' } }).tags).toEqual(['a', 'b', 'c']);
    expect(applyUpdate(base, { $pull: { tags: 'a' } }).tags).toEqual(['b']);
    expect(applyUpdate(base, { $addToSet: { tags: 'a' } }).tags).toEqual(['a', 'b']); // 已存在不加
    expect(applyUpdate(base, { $addToSet: { tags: 'z' } }).tags).toEqual(['a', 'b', 'z']);
  });

  it('未知操作符拒绝', () => {
    expect(() => applyUpdate(base, { $rename: { a: 'b' } } as any)).toThrow(/unknown update operator/);
  });
});
