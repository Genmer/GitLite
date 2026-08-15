// 离线提交队列：写操作先落盘再返回（NFR-4）；append-only 日志（O(1) 追加）；
// 按 collection+id 语义在重放时合并；重启重放（FR F5）
import type { FsAdapter } from '../runtime.js';
import type { Document } from '../types.js';

export type QueueOp =
  | { kind: 'upsert'; collection: string; doc: Document }
  | { kind: 'delete'; collection: string; id: string };

export class CommitQueue {
  /** 内存合并视图：key = `${collection}::${id}` → 最后一次写胜出 */
  private ops = new Map<string, QueueOp>();
  private loaded = false;

  constructor(private fs: FsAdapter | null, private path: string) {}

  /** 追加一行日志（崩溃安全：单行 append；半行由 load 容错跳过） */
  async enqueue(op: QueueOp): Promise<void> {
    const key = keyOf(op);
    this.ops.set(key, op);
    if (!this.fs) return;
    const dir = this.path.slice(0, this.path.lastIndexOf('/'));
    if (dir && !(await this.fs.exists(this.path))) await this.fs.mkdir(dir);
    await this.fs.appendFile(this.path, JSON.stringify(op) + '\n');
  }

  size(): number { return this.ops.size; }

  snapshot(): QueueOp[] { return [...this.ops.values()]; }

  /** flush 成功后清空（截断日志） */
  async clear(): Promise<void> {
    this.ops.clear();
    if (this.fs) await this.fs.writeFile(this.path, '');
  }

  /** 进程重启后恢复遗留队列（F5/F3） */
  async load(): Promise<QueueOp[]> {
    if (!this.fs || this.loaded) return this.snapshot();
    this.loaded = true;
    try {
      if (!(await this.fs.exists(this.path))) return this.snapshot();
      const raw = await this.fs.readFile(this.path);
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const op = JSON.parse(line) as QueueOp;
          this.ops.set(keyOf(op), op);
        } catch { /* 半行（崩溃残留）跳过 */ }
      }
    } catch {
      // 日志不可读：丢弃（远端仍是 source of truth），不阻断连接
    }
    return this.snapshot();
  }
}

function keyOf(op: QueueOp): string {
  return `${op.collection}::${op.kind === 'upsert' ? op.doc._id : op.id}`;
}
