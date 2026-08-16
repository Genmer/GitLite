// 字段级加密（ADR-003）：AES-256-GCM + PBKDF2，commit/pull 边界，镜像/查询明文
import { describe, expect, it } from 'vitest';
import { FieldCipher, bytesToBase64, base64ToBytes, isCipherBox } from './cipher.js';
import { ValidationError } from '../errors.js';
import { MemoryProvider } from '../provider/memory.js';
import { GitLiteClient } from '../client.js';
import { createTestRuntime } from '../test/runtime.js';
import type { Document } from '../types.js';

const encSchema = {
  type: 'object',
  properties: {
    _id: { type: 'string' },
    email: { type: 'string' },
    apiKey: { type: 'string', 'x-gitlite-encrypted': true }
  },
  required: ['apiKey']
};

const REF = { owner: 't', repo: 'r' };

async function clientWith(runtime: ReturnType<typeof createTestRuntime>, passphrase?: string, allowForeignRepo?: boolean) {
  return GitLiteClient.create({
    provider: new MemoryProvider(), runtime,
    ref: REF, database: 'd', passphrase, allowForeignRepo
  });
}

describe('FieldCipher 单元（ADR-003）', () => {
  it('加密→解密 往返一致', async () => {
    const c = new FieldCipher('s3cret');
    const box = await c.encryptValue('sk-live-abc');
    expect(await c.decryptValue(box)).toBe('sk-live-abc');
  });

  it('同一明文两次加密密文不同（GCM 随机 IV）', async () => {
    const c = new FieldCipher('p');
    expect((await c.encryptValue('x')).$enc).not.toBe((await c.encryptValue('x')).$enc);
  });

  it('错误 passphrase 解密抛错（GCM tag 校验）', async () => {
    const box = await new FieldCipher('right').encryptValue('secret');
    await expect(new FieldCipher('wrong').decryptValue(box)).rejects.toThrow();
  });

  it('base64 工具往返', () => {
    const bytes = new TextEncoder().encode('你好, GitLite! \u0000\x01');
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(isCipherBox({ $enc: 'x' })).toBe(true);
    expect(isCipherBox('plain')).toBe(false);
  });
});

describe('字段级加密集成（ADR-003）', () => {
  it('远端只存密文：flush 后数据文件 apiKey 为 $enc 对象，email 明文', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const client = await GitLiteClient.create({
      provider, runtime, ref: REF, database: 'd', passphrase: 'p'
    });
    await client.putSchema('users', encSchema);
    await client.collection('users').insertOne({ email: 'a@b.com', apiKey: 'sk-1' } as any);
    await client.sync.flush();

    const files = (await provider.getFiles(REF, 'gitlite/d'))!;
    const line = [...files.values()].find(v => v.includes('sk-1') === false && v.includes('$enc'));
    expect(line).toBeDefined();
    expect(line!).not.toContain('sk-1');            // 远端无明文
    expect(line!).toContain('$enc');                // 密文形态
    expect(files.get('users.jsonl')).toContain('a@b.com'); // 非加密字段明文
    await client.close();
  });

  it('同 passphrase 重连读回明文；本地查询/排序/聚合可用（镜像明文）', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const a = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'p' });
    await a.putSchema('users', encSchema);
    await a.collection('users').insertOne({ email: 'x@y.z', apiKey: 'sk-9' } as any);
    await a.sync.flush();
    await a.close();

    const b = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'p' });
    const doc = await b.collection('users').findOne({});
    expect((doc as any).apiKey).toBe('sk-9');       // 明文
    // 等值查询（镜像明文）与排序均可用
    expect((await b.collection('users').findOne({ apiKey: 'sk-9' } as any))!.email).toBe('x@y.z');
    const agg = await b.collection('users').aggregate<any>([{ $count: 'n' }]);
    expect(agg[0].n).toBe(1);
    await b.close();
  });

  it('无 passphrase 且凭据库无缓存 → 读到密文对象（安全降级不崩溃）', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const a = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'p' });
    await a.putSchema('users', encSchema);
    await a.collection('users').insertOne({ email: 'x@y.z', apiKey: 'sk-1' } as any);
    await a.sync.flush();
    await a.close();

    // 独立 runtime（独立凭据库）：无 passphrase 也取不到 → 不解密 → 安全降级
    const b = await GitLiteClient.create({ provider, runtime: createTestRuntime(), ref: REF, database: 'd' });
    const doc = (await b.collection('users').findOne({})) as any;
    expect(doc.apiKey).toMatchObject({ $enc: expect.any(String) }); // 降级为密文对象
    expect(doc.email).toBe('x@y.z');                // 明文字段照常
    await b.close();
  });

  it('错误 passphrase → 解密失败保留密文（不崩溃）', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const a = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'right' });
    await a.putSchema('users', encSchema);
    await a.collection('users').insertOne({ email: 'x', apiKey: 'sk-1' } as any);
    await a.sync.flush();
    await a.close();

    const b = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'wrong' });
    const doc = (await b.collection('users').findOne({})) as any;
    expect(doc.apiKey).toMatchObject({ $enc: expect.any(String) });
    await b.close();
  });

  it('凭据库缓存：首启传 passphrase 后，重连不传也能自动解密', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const a = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'cached' });
    await a.putSchema('users', encSchema);
    await a.collection('users').insertOne({ email: 'x', apiKey: 'sk-2' } as any);
    await a.sync.flush();
    await a.close();

    const b = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd' }); // 无 passphrase
    expect(((await b.collection('users').findOne({})) as any).apiKey).toBe('sk-2'); // 自动从凭据库解密
    await b.close();
  });

  it('schema 校验：加密字段与索引/唯一/复合互斥 → 报错', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const client = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'p' });
    await expect(client.putSchema('bad', {
      type: 'object',
      properties: { apiKey: { type: 'string', 'x-gitlite-encrypted': true, 'x-gitlite-indexed': true } }
    })).rejects.toThrow(ValidationError);
    await expect(client.putSchema('bad2', {
      type: 'object',
      properties: { a: { type: 'string', 'x-gitlite-encrypted': true }, b: { type: 'string' } },
      'x-gitlite-indexes': [{ name: 'ab', fields: ['a', 'b'] }]
    })).rejects.toThrow(/encrypted field/);
    await client.close();
  });

  it('无加密字段的库 + passphrase：行为不变（不加密）', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const client = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'p' });
    await client.putSchema('plain', {
      type: 'object', properties: { _id: { type: 'string' }, n: { type: 'integer' } }
    });
    await client.collection('plain').insertOne({ n: 1 } as any);
    await client.sync.flush();
    const files = (await provider.getFiles(REF, 'gitlite/d'))!;
    expect(files.get('plain.jsonl')).toContain('"n":1');   // 无 $enc
    expect(files.get('plain.jsonl')).not.toContain('$enc');
    await client.close();
  });

  it('L1 doc-per-file：逐文件加密往返一致', async () => {
    const provider = new MemoryProvider();
    const runtime = createTestRuntime();
    const a = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'p' });
    await a.putSchema('users', encSchema);
    const c = a.collection('users');
    for (let i = 0; i < 55; i++) await c.insertOne({ email: `e${i}`, apiKey: `k${i}` } as unknown as Document);
    await a.sync.flush();
    await a.close();

    const b = await GitLiteClient.create({ provider, runtime, ref: REF, database: 'd', passphrase: 'p' });
    expect(await b.collection('users').count()).toBe(55);
    const one = (await b.collection('users').findOne({ apiKey: 'k30' } as any)) as any;
    expect(one.email).toBe('e30');
    await b.close();
  });
});
