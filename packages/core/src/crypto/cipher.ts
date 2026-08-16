// 字段级加密（ADR-003）：AES-256-GCM + PBKDF2，WebCrypto（浏览器/Node18+ 均有）。
// 加密在序列化边界：远端只存密文，镜像/索引/查询全明文。
// salt = 库级公开常量（保证多端同一 passphrase 派生出同一密钥）；IV 每次随机（GCM 语义安全）。
import type { Document } from '../types.js';

// 最小 WebCrypto subtle 形状（core lib 为 ES2022 无 DOM 类型；node18+/浏览器均有全局 crypto.subtle）
interface SubtleLike {
  importKey(format: string, keyData: Uint8Array, algorithm: object | string, extractable: boolean,
    keyUsages: string[]): Promise<unknown>;
  deriveKey(algorithm: object, baseKey: unknown, derivedKeyType: object, extractable: boolean,
    keyUsages: string[]): Promise<unknown>;
  encrypt(algorithm: object, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: object, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

const subtle = (globalThis as any).crypto?.subtle as SubtleLike;
const enc = new TextEncoder();
const dec = new TextDecoder();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const KDF_ITER = 210_000;
const KDF_NAME = 'pbkdf2-sha256';
/** 库级固定 salt（公开常量，PBKDF2 salt 无需保密；保证确定性派生 → 多端互解） */
const SALT = new Uint8Array([103, 105, 116, 108, 105, 116, 101, 45, 102, 105, 101, 108, 100]); // "gitlite-field"
const SALT_B64 = bytesToBase64(SALT);

/** 密文形态：{ "$enc": base64(iv‖ct‖tag), "kdf", "salt", "iter" } */
export interface CipherBox { $enc: string; kdf: string; salt: string; iter: number }

export class FieldCipher {
  private keyPromise: Promise<unknown> | null = null;

  constructor(private passphrase: string) {}

  private key(): Promise<unknown> {
    if (!this.keyPromise) this.keyPromise = this.derive();
    return this.keyPromise;
  }

  private async derive(): Promise<unknown> {
    const material = await subtle.importKey('raw', enc.encode(this.passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: KDF_ITER },
      material,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
  }

  async encryptValue(plaintext: string): Promise<CipherBox> {
    const key = await this.key();
    const iv = (globalThis as any).crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    const payload = new Uint8Array(iv.length + ct.byteLength);
    payload.set(iv, 0);
    payload.set(new Uint8Array(ct), iv.length);
    return { $enc: bytesToBase64(payload), kdf: KDF_NAME, salt: SALT_B64, iter: KDF_ITER };
  }

  /** @throws 错 passphrase / 密文被篡改（GCM tag 校验失败） */
  async decryptValue(box: CipherBox): Promise<string> {
    const key = await this.key();
    const buf = base64ToBytes(box.$enc);
    const iv = buf.slice(0, 12);
    const ct = buf.slice(12);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(pt);
  }
}

/** 是否为加密密文形态 */
export function isCipherBox(v: any): v is CipherBox {
  return typeof v === 'object' && v !== null && typeof v.$enc === 'string';
}

/** 按加密字段清单加密文档（仅替换存在的字段值；缺失字段跳过） */
export async function encryptDoc(doc: Document, fields: string[], cipher: FieldCipher): Promise<Document> {
  if (!fields.length) return doc;
  const out = { ...doc } as Record<string, any>;
  for (const f of fields) {
    const v = (doc as any)[f];
    if (v === undefined || isCipherBox(v)) continue;      // 已加密/缺失跳过（幂等）
    out[f] = await cipher.encryptValue(typeof v === 'string' ? v : JSON.stringify(v));
  }
  return out as Document;
}

/** 按加密字段清单解密文档；非密文形态（明文/老数据）原样保留；解密失败保留密文（安全降级） */
export async function decryptDoc(doc: Document, fields: string[], cipher: FieldCipher): Promise<Document> {
  if (!fields.length) return doc;
  const out = { ...doc } as Record<string, any>;
  for (const f of fields) {
    const v = (doc as any)[f];
    if (!isCipherBox(v)) continue;
    try {
      out[f] = await cipher.decryptValue(v);
    } catch {
      // 错 passphrase / 篡改：保留密文，不崩溃（老客户端无密钥读到 $enc 对象同理）
    }
  }
  return out as Document;
}

// ---------- base64 工具（无依赖；兼容浏览器/Node） ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) { out += '=='; break; }
    out += B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) { out += '='; break; }
    out += B64[b2 & 63];
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const len = clean.length;
  const out = new Uint8Array(Math.floor(len * 6 / 8));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < len; i++) {
    const v = B64.indexOf(clean[i]!);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out;
}
