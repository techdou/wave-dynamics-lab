/**
 * 示踪粒子多层深度布点（纯逻辑，供单元测试）。
 * 全部布在物理 x=0 剖面平面内——侧视剖面视角恰好穿过所有示踪点，
 * 质点轨道（深水圆/浅水椭圆）在剖面中直接可见。
 */
export interface TracerSpec {
  /** 物理水平坐标 x（m） */
  x: number;
  /** 物理水平坐标 y（m，传播方向） */
  y: number;
  /** 静水深 z（m，≤0；0 = 近表层） */
  z: number;
}

/** 布点深度（物理 z，m）：近表层 → 深水，覆盖 e^{kz} 衰减的可视范围 */
export const TRACER_DEPTHS = [-0.35, -1.5, -4, -9, -18] as const;

/** 每层沿传播方向（物理 y）的水平布点（m） */
export const TRACER_ALONG_Y = [-24, -12, 0, 12, 24] as const;

/** 笛卡尔积布点：alongY × depths，共 25 粒 */
export function buildTracerLayout(
  depths: readonly number[],
  alongY: readonly number[],
): TracerSpec[] {
  const specs: TracerSpec[] = [];
  for (const y of alongY) {
    for (const z of depths) {
      specs.push({ x: 0, y, z });
    }
  }
  return specs;
}

export function defaultTracerLayout(): TracerSpec[] {
  return buildTracerLayout(TRACER_DEPTHS, TRACER_ALONG_Y);
}
