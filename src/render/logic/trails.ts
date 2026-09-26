/**
 * 示踪粒子拖尾环形缓冲（纯逻辑，供单元测试）。
 * 「显示轨迹」= 保留最近 windowSeconds 秒的位置序列；
 * 容量硬上限 capacity，窗口滑动自动淘汰更老的点。
 * 线程约定：push 的时间戳必须单调不减（仿真时钟保证）。
 */
export class RingTrail {
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private readonly zs: Float32Array;
  private readonly ts: Float64Array;
  private head = 0; // 最老元素索引
  private size = 0;
  private newestT = Number.NEGATIVE_INFINITY;

  constructor(
    readonly capacity: number,
    readonly windowSeconds: number,
  ) {
    this.xs = new Float32Array(capacity);
    this.ys = new Float32Array(capacity);
    this.zs = new Float32Array(capacity);
    this.ts = new Float64Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  /** 追加一个采样点；同时淘汰窗口之外的点与超容量最老点 */
  push(x: number, y: number, z: number, t: number): void {
    if (t < this.newestT) t = this.newestT; // 容错：保证窗口单调
    if (this.size < this.capacity) {
      this.size += 1;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    const i = (this.head + this.size - 1) % this.capacity;
    this.xs[i] = x;
    this.ys[i] = y;
    this.zs[i] = z;
    this.ts[i] = t;
    this.newestT = t;

    // 滑窗淘汰：t < newest − window 的头部点全部丢弃
    const cutoff = t - this.windowSeconds;
    while (
      this.size > 1 &&
      (this.ts[this.head] ?? t) < cutoff
    ) {
      this.head = (this.head + 1) % this.capacity;
      this.size -= 1;
    }
  }

  /**
   * 按时间从旧到新把位置写入 out（长度须 ≥ capacity·3），返回写入点数。
   * 供每帧重建 Line 顶点缓冲。
   */
  writePositions(out: Float32Array): number {
    const n = Math.min(this.size, Math.floor(out.length / 3));
    for (let i = 0; i < n; i++) {
      const src = (this.head + i) % this.capacity;
      out[i * 3] = this.xs[src] ?? 0;
      out[i * 3 + 1] = this.ys[src] ?? 0;
      out[i * 3 + 2] = this.zs[src] ?? 0;
    }
    return n;
  }

  /** 最近一个采样点（无采样时返回 null） */
  last(): { x: number; y: number; z: number; t: number } | null {
    if (this.size === 0) return null;
    const i = (this.head + this.size - 1) % this.capacity;
    return {
      x: this.xs[i] ?? 0,
      y: this.ys[i] ?? 0,
      z: this.zs[i] ?? 0,
      t: this.ts[i] ?? 0,
    };
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.newestT = Number.NEGATIVE_INFINITY;
  }
}
