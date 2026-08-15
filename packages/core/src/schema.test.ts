import { describe, expect, it } from 'vitest';
import { SchemaValidator } from './schema/validate.js';
import { parseJsonc } from './schema/jsonc.js';

const v = new SchemaValidator();

const userSchema = {
  type: 'object',
  properties: {
    _id: { type: 'string' },
    email: { type: 'string', format: 'email', maxLength: 254 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    role: { enum: ['admin', 'user'] },
    tags: { type: 'array', items: { type: 'string' } },
    address: { type: 'object', properties: { zip: { type: 'string', pattern: '^\\d{6}$' } } }
  },
  required: ['_id', 'email']
};

describe('Schema 校验器（FR D1）', () => {
  it('合法文档通过', () => {
    const issues = v.validate({
      _id: 'a', email: 'a@x.com', age: 30, role: 'admin',
      tags: ['x'], address: { zip: '200000' }
    }, userSchema);
    expect(issues).toEqual([]);
  });

  it('类型错误带路径', () => {
    const issues = v.validate({ _id: 'a', email: 'a@x.com', age: 'old' }, userSchema);
    expect(issues.some(i => i.path === 'age' && /expected integer/.test(i.message))).toBe(true);
  });

  it('required 缺失 / enum / format / pattern / min-max', () => {
    expect(v.validate({ _id: 'a' }, userSchema).some(i => /missing required "email"/.test(i.message))).toBe(true);
    expect(v.validate({ _id: 'a', email: 'a@x.com', role: 'nope' }, userSchema).some(i => /one of/.test(i.message))).toBe(true);
    expect(v.validate({ _id: 'a', email: 'not-email' }, userSchema).some(i => /email format/.test(i.message))).toBe(true);
    expect(v.validate({ _id: 'a', email: 'a@x.com', address: { zip: '12' } }, userSchema).some(i => /pattern/.test(i.message))).toBe(true);
    expect(v.validate({ _id: 'a', email: 'a@x.com', age: 200 }, userSchema).some(i => /> maximum/.test(i.message))).toBe(true);
  });

  it('数组元素逐项校验', () => {
    const issues = v.validate({ _id: 'a', email: 'a@x.com', tags: ['ok', 42] }, userSchema);
    expect(issues.some(i => i.path === 'tags[1]')).toBe(true);
  });

  it('未支持关键字明确报错（不静默）', () => {
    const issues = v.validate({}, { $ref: '#/x', type: 'object' });
    expect(issues.some(i => /unsupported schema keyword "\$ref"/.test(i.message))).toBe(true);
  });

  it('x-gitlite-* 扩展被忽略', () => {
    expect(v.validate({ _id: 'a' }, { type: 'object', properties: { _id: { type: 'string', 'x-gitlite-unique': true } } }, )).toEqual([]);
  });
});

describe('JSONC 解析', () => {
  it('剥离行/块注释与尾逗号容忍', () => {
    expect(parseJsonc('{ // hi\n"a": 1 /* c */, }')).toEqual({ a: 1 });
  });
});
