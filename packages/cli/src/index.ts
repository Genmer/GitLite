// @gitlite/cli v0.1：最小命令集（手写 argv，v0.3 换 commander）
// auth / db / data / sync；repl 诚实降级至 v0.2（见 progress）
import { connect, interactiveLogin, databases, parseUri } from '@gitlite/sdk';
import { createNodeRuntime } from '@gitlite/adapters-node';
import type { RuntimeAdapter } from '@gitlite/core';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BINDINGS = join(homedir(), '.gitlite', 'bindings.json');

export async function run(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  const args = parseArgs(rest);
  const runtime = createNodeRuntime();

  try {
    switch (cmd) {
      case 'auth': return await authCmd(sub, args, runtime);
      case 'db': return await dbCmd(sub, args);
      case 'data': return await dataCmd(sub, args);
      case 'sync': return await syncCmd(sub, args);
      case undefined:
      case 'help':
        printHelp();
        return 0;
      default:
        console.error(`unknown command: ${cmd}`);
        printHelp();
        return 2;
    }
  } catch (e: any) {
    console.error(`✗ ${e.message ?? e}`);
    return 1;
  }
}

// ---------- auth ----------
async function authCmd(sub: string | undefined, args: Record<string, string>, runtime: RuntimeAdapter): Promise<number> {
  switch (sub) {
    case 'login': {
      const token = await interactiveLogin(runtime);
      console.log('✓ logged in, token saved to credential store');
      void token;
      return 0;
    }
    case 'logout': {
      await runtime.credential.delete('gitlite:github:default');
      console.log('✓ logged out');
      return 0;
    }
    case 'status': {
      const token = await runtime.credential.get('gitlite:github:default');
      let bound: any = null;
      try { bound = JSON.parse(await readFile(BINDINGS, 'utf8')); } catch { /* 未初始化 */ }
      console.log(JSON.stringify({
        github: token ? '✓ logged in' : '✗ not logged in',
        bindings: bound
      }, null, 2));
      return 0;
    }
    default:
      console.error('usage: gitlite auth login|status|logout');
      return 2;
  }
}

// ---------- db ----------
async function dbCmd(sub: string | undefined, args: Record<string, string>): Promise<number> {
  const ctx = { owner: args.owner ?? '', token: args.token };
  if (!ctx.owner) { console.error('--owner required'); return 2; }
  switch (sub) {
    case 'create': {
      if (!args.name) { console.error('usage: gitlite db create <name> --owner x --token y'); return 2; }
      await databases.create(args.name, ctx);
      console.log(`✓ database created: ${args.name}`);
      return 0;
    }
    case 'list': {
      const list = await databases.list(ctx);
      console.log(list.join('\n'));
      return 0;
    }
    case 'drop':
      console.error('db drop: lands with provider.deleteBranch (M9, tracked in progress.md)');
      return 2;
    default:
      console.error('usage: gitlite db create|list|drop');
      return 2;
  }
}

// ---------- data ----------
async function dataCmd(sub: string | undefined, args: Record<string, string>): Promise<number> {
  if (!args.db) { console.error('--db <uri> required (e.g. gitlite://github:<profile>@me/gitlite-repo/default)'); return 2; }
  const db = await connect(args.db);
  try {
    const col = args.collection ?? '';
    switch (sub) {
      case 'insert': {
        const doc = JSON.parse(args.doc ?? '{}');
        const id = await db.collection(col).insertOne(doc);
        await db.close();
        console.log(id);
        return 0;
      }
      case 'find': {
        const filter = args.filter ? JSON.parse(args.filter) : {};
        const limit = args.limit ? Number(args.limit) : 20;
        const page = await db.collection(col).find(filter, { limit });
        await db.close();
        console.log(JSON.stringify(page.items, null, 2));
        return 0;
      }
      case 'count': {
        const n = await db.collection(col).count(args.filter ? JSON.parse(args.filter) : {});
        await db.close();
        console.log(String(n));
        return 0;
      }
      default:
        console.error('usage: gitlite data insert|find|count --collection x --db uri [--doc|--filter|--limit]');
        return 2;
    }
  } finally { await db.close().catch(() => {}); }
}

// ---------- sync ----------
async function syncCmd(sub: string | undefined, args: Record<string, string>): Promise<number> {
  if (!args.db) { console.error('--db <uri> required'); return 2; }
  const db = await connect(args.db);
  switch (sub) {
    case 'status': {
      console.log(JSON.stringify(db.syncStatus(), null, 2));
      await db.close();
      return 0;
    }
    case 'push': case 'flush': {
      await db.sync.flush();
      console.log('✓ pushed');
      await db.close();
      return 0;
    }
    case 'pull': {
      await db.sync.pull();
      console.log('✓ pulled');
      await db.close();
      return 0;
    }
    default:
      console.error('usage: gitlite sync status|push|pull --db uri');
      return 2;
  }
}

function parseArgs(rest: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i]!.startsWith('--')) {
      const key = rest[i]!.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = 'true';
    } else {
      // 位置参数：collection / name
      if (!out.collection) out.collection = rest[i]!;
      else if (!out.name) out.name = rest[i]!;
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`gitlite v0.1

usage:
  gitlite auth login|status|logout
  gitlite db create|list|drop --owner <login> --token <pat>
  gitlite data insert|find|count <collection> --db <uri> [--doc|--filter|--limit]
  gitlite sync status|push|pull --db <uri>

uri: gitlite://<provider>:<auth>@<owner>/<repo>/<database>`);
}

void parseUri;
