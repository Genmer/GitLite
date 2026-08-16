// codegen 测试：类型映射 / 生成结构（系统字段、必填约束、Input 形态）/ 确定性 / 目录读取与写出
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, generateFromDir, tsType, writeResult, type SchemaInput } from './index.js';

describe('tsType（JSON Schema → TS 类型）', () => {
  it('基础与组合映射', () => {
    expect(tsType({ type: 'string' })).toBe('string');
    expect(tsType({ type: 'integer' })).toBe('number');
    expect(tsType({ type: 'int' })).toBe('number');
    expect(tsType({ type: 'number' })).toBe('number');
    expect(tsType({ type: 'boolean' })).toBe('boolean');
    expect(tsType({ type: 'array', items: { type: 'string' } })).toBe('Array<string>');
    expect(tsType({ type: 'array' })).toBe('unknown[]');
    expect(tsType({ type: 'object' })).toBe('Record<string, unknown>');
    expect(tsType({ type: ['string', 'null'] })).toBe('string | null');
    expect(tsType({})).toBe('unknown');
    expect(tsType(null)).toBe('unknown');
  });
});

const users: SchemaInput = {
  name: 'users',
  schema: {
    type: 'object',
    gitliteDescriptor: { collection: 'users', timestamps: true },
    properties: {
      email: { type: 'string', 'x-gitlite-unique': true },
      age: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } }
    },
    required: ['email']
  }
};

describe('generate（types + client）', () => {
  it('types：系统字段注入、必填约束、Input 去系统字段', () => {
    const { types } = generate([users]);
    expect(types).toContain('export interface Users {');
    expect(types).toContain('  _id: string;');
    expect(types).toContain('  createdAt: string;');
    expect(types).toContain('  _rev?: string;');
    expect(types).toContain('  email: string;');
    expect(types).toContain('  age?: number;');
    expect(types).toContain('  tags?: Array<string>;');
    // Input：用户字段保持必填，系统字段剔除
    const input = types.slice(types.indexOf('export interface UsersInput'));
    expect(input).toContain('  email: string;');
    expect(input).not.toContain('_id');
    expect(input).not.toContain('createdAt');
    expect(input).not.toContain('_rev');
  });

  it('types：schema 已声明系统字段不重复；timestamps=false 不注入时间戳', () => {
    const declared = generate([{
      name: 'events',
      schema: {
        gitliteDescriptor: { timestamps: false },
        properties: { _id: { type: 'string' }, at: { type: 'string' } }
      }
    }]).types;
    expect(declared.match(/_id\??: string;/g)).toHaveLength(1);
    expect(declared).not.toContain('createdAt');
    expect(declared).not.toContain('updatedAt');
  });

  it('client：类型化成员 + connect 便捷函数', () => {
    const { client } = generate([users]);
    expect(client).toContain(`import { Collection, connect as sdkConnect } from '@gitlite/sdk';`);
    expect(client).toContain('readonly users: Collection<Users>;');
    expect(client).toContain(`this.users = db.collection<Users>('users');`);
    expect(client).toContain('export class TypedGitLiteClient');
    expect(client).toContain('export function connect(input: SdkConnectOptions | string)');
    expect(client).toContain('get raw(): GitLiteClient');
  });

  it('确定性：乱序输入 → 相同输出；非法字段名加引号', () => {
    const a = generate([users, { name: 'order-items', schema: { properties: { 'weird key': { type: 'string' } } } }]);
    const b = generate([{ name: 'order-items', schema: { properties: { 'weird key': { type: 'string' } } } }, users]);
    expect(a.types).toBe(b.types);
    expect(a.client).toBe(b.client);
    expect(a.types).toContain('"weird key"?: string;');
    expect(a.client).toContain(`this["order-items"] = db.collection<OrderItems>('order-items');`);
  });
});

describe('generateFromDir / writeResult（文件面）', () => {
  it('读 .schema.jsonc（含 JSONC 注释）→ 生成 → 写出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlite-codegen-'));
    writeFileSync(join(dir, 'users.schema.jsonc'),
      '{ // JSONC 注释\n  "properties": { "email": { "type": "string" } }, "required": ["email"] }');
    const result = await generateFromDir(dir);
    expect(result.collections).toEqual(['users']);
    expect(result.types).toContain('export interface Users {');

    const out = join(dir, 'generated');
    await writeResult(result, out);
    expect(existsSync(join(out, 'gitlite.types.ts'))).toBe(true);
    expect(readFileSync(join(out, 'gitlite.client.ts'), 'utf8')).toContain('TypedGitLiteClient');
    rmSync(dir, { recursive: true, force: true });
  });

  it('空目录 → 明确报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlite-codegen-empty-'));
    await expect(generateFromDir(dir)).rejects.toThrow(/no \*\.schema\.jsonc/);
    rmSync(dir, { recursive: true, force: true });
  });
});
