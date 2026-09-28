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

// ========== 连续动态分辨率（借鉴 Clearwater 的 adaptive quality） ==========
// 与上面的两档自动降档互补：档位决定「特性开关」，renderScale 在档位内
// 连续调节像素比——帧时长超阈值先降分辨率（视觉连续），实在不行才降档。

/** 动态分辨率下限（相对当前档位基准像素比的比例） */
export const RENDER_SCALE_MIN = 0.6;
export const RENDER_SCALE_MAX = 1.0;
/** 降采样触发阈值：滑动平均帧时长超过它则缩小 renderScale */
export const RENDER_SCALE_DOWN_MS = 30;
/** 回升阈值：帧时长低于它才有富余放大。取 17.5 覆盖 60 Hz 垂直同步
 *  （rAF 间隔 ≈16.7 ms 恒高于渲染耗时，阈值低于它会使 60 Hz 屏永远无法恢复）；
 *  与降阈值 30 之间保持足够滞回区间防抖 */
export const RENDER_SCALE_UP_MS = 17.5;
/** 每步缩放系数（降多升少：掉帧要快速响应，恢复要保守） */
export const RENDER_SCALE_DOWN_FACTOR = 0.92;
export const RENDER_SCALE_UP_FACTOR = 1.04;
/** 调整间隔（s）：给滑动平均留出反应时间，连续跳变只会闪烁 */
export const RENDER_SCALE_INTERVAL_S = 0.5;

/**
 * 下一个 renderScale（每 RENDER_SCALE_INTERVAL_S 调用一次）。
 * avgFrameMs 为滑动平均帧时长；返回值已钳位到 [MIN, MAX]，调用方
 * 与当前值差异 >1% 时应用（setPixelRatio + composer 同步）。
 */
export function nextRenderScale(current: number, avgFrameMs: number): number {
  let next = current;
  if (avgFrameMs > RENDER_SCALE_DOWN_MS) {
    next = current * RENDER_SCALE_DOWN_FACTOR;
  } else if (avgFrameMs < RENDER_SCALE_UP_MS) {
    next = current * RENDER_SCALE_UP_FACTOR;
  }
  return Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, next));
}
