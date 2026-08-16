// gitlite repl（FR J5，v0.2 追回）：交互式 JS 求值（db.<collection>.<op>()）+ 点命令。
// 可测核心（handleLine/isIncomplete/makeCompleter）与 readline 循环（startRepl）分离；
// 求值为表达式导向（AsyncFunction 包裹，支持 await / db.transaction）。
import * as readline from 'node:readline';
import { inspect } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitLiteClient } from '@gitlite/core';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (body: string) => Promise<any>;

export const DOT_COMMANDS = ['.help', '.exit', '.quit', '.collections', '.schema', '.sync', '.push', '.pull'] as const;

const HELP = `commands:
  db.<collection>.<op>(...)   JS 表达式求值（支持 await；结果 inspect 输出）
                               例：db.users.find({ age: { $gte: 18 } })
                                   db.users.insertOne({ email: 'a@x.com' })
                                   db.transaction(async tx => tx.collection('users').count())
  .collections                列出全部 collection
  .schema <name>              查看字段/索引（类型 + unique/indexed/encrypted 标注）
  .sync                       同步状态（pending/lastSyncAt/head）
  .push / .pull               立即 flush / pull
  .help                       本帮助
  .exit / .quit / Ctrl+D      退出（自动 flush）
输入多行：括号/引号未闭合时自动续行（   ...> 提示符）。Tab 补全：点命令 / collection 名 / 集合方法 / filter 内字段名与 $ 操作符。`;

export interface LineResult {
  output: string;
  quit?: boolean;
}

/** REPL 的 db 视图：属性访问直达 collection（db.users.find(...)），其余成员透传（方法绑定 this） */
export function replDb(db: GitLiteClient): any {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && target.storage.collectionNames().includes(prop)) {
        return target.collection(prop);
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: any[]) => any).bind(target) : v;
    }
  });
}

/** 处理一行（已判定完整）：点命令或 JS 表达式求值 */
export async function handleLine(db: GitLiteClient, line: string): Promise<LineResult> {
  const t = line.trim();
  if (!t) return { output: '' };
  if (t === '.exit' || t === '.quit' || t === '.exit()') return { output: 'bye', quit: true };
  if (t === '.help') return { output: HELP };
  if (t === '.collections') {
    const names = db.storage.collectionNames();
    return { output: names.length ? names.join('\n') : '(no collections)' };
  }
  if (t.startsWith('.schema')) {
    const name = t.slice('.schema'.length).trim();
    if (!name) return { output: 'usage: .schema <collection>' };
    return { output: schemaText(name, db.storage.getSchema(name)) };
  }
  if (t === '.sync') return { output: JSON.stringify(db.syncStatus(), null, 2) };
  if (t === '.push') { await db.sync.flush(); return { output: '✓ pushed' }; }
  if (t === '.pull') { await db.sync.pull(); return { output: '✓ pulled' }; }
  if (t.startsWith('.')) return { output: `unknown command: ${t.split(/\s/)[0]} (try .help)` };

  try {
    const fn = new AsyncFunction('db', `"use strict"; return (${t});`);
    const result = await fn(replDb(db));
    return { output: result === undefined ? 'undefined' : inspect(result, { depth: 6, maxArrayLength: 20 }) };
  } catch (e: any) {
    return { output: `✗ ${e?.message ?? e}` };
  }
}

/** 多行判定：括号/引号未闭合（点命令天然单行，不受影响） */
export function isIncomplete(line: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
  }
  return depth > 0 || quote !== null;
}

const COLLECTION_METHODS = ['find(', 'findOne(', 'insertOne(', 'updateOne(', 'updateMany(', 'deleteOne(', 'deleteMany(', 'count(', 'aggregate(', 'explain('];

/** filter 词表（与 query/filter.ts 的 matches 实际支持集一致，勿凭记忆扩） */
const FILTER_OPS = ['$and', '$or', '$not', '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex', '$options'];

