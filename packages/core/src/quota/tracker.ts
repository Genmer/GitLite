// 配额追踪：本地计数预算（FR K1/K2；响应头精确解析 v0.2，见 12 复核 F7）
export interface QuotaStatus {
  callsInWindow: number;
  maxPerHour: number;
  windowStart: number;
}

export class QuotaTracker {
  private calls = 0;
  private windowStart = Date.now();

  constructor(private maxPerHour: number) {}

  track(n = 1): void {
    this.rollWindow();
    this.calls += n;
  }

  canSpend(n: number): boolean {
    this.rollWindow();
    return this.calls + n <= this.maxPerHour;
  }

  status(): QuotaStatus {
    return { callsInWindow: this.calls, maxPerHour: this.maxPerHour, windowStart: this.windowStart };
  }

  private rollWindow(): void {
    if (Date.now() - this.windowStart >= 3_600_000) {
      this.calls = 0;
      this.windowStart = Date.now();
    }
  }
}
