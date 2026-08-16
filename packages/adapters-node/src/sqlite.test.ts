// adapters-node：createNodeSqlite 工厂冒烟（P4）。
// Node < 22.5 无 node:sqlite → 工厂返回 null（宿主回退内存索引），不算失败。
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqlite } from './index.js';

describe('createNodeSqlite（node:sqlite 工厂，P4）', () => {
  it('打开真 SQLite 文件：exec/run/all/close 语义', () => {
    const factory = createNodeSqlite();
    if (!factory) return;
    const dir = mkdtempSync(join(tmpdir(), 'gitlite-node-sqlite-'));
    const path = join(dir, 'cache.db');
    const db = factory.open(path);
    db.exec('CREATE TABLE t (a TEXT)');
    expect(db.run('INSERT INTO t VALUES (?)', ['x'])).toBe(1);
    expect(db.all('SELECT a FROM t WHERE a = ?', ['x'])).toEqual([{ a: 'x' }]);
    db.close();
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it(':memory: 可用（WAL 不适用时自动忽略）', () => {
    const factory = createNodeSqlite();
    if (!factory) return;
    const db = factory.open(':memory:');
    db.exec('CREATE TABLE t (a TEXT)');
    expect(db.run('INSERT INTO t VALUES (?)', ['y'])).toBe(1);
    db.close();
  });
});
