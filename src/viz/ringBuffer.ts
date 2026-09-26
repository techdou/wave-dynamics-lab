/**
 * 定容环形缓冲 —— src/viz 通用纯逻辑（SPEC §7.3 / §15）
 * η(t) 时间序列（≥512 点 @ 20Hz）与浮标轨迹拖尾共用。
 * 写满后覆盖最旧样本；纯数据结构，不依赖 DOM，可在 node 下测试。
 */
export interface RingBuffer<T> {
  readonly capacity: number;
  readonly length: number;
  /** 追加样本；容量已满时丢弃最旧样本 */
  push(item: T): void;
  /** 按时间序取第 index 个样本（0 = 最旧）；越界返回 undefined */
  at(index: number): T | undefined;
  /** 最新一个样本；空缓冲返回 undefined */
  latest(): T | undefined;
  /** 按时间序（最旧 → 最新）导出全部样本 */
  toArray(): T[];
  clear(): void;
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const cap = Math.max(1, Math.floor(capacity));
  // 槽位固定，head 指向最旧元素；写满后 head 前移实现"覆盖最旧"
  const slots: Array<T | undefined> = new Array<T | undefined>(cap);
  let head = 0;
  let count = 0;

  return {
    capacity: cap,

    get length(): number {
      return count;
    },

    push(item: T): void {
      const writeIndex = (head + count) % cap;
      slots[writeIndex] = item;
      if (count < cap) {
        count += 1;
      } else {
        head = (head + 1) % cap;
      }
    },

    at(index: number): T | undefined {
      if (!Number.isInteger(index) || index < 0 || index >= count) return undefined;
      const slot = slots[(head + index) % cap];
      return slot;
    },

    latest(): T | undefined {
      if (count === 0) return undefined;
      const slot = slots[(head + count - 1) % cap];
      return slot;
    },

    toArray(): T[] {
      const out: T[] = new Array(count);
      for (let i = 0; i < count; i++) {
        const slot = slots[(head + i) % cap];
        if (slot !== undefined) out[i] = slot;
      }
      return out;
    },

    clear(): void {
      slots.fill(undefined);
      head = 0;
      count = 0;
    },
  };
}
