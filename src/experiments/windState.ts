/**
 * 实验一 · 风浪发展状态分类器（纯函数，无副作用）。
 *
 * 阈值依据（docs/SPEC.md §9.1 形态连续谱 + §16 模型清单 #3/#6）：
 *   - 平静：U < 0.3 m/s 或风时 = 0 —— 与 physics 骨架 buildWindComponents
 *     的"无分量"判据完全一致（分量列表为空 ⇒ 镜面）；
 *   - 毛细波：0.3 ≤ U < 2 m/s（涟漪尺度，教学分段）；
 *   - 白帽：U ≥ 15 m/s（SPEC §9.1"U≥15 白帽出现"；physics 白帽强度 =
 *     0.6·陡度项 + 0.4·风速项（(U−10)/15 门控，10→25 m/s 线性），教学标定
 *     15 m/s @60min ≈ 0.44，与任务一阈值 0.3 衔接，见 waveField.ts WC_* 常量）；
 *   - 局部破碎：U ≥ 24 m/s（SPEC §9.1）；
 *   - 成熟风浪：风时 ≥ 30 min（教学约定判定点；physics 成长模型为
 *     JONSWAP 幂律 + 充分发展封顶，30 min 处接近但未严格线性到达成熟）；
 *   - 其余（U ≥ 2 且风时 < 30）：发展中的重力波。
 */
import type { WindExperimentParams } from '../core/types';
import type { WindDevelopmentState } from './types';

/** 平静阈值（m/s）：低于此值 physics 不生成任何分量 */
export const WIND_CALM_SPEED_THRESHOLD = 0.3;
/** 毛细波上限（m/s）：教学分段，≥ 2 m/s 进入重力波段 */
export const WIND_CAPILLARY_SPEED_MAX = 2;
/** 成熟风浪风时（min）：教学约定的成熟判定点（physics 幂律成长此处接近充分发展） */
export const WIND_MATURE_DURATION_MIN = 30;
/** 白帽出现风速（m/s），SPEC §9.1 */
export const WIND_WHITECAP_SPEED = 15;
/** 局部破碎风速（m/s），SPEC §9.1 */
export const WIND_BREAKING_SPEED = 24;

/**
 * 风浪发展状态判定（确定性纯函数，可被任务系统复现）。
 * 判定顺序即优先级：平静 > 局部破碎 > 白帽 > 成熟 > 发展中 > 毛细波。
 */
export function classifyWindDevelopment(
  p: WindExperimentParams,
): WindDevelopmentState {
  if (p.windSpeed < WIND_CALM_SPEED_THRESHOLD || p.windDuration <= 0) {
    return 'calm';
  }
  if (p.windSpeed >= WIND_BREAKING_SPEED) return 'breaking';
  if (p.windSpeed >= WIND_WHITECAP_SPEED) return 'whitecap';
  if (p.windDuration >= WIND_MATURE_DURATION_MIN) return 'mature';
  if (p.windSpeed >= WIND_CAPILLARY_SPEED_MAX) return 'developing';
  return 'capillary';
}

/** 状态中文名（UI 直接显示） */
export const WIND_DEVELOPMENT_LABELS: Record<WindDevelopmentState, string> = {
  calm: '平静',
  capillary: '毛细波',
  developing: '发展中的重力波',
  mature: '成熟风浪',
  whitecap: '白帽',
  breaking: '局部破碎',
};
