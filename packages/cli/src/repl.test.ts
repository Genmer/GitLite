// REPL 测试（FR J5）：可测核心（handleLine/isIncomplete/makeCompleter）+ PassThrough 流冒烟。
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@gitlite/sdk';
import type { GitLiteClient } from '@gitlite/core';
import { handleLine, isIncomplete, makeCompleter, startRepl } from './repl.js';

// REPL 历史写 ~/.gitlite/repl-history → 测试期重定向 home
const realHome = process.env.USERPROFILE ?? process.env.HOME;
beforeAll(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'gitlite-repl-'));
  process.env.USERPROFILE = tmp;
  process.env.HOME = tmp;
});
afterAll(() => {
  process.env.USERPROFILE = realHome;
  process.env.HOME = realHome;
});

let repoSeq = 0; // 每个 fixture 独立 repo → 独立队列哈希（避免真实磁盘队列跨测试串扰重放）
const uri = () => `gitlite://memory:t@me/repl-${++repoSeq}/default`;

async function fixture(): Promise<GitLiteClient> {
  const db = await connect(uri());
  await db.putSchema('users', {
    type: 'object',
    properties: {
      email: { type: 'string', 'x-gitlite-unique': true, 'x-gitlite-indexed': true },
      age: { type: 'integer', 'x-gitlite-indexed': true }
    },
    'x-gitlite-indexes': [{ name: 'email_age', fields: ['email', 'age'] }]
  } as any);
  const users = db.collection('users');
  await users.insertOne({ email: 'a@x.dev', age: 30 } as any);
  await users.insertOne({ email: 'b@x.dev', age: 20 } as any);
  return db;
}

describe('REPL isIncomplete（多行判定）', () => {
  it('括号/引号未闭合 → true；闭合 → false', () => {
    expect(isIncomplete('db.users.find({')).toBe(true);
    expect(isIncomplete('db.users.find({ age: { $gte: 1 }')).toBe(true);
    expect(isIncomplete("db.users.find({ email: 'a@x.dev' })")).toBe(false);
    expect(isIncomplete("db.users.find({ email: 'unterminated })).count()")).toBe(true); // 引号内括号不计
    expect(isIncomplete('.help')).toBe(false);
  });
});

describe('REPL handleLine', () => {
  it('JS 求值：count / find / insertOne / await 事务', async () => {
    const db = await fixture();
    expect((await handleLine(db, 'db.users.count()')).output).toBe('2');
    const find = await handleLine(db, 'db.users.find({ age: { $gte: 21 } })');
    expect(find.output).toContain('total: 1');
    expect(find.output).toContain("email: 'a@x.dev'");
    const id = await handleLine(db, "db.users.insertOne({ email: 'c@x.dev', age: 40 })");
    expect(id.output).toMatch(/^'01[0-9A-Z]{24}'$/); // ULID 字符串（inspect 带引号）
    expect(id.output.length).toBeGreaterThan(10);
    const tx = await handleLine(db, 'db.transaction(async tx => tx.collection("users").insertOne({ email: "tx@x.dev", age: 1 }))');
    expect(tx.output).toMatch(/^'01[0-9A-Z]{24}'$/); // 事务内插入（TxCollection 写语义）
    expect((await handleLine(db, 'db.users.count()')).output).toBe('4');
    await db.close();
  });

  it('求值错误不炸会话（✗ 前缀）', async () => {
    const db = await fixture();
    const r = await handleLine(db, 'db.nope.anything()');
    expect(r.output).toMatch(/^✗/);
    expect(r.quit).toBeFalsy();
    const syn = await handleLine(db, 'db.users.???');
    expect(syn.output).toMatch(/^✗/);
    await db.close();
  });

  it('点命令：collections / schema / sync / push / pull / help / 未知', async () => {
    const db = await fixture();
    expect((await handleLine(db, '.collections')).output).toContain('users');
    const schema = await handleLine(db, '.schema users');
    expect(schema.output).toContain('email: string (unique, indexed)');
    expect(schema.output).toContain('age: integer (indexed)');
    expect(schema.output).toContain('[index] email_age: email, age');
    expect((await handleLine(db, '.schema nope')).output).toContain('no schema');
    expect((await handleLine(db, '.schema')).output).toContain('usage');
    expect((await handleLine(db, '.sync')).output).toContain('pendingOps');
    expect((await handleLine(db, '.push')).output).toBe('✓ pushed');
    expect((await handleLine(db, '.pull')).output).toBe('✓ pulled');
    expect((await handleLine(db, '.help')).output).toContain('.collections');
    expect((await handleLine(db, '.wat')).output).toContain('unknown command');
    const exit = await handleLine(db, '.exit');
    expect(exit.quit).toBe(true);
    expect(exit.output).toBe('bye');
    await db.close();
  });
});

describe('REPL makeCompleter（Tab 补全）', () => {
  it('点命令 / collection / 方法 / filter 内字段与操作符', async () => {
    const db = await fixture();
    const complete = makeCompleter(db);
    expect(complete('.')[0]).toContain('.help');
    expect(complete('.sc')[0]).toEqual(['.schema']);
    expect(complete('db.us')[0]).toEqual(['db.users']);
    expect(complete('db.users.')[0]).toContain('find(');
    expect(complete('db.users.co')[0]).toEqual(['count(']);
    // filter 对象内：字段名（带引号键形态）与 $ 操作符（filter.ts 真实词表）
    expect(complete('db.users.find({ ')[0]).toContainEqual("'email': ");
    expect(complete('db.users.find({ ag')[0]).toContainEqual("'age': ");
    expect(complete('db.users.find({ age: { $gt')).toEqual([['$gt', '$gte'], '$gt']);
    expect(complete('db.users.find({ $re')).toEqual([['$regex'], '$re']);
    // 无关输入 / 无 schema 字段
    expect(complete('random text')[0]).toEqual([]);
    expect(complete('db.users.find({ 1')[0]).toEqual([]);
    await db.close();
  });
});

describe('REPL startRepl（PassThrough 冒烟：多行求值 + 退出）', () => {
  it('完整会话流：help → 多行 find → 退出', async () => {
    const db = await fixture();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', c => { text += String(c); });
    const session = startRepl(db, input, output);
    input.write('.help\n');
    input.write('db.users.find({\n  age: { $gte: 21 }\n})\n'); // 三行合一
    input.end('.exit\n');
    await session;
    await db.close();
    expect(text).toContain('.collections');
    expect(text).toContain('total: 1');
    expect(text).toContain('   ...>');
    expect(text.trimEnd().endsWith('bye')).toBe(true);
  });
});
