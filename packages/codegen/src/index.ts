// @gitlite/codegen（docs/09 §三）：schema(.schema.jsonc) → 强类型 TS Client。
// 输入为 GitLite 真实 schema 格式（JSON Schema + x-gitlite-*，非 docs 示例的简化 fields 形态）。
// 生成物：gitlite.types.ts（Doc/Input 接口）+ gitlite.client.ts（类型化 Collection 包装）。
// 构建工具定位：本包可用 node 内置（读文件）；纯生成逻辑 generate() 不触 fs（可测）。
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonc } from '@gitlite/core';

export interface SchemaInput {
  /** collection 名（文件名去 .schema.jsonc） */
  name: string;
  /** 已解析的 JSON Schema（含 x-gitlite-* 扩展） */
  schema: any;
}

export interface CodegenResult {
  types: string;
  client: string;
  collections: string[];
}

/** JSON Schema 子模式 → TS 类型（v0.1 词表：string/integer|int/number/boolean/array/object/类型数组） */
export function tsType(sub: any): string {
  const t = sub?.type;
  if (Array.isArray(t)) return [...new Set(t.map((x: string) => tsType({ type: x })))].join(' | ');
  switch (t) {
    case 'string': return 'string';
    case 'integer': case 'int': case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return sub.items ? `Array<${tsType(sub.items)}>` : 'unknown[]';
    case 'object': return 'Record<string, unknown>';
    default: return 'unknown';
  }
}

function pascal(name: string): string {
  return name.replace(/(^|[-_.])(\w)/g, (_, __, c: string) => c.toUpperCase());
}

/** 字段声明（系统字段调用方注入） */
function fieldLines(props: Record<string, any>, required: string[], skip: Set<string>): string[] {
  const out: string[] = [];
  for (const [field, sub] of Object.entries(props ?? {})) {
    if (skip.has(field)) continue;
    const opt = required.includes(field) ? '' : '?';
    out.push(`  ${safeProp(field)}${opt}: ${tsType(sub)};`);
  }
  return out;
}

function safeProp(field: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field);
}

/** 成员访问形态：标识符 → .x；其余 → ["x"]（this."x" 不合法） */
function memberAccess(field: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(field) ? `.${field}` : `[${JSON.stringify(field)}]`;
}

/** 生成 types 文件：每 collection 两个接口（Doc 含系统字段 / Input 仅用户字段保持必填约束） */
export function generateTypes(collections: SchemaInput[]): string {
  const blocks: string[] = [
    '// 由 @gitlite/codegen 生成——请勿手改；重跑 gitlite codegen 覆盖。'
  ];
  for (const { name, schema } of collections) {
    const P = pascal(name);
    const props: Record<string, any> = schema?.properties ?? {};
    const declared = new Set(Object.keys(props));
    const required: string[] = schema?.required ?? [];
    // 系统字段：_id 必有；时间戳默认开启（gitliteDescriptor.timestamps !== false）
    const timestamps = schema?.gitliteDescriptor?.timestamps !== false;
    const sys: string[] = [];
    if (!declared.has('_id')) sys.push('  _id: string;');
    if (timestamps) {
      if (!declared.has('createdAt')) sys.push('  createdAt: string;');
      if (!declared.has('updatedAt')) sys.push('  updatedAt: string;');
    }
    if (!declared.has('_rev')) {
      sys.push('  /** 乐观锁版本（OCC）；写入前自动维护 */');
      sys.push('  _rev?: string;');
    }

    blocks.push(`export interface ${P} {
${sys.join('\n')}
${fieldLines(props, required, new Set()).join('\n')}
}

/** insert/update 输入形态：系统字段全部可省 */
export interface ${P}Input {
${fieldLines(props, required, new Set(['_id', 'createdAt', 'updatedAt', '_rev'])).join('\n')}
}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

/** 生成 client 文件：类型化 Collection 包装 + connect 便捷函数（依赖 @gitlite/sdk） */
export function generateClient(collections: SchemaInput[]): string {
  const imports = collections.map(({ name }) => `  ${pascal(name)},`).join('\n');
  const members = collections.map(({ name }) =>
    `  readonly ${safeProp(name)}: Collection<${pascal(name)}>;`).join('\n');
  const assigns = collections.map(({ name }) =>
    `    this${memberAccess(name)} = db.collection<${pascal(name)}>('${name}');`).join('\n');
  return `// 由 @gitlite/codegen 生成——请勿手改；重跑 gitlite codegen 覆盖。
import { Collection, connect as sdkConnect } from '@gitlite/sdk';
import type { GitLiteClient, SdkConnectOptions } from '@gitlite/sdk';
import type {
${imports}
} from './gitlite.types.js';

export class TypedGitLiteClient {
${members}
  constructor(private db: GitLiteClient) {
${assigns}
  }

  /** 底层 client（schema/事务/同步状态等未生成面） */
  get raw(): GitLiteClient { return this.db; }
  close(): Promise<void> { return this.db.close(); }
}

export function connect(input: SdkConnectOptions | string): Promise<TypedGitLiteClient> {
  return sdkConnect(input).then(db => new TypedGitLiteClient(db));
}
`;
}

export function generate(collections: SchemaInput[]): CodegenResult {
  const sorted = [...collections].sort((a, b) => a.name.localeCompare(b.name)); // 稳定输出
  return {
    types: generateTypes(sorted),
    client: generateClient(sorted),
    collections: sorted.map(c => c.name)
  };
}

/** 从 schema 目录（*_schema 目录形态：<dir>/<name>.schema.jsonc）读取并生成 */
export async function generateFromDir(dir: string): Promise<CodegenResult> {
  const names = (await readdir(dir)).filter(f => f.endsWith('.schema.jsonc'));
  const collections: SchemaInput[] = [];
  for (const f of names) {
    const name = f.slice(0, -'.schema.jsonc'.length);
    collections.push({ name, schema: parseJsonc(await readFile(join(dir, f), 'utf8')) });
  }
  if (!collections.length) throw new Error(`no *.schema.jsonc found in ${dir}`);
  return generate(collections);
}

/** 生成并写出（gitlite.types.ts / gitlite.client.ts） */
export async function writeResult(result: CodegenResult, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'gitlite.types.ts'), result.types, 'utf8');
  await writeFile(join(outDir, 'gitlite.client.ts'), result.client, 'utf8');
}
