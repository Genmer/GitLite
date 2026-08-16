// 限流响应头精确解析单测（docs/13 功能轨第 11 项）
import { describe, expect, it } from 'vitest';
import { rateLimitBackoffMs } from './rate-limit.js';

const NOW = 1_800_000_000_000; // 固定时基

describe('rateLimitBackoffMs（精确退避计算）', () => {
  it('Retry-After 秒数：整秒向上取整', () => {
    expect(rateLimitBackoffMs(new Headers({ 'retry-after': '30' }), NOW)).toBe(30_000);
    expect(rateLimitBackoffMs(new Headers({ 'retry-after': '1.5' }), NOW)).toBe(2000);
    expect(rateLimitBackoffMs(new Headers({ 'retry-after': '0' }), NOW)).toBe(0);
  });

  it('Retry-After HTTP 日期：未来=差值，过去=1000ms 下限', () => {
    const future = new Date(NOW + 45_000).toUTCString();
    expect(rateLimitBackoffMs(new Headers({ 'retry-after': future }), NOW)).toBe(45_000);
    const past = new Date(NOW - 60_000).toUTCString();
    expect(rateLimitBackoffMs(new Headers({ 'retry-after': past }), NOW)).toBe(1000);
  });

  it('X-RateLimit-Remaining=0 + Reset：unix 秒精确差值；reset 已过 → 1000ms', () => {
    const resetSec = Math.floor(NOW / 1000) + 120;
    expect(rateLimitBackoffMs(new Headers({
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec)
    }), NOW)).toBeGreaterThanOrEqual(119_000);
    const pastSec = Math.floor(NOW / 1000) - 5;
    expect(rateLimitBackoffMs(new Headers({
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(pastSec)
    }), NOW)).toBe(1000);
  });

  it('Remaining=0 但无有效 reset → 保守 60s（确认限流，时长未知）', () => {
    expect(rateLimitBackoffMs(new Headers({ 'x-ratelimit-remaining': '0' }), NOW)).toBe(60_000);
    expect(rateLimitBackoffMs(new Headers({
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'garbage'
    }), NOW)).toBe(60_000);
  });

  it('非限流特征 → null（remaining 非零 / 无头 / Retry-After 优先于 remaining）', () => {
    expect(rateLimitBackoffMs(new Headers({ 'x-ratelimit-remaining': '42' }), NOW)).toBeNull();
    expect(rateLimitBackoffMs(new Headers({}), NOW)).toBeNull();
    // Retry-After 与 remaining=0 并存 → Retry-After 优先
    expect(rateLimitBackoffMs(new Headers({
      'retry-after': '7', 'x-ratelimit-remaining': '0'
    }), NOW)).toBe(7000);
  });
});
