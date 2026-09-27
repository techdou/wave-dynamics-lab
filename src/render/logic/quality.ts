/**
 * 渲染画质档位的自动降档判定（纯逻辑，可单测）。
 * 低配档只削减视觉开销：像素比 2→1、关闭 Bloom/水下扭曲/体积光三个
 * 后处理 pass（体积光遮罩等于每帧多渲染一遍海面几何，是隐藏大头）、
 * 泡沫积累缓冲隔帧更新。波形几何、物理量与仪器读数不受任何影响。
 */

/** 触发自动降档的平均帧时长阈值（ms），约 <30fps */
export const AUTO_DOWNGRADE_FRAME_MS = 34;
/** 启动预热期：前 N 秒不判定（页面加载/着色器首编译会拖慢首帧） */
export const AUTO_DOWNGRADE_WARMUP_S = 4;

/**
 * 自动降档判定（渲染循环每帧调用，滑动平均帧时长驱动）。
 * 条件全部满足才降：当前仍是高画质 + 尚未自动降过（只降不升，避免来回抖动）
 * + 已过预热期 + 平均帧时长超阈值。
 */
export function shouldAutoDowngrade(
  avgFrameMs: number,
  level: 'high' | 'low',
  alreadyDowngraded: boolean,
  elapsedSeconds: number,
): boolean {
  return (
    level === 'high' &&
    !alreadyDowngraded &&
    elapsedSeconds > AUTO_DOWNGRADE_WARMUP_S &&
    avgFrameMs > AUTO_DOWNGRADE_FRAME_MS
  );
}
