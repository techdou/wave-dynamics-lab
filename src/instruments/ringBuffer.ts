/**
 * instruments 内部定容环形缓冲 —— 与 src/viz/ringBuffer.ts 同语义的本地副本。
 * 架构铁律（SPEC §7）：跨 feature 运行时零 import，故不引用 viz 实现；
 * 浮标 η 缓冲与轨迹拖尾使用。纯数据结构，node 可测。
 */
export interface LocalRingBuffer<T> {
  readonly capacity: number;
  readonly length: number;
  push(item: T): void;
  at(index: number): T | undefined;
  latest(): T | undefined;
  toArray(): T[];
  clear(): void;
}

export function createLocalRingBuffer<T>(capacity: number): LocalRingBuffer<T> {
  const cap = Math.max(1, Math.floor(capacity));
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
      return slots[(head + index) % cap];
    },

    latest(): T | undefined {
      if (count === 0) return undefined;
      return slots[(head + count - 1) % cap];
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