/** Tab 补全：点命令 / db.<collection> / db.<collection>.<method> / filter 内字段名与操作符 */
export function makeCompleter(db: GitLiteClient): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    if (line.startsWith('.') && !line.includes(' ')) {
      return [DOT_COMMANDS.filter(c => c.startsWith(line)), line];
    }
    let m = /^db\.(\w*)$/.exec(line);
    if (m) {
      const names = db.storage.collectionNames().map(c => `db.${c}`);
      return [names.filter(n => n.startsWith(line)), line];
    }
    m = /^db\.(\w+)\.(\w*)$/.exec(line);
    if (m && db.storage.collectionNames().includes(m[1]!)) {
      const typed = m[2]!;
      return [COLLECTION_METHODS.filter(x => x.startsWith(typed)), typed];
    }
    // filter 对象内：`db.users.find({ …` → 字段名（schema）或 $ 操作符
    m = /^db\.(\w+)\.\w+\(\{(.*)$/.exec(line);
    if (m && db.storage.collectionNames().includes(m[1]!)) {
      const tail = /[^,{\s]*$/.exec(m[2]!)![0];
      if (tail.startsWith('$')) {
        return [FILTER_OPS.filter(op => op.startsWith(tail)), tail];
      }
      const fields = Object.keys(db.storage.getSchema(m[1]!)?.properties ?? {});
      return [fields.filter(f => f.startsWith(tail)).map(f => `'${f}': `), tail];
    }
    return [[], line];
  };
}

const historyPath = (): string => join(homedir(), '.gitlite', 'repl-history');

/** REPL 主循环（readline；输入输出可注入 → 测试用 PassThrough）。
 *  行事件异步处理必须串行化（promise 链）：否则慢求值晚于 .exit 关闭后再 prompt 会 use-after-close。 */
export async function startRepl(
  db: GitLiteClient,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): Promise<void> {
  const rl = readline.createInterface({
    input,
    output,
    prompt: 'gitlite> ',
    completer: makeCompleter(db),
    history: await loadHistory()
  });
  rl.prompt();
  let buffer = '';
  let done = false;
  // Ctrl+D / 输入流结束时 close 可能先于链内 handler 触发 → prompt/close 对已关接口会抛错，须吞掉
  const safePrompt = (preserveCursor = false): void => {
    try { rl.prompt(preserveCursor); } catch { /* interface already closed */ }
  };
  const safeClose = (): void => {
    try { rl.close(); } catch { /* already closed */ }
  };
  const handle = async (raw: string): Promise<void> => {
    if (done) return;
    const line = buffer ? `${buffer}\n${raw}` : raw;
    if (isIncomplete(line) && !line.trim().startsWith('.')) {
      buffer = line;
      rl.setPrompt('   ...> ');
      safePrompt(true);
      return;
    }
    buffer = '';
    rl.setPrompt('gitlite> ');
    try {
      const { output: out, quit } = await handleLine(db, line);
      if (out) output.write(`${out}\n`);
      if (quit) { done = true; safeClose(); return; }
    } catch (e: any) {
      output.write(`✗ ${e?.message ?? e}\n`);
    }
    if (!done) safePrompt(true);
  };
  let chain: Promise<void> = Promise.resolve();
  rl.on('line', raw => {
    chain = chain.then(() => handle(raw)).catch(() => undefined); // 单行故障不断链
  });
  return new Promise<void>(resolve => {
    rl.on('close', () => {
      // 输入端关闭时行处理链可能尚未排空（微任务交错）→ 等链结算再 resolve，调用方拿到完整输出
      void Promise.resolve(chain).then(() => {
        void saveHistory((rl as any).history ?? []);
        resolve();
      });
    });
  });
}

function schemaText(name: string, schema: any): string {
  if (!schema) return `no schema for "${name}"`;
  const fields = Object.entries<any>(schema.properties ?? {}).map(([f, sub]) => {
    const flags = [
      sub?.['x-gitlite-unique'] && 'unique',
      sub?.['x-gitlite-indexed'] && 'indexed',
      sub?.['x-gitlite-encrypted'] && 'encrypted'
    ].filter(Boolean);
    return `${f}: ${sub?.type ?? 'any'}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  });
  const indexes = (schema['x-gitlite-indexes'] ?? []).map((idx: any) =>
    `[index] ${idx.name}: ${idx.fields.join(', ')}${idx.unique ? ' (unique)' : ''}`);
  return [...fields, ...indexes].join('\n') || '(empty schema)';
}

async function loadHistory(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(historyPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function saveHistory(history: string[]): Promise<void> {
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(homedir(), '.gitlite'), { recursive: true });
    await writeFile(historyPath(), JSON.stringify(history.slice(-200)), 'utf8');
  } catch { /* 历史持久化失败不影响会话 */ }
}
