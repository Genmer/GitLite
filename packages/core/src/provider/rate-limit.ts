// 限流响应头精确解析（docs/13 功能轨第 11 项收尾）：GitHub/Gitee 共用。
// 优先级：Retry-After（秒数或 HTTP 日期，次级限流标准头）> X-RateLimit-Remaining=0 + X-RateLimit-Reset（unix 秒）。
// 返回 null = 无法识别为限流（403 可能只是权限问题，不应误报限流）。

/** @returns 精确退避毫秒；null = 该响应不能识别为限流 */
export function rateLimitBackoffMs(headers: Headers, now: number = Date.now()): number | null {
  const ra = headers.get('retry-after');
  if (ra !== null && ra !== '') {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs) * 1000;
    const at = Date.parse(ra);                       // HTTP-date 形态（RFC 7231）
    if (!Number.isNaN(at)) return Math.max(at - now, 1000);
  }
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining === '0') {
    const reset = Number(headers.get('x-ratelimit-reset') ?? '');
    if (Number.isFinite(reset) && reset > 0) {
      const resetMs = reset * 1000;
      return resetMs > now ? resetMs - now : 1000;    // reset 已过 → 窗口刚滚动，小退避即可
    }
    return 60_000;                                   // 确认限流但无 reset（Gitee 头不规整）→ 保守 60s
  }
  return null;
}
