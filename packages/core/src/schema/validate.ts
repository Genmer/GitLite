// JSON Schema Draft 2020-12 子集校验器（FR D1）
// 支持关键字：type enum pattern format maxLength minLength minimum maximum
//            items properties required additionalProperties(bool) default(忽略)
// 未支持的标准关键字 → 明确报错（不静默忽略）
// x-gitlite-* → 忽略（由存储层处理：unique/indexed/immutable/encrypted/ref）

export interface SchemaIssue { path: string; message: string }

const SUPPORTED = new Set([
  'type', 'enum', 'const', 'pattern', 'format', 'maxLength', 'minLength',
  'minimum', 'maximum', 'items', 'properties', 'required',
  'additionalProperties', 'default', 'title', 'description',
  '$schema', 'gitliteDescriptor'
]);

const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^https?:\/\/\S+$/,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/
};

export class SchemaValidator {
  /** 返回 issue 列表；空数组 = 通过 */
  validate(value: any, schema: any, path = ''): SchemaIssue[] {
    if (schema === true || schema === undefined || schema === null) return [];
    const issues: SchemaIssue[] = [];

    for (const key of Object.keys(schema)) {
      if (!SUPPORTED.has(key) && !key.startsWith('x-gitlite-')) {
        issues.push({ path, message: `unsupported schema keyword "${key}" in v0.1` });
      }
    }

    if (schema.type !== undefined) issues.push(...checkType(value, schema.type, path));
    if (schema.enum !== undefined && !schema.enum.some((v: any) => deepEqual(v, value))) {
      issues.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
    }
    if (typeof value === 'string') {
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        issues.push({ path, message: `does not match pattern ${schema.pattern}` });
      }
      if (schema.format !== undefined && FORMATS[schema.format] &&
          !FORMATS[schema.format]!.test(value)) {
        issues.push({ path, message: `invalid ${schema.format} format` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({ path, message: `length ${value.length} > maxLength ${schema.maxLength}` });
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push({ path, message: `length ${value.length} < minLength ${schema.minLength}` });
      }
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({ path, message: `${value} < minimum ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({ path, message: `${value} > maximum ${schema.maximum}` });
      }
    }
    if (Array.isArray(value) && schema.items !== undefined) {
      value.forEach((v, i) => issues.push(...this.validate(v, schema.items, `${path}[${i}]`)));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const props = schema.properties ?? {};
      if (schema.required !== undefined) {
        for (const req of schema.required) {
          if (!(req in value) || value[req] === undefined) {
            issues.push({ path, message: `missing required "${req}"` });
          }
        }
      }
      for (const [k, sub] of Object.entries<any>(props)) {
        if (value[k] !== undefined) {
          issues.push(...this.validate(value[k], sub, path ? `${path}.${k}` : k));
        }
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!(k in props)) {
            issues.push({ path, message: `additional property "${k}" not allowed` });
          }
        }
      }
    }
    return issues;
  }
}

function checkType(value: any, type: any, path: string): SchemaIssue[] {
  const ok = Array.isArray(type)
    ? type.some(t => typeMatches(value, t))
    : typeMatches(value, type);
  return ok ? [] : [{ path, message: `expected ${Array.isArray(type) ? type.join('|') : type}, got ${jsonType(value)}` }];
}

function typeMatches(value: any, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return true; // 未知类型名宽容（x- 扩展可能定义）
  }
}

function jsonType(v: any): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
