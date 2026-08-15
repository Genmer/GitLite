import { describe, expect, it } from 'vitest';
import { Ulid, ulidTimestamp } from './model/ulid.js';
import { canonicalJson, computeRev } from './model/rev.js';
import { createTestRuntime } from './test/runtime.js';

describe('ULID（FR D2）', () => {
  const rt = createTestRuntime();
  const ulid = new Ulid(rt.crypto);

  it('生成 26 字符规范 ULID', () => {
    const id = ulid.generate();
    expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    expect(ulidTimestamp(id)).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('同毫秒批量生成不冲突且有序', () => {
    const now = Date.now();
    const ids = Array.from({ length: 1000 }, () => ulid.generate(now));
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids); // 时间相同 → 单调递增 → 字典序=生成序
  });

  it('时间有序（跨毫秒）', () => {
    const a = ulid.generate(1000);
    const b = ulid.generate(2000);
    expect(a < b).toBe(true);
  });
});

describe('_rev（FR D4，算法冻结）', () => {
  const rt = createTestRuntime();

  it('同内容同 rev；任何字段变更 rev 改变', () => {
    const doc: any = { _id: 'x', email: 'a@x.com', age: 30 };
    const rev1 = computeRev(rt.crypto, doc);
    expect(computeRev(rt.crypto, { ...doc })).toBe(rev1);
    doc.age = 31;
    expect(computeRev(rt.crypto, doc)).not.toBe(rev1);
  });

  it('_rev 字段自身不参与哈希；键序无关', () => {
    const a: any = { _id: 'x', a: 1, b: 2 };
    const b: any = { b: 2, a: 1, _id: 'x' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(computeRev(rt.crypto, a)).toBe(computeRev(rt.crypto, { ...a, _rev: 'zzz' }));
  });
});
