// ULID：Crockford Base32，48bit 时间戳 + 80bit 随机；同毫秒单调递增防碰撞（FR D2）
import type { CryptoAdapter } from '../runtime.js';

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford，去 I L O U

export class Ulid {
  private lastTime = -1;
  private lastRand: Uint8Array | null = null;

  constructor(private crypto: CryptoAdapter) {}

  generate(now?: number): string {
    const t = now ?? Date.now();
    let rand: Uint8Array;
    if (t === this.lastTime && this.lastRand) {
      rand = this.lastRand.slice();
      increment(rand); // 单调递增
    } else {
      rand = this.crypto.randomBytes(10);
    }
    this.lastTime = t;
    this.lastRand = rand;
    return encodeTime(t, 10) + encodeRandom(rand);
  }
}

function encodeTime(t: number, len: number): string {
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    out += ENC[Math.floor(t / 32 ** i) % 32];
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes → 16 chars（80bit / 5bit）
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ENC[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ENC[(value << (5 - bits)) & 31];
  return out;
}

function increment(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i]! === 0xff) { bytes[i] = 0; }
    else { bytes[i]!++; return; }
  }
}

/** ULID 时间戳提取（校验用） */
export function ulidTimestamp(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10)) {
    const v = ENC.indexOf(ch);
    if (v < 0) throw new Error(`invalid ULID char: ${ch}`);
    t = t * 32 + v;
  }
  return t;
}
