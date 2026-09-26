/**
 * 确定性伪随机数 —— src/physics 内部共享
 * ============================================================
 * 教学红线：所有"随机"相位必须来自固定种子的可复现序列，
 * 禁止 Math.random()（同一海况必须可复现，测试才可稳定断言）。
 */

/** mulberry32：同种子 ⇒ 同序列（与骨架实现逐位一致） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [0,1) 均匀样本的确定性洗牌（Fisher–Yates），返回新数组 */
export function shuffledIndices<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
