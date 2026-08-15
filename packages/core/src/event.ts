// 轻量事件总线（FR I3）
export type Listener = (payload: any) => void;

export class EventBus {
  private map = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): () => void {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event)!.add(fn);
    return () => { this.map.get(event)?.delete(fn); };
  }

  emit(event: string, payload?: any): void {
    this.map.get(event)?.forEach(fn => {
      try { fn(payload); } catch { /* listener 隔离 */ }
    });
  }

  listenerCount(event: string): number {
    return this.map.get(event)?.size ?? 0;
  }
}
