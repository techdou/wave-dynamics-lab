/**
 * 任务元数据与判定阈值 —— src/tasks 模块私有（docs/SPEC.md §7.5）。
 * TASK_THRESHOLDS 是六个判定器唯一数值来源；
 * 学生可见文案（目标 / 预测提示 / 知识总结）集中在此维护，UI 层不得另造一套。
 */
import type { TaskId } from '../core/types';

/** 六个任务执行顺序（与 core INITIAL_TASKS 一致） */
export const TASK_ORDER: readonly TaskId[] = [
  'whitecap',
  'max-amplitude',
  'zero-amplitude',
  'beating',
  'grid-pattern',
  'unknown-sea',
];

/** 判定阈值（单位见字段名）：键名与 TaskId 一致；调整难度只改这里，判定器与测试自动跟随 */
export const TASK_THRESHOLDS = {
  whitecap: {
    /** 白帽海况限定风速区间 [min, max] m/s */
    minWindSpeed: 15,
    maxWindSpeed: 30,
    /** whitecapIntensity() 达标线 */
    minIntensity: 0.3,
    /** 强度需稳定保持的观测时长（仿真秒），防误触 */
    sustainedSeconds: 5,
  },
  'max-amplitude': {
    /** 同频容差：|T_A − T_B| / T̄ */
    periodRelTol: 0.05,
    /** 同向容差：方向夹角（deg） */
    angleTolDeg: 5,
    /** 峰谷差达标线：≥ 单列波峰谷差 × 该系数 */
    peakTroughFactor: 1.8,
    sustainedSeconds: 4,
  },
  'zero-amplitude': {
    periodRelTol: 0.05,
    /** 振幅相等容差：|H_A − H_B| / max(H_A, H_B) */
    amplitudeRelTol: 0.05,
    /** 反相容差：|Δφ − 180°|（deg） */
    phaseTolDeg: 5,
    /** 残余峰谷差达标线：≤ 单列波峰谷差 × 该系数 */
    residualFactor: 0.2,
    sustainedSeconds: 4,
  },
  beating: {
    /** 失谐带宽 |T_A − T_B| / T̄ ∈ [min, max]：小而非零 */
    detuneMin: 0.1,
    detuneMax: 0.3,
    /** 包络对比度下限：(a_A + a_B) / |a_A − a_B| ≥ 该值（2:1 起伏） */
    envelopeContrastMin: 2,
    /** 拍周期测量容差（相对理论值 T_A·T_B/|T_A−T_B|） */
    beatPeriodRelTol: 0.2,
    sustainedSeconds: 5,
  },
  'grid-pattern': {
    /** 两波方向夹角带宽（deg，圆周角差） */
    angleMinDeg: 60,
    angleMaxDeg: 120,
    /** 可见性启发式：较弱振幅 / 较强振幅 ≥ 该值认为两波均可见 */
    visibilityRatio: 0.2,
    sustainedSeconds: 4,
  },
  'unknown-sea': {
    /** Hs 相对误差容差 */
    hsRelTol: 0.15,
    /** Tp 相对误差容差 */
    tpRelTol: 0.2,
  },
} as const;

/** 任务六提交一次后的真值/估值/误差记录（通过前真值不对外展示） */
export interface UnknownSeaOutcome {
  truthHs: number;
  truthTp: number;
  estimateHs: number;
  estimateTp: number;
  hsErrorPct: number;
  tpErrorPct: number;
  passed: boolean;
}

export interface TaskMeta {
  /** 任务目标（学生第一眼看到的判定说明） */
  goal: string;
  /** 预测框占位提示（探究闭环第一步：先填预测） */
  predictionPrompt: string;
  /** 通过后的知识总结（同时作为 AI 总结 / TTS 的口播素材） */
  knowledge: string;
  /** 启发式判定说明（仅任务五） */
  heuristicNote?: string;
}

/** 六个任务的学生可见文案 */
export const TASK_META: Record<TaskId, TaskMeta> = {
  whitecap: {
    goal: '实验一：把风速调进白帽区间（15–30 m/s）并让白帽强度达标保持约 5 秒，期间用波高尺在浪尖处记录一次读数。',
    predictionPrompt: '预测：风速多大时海面开始出现白帽？波高会怎么变？',
    knowledge:
      '白帽浪是波峰失稳破碎的标志。教学模型用"局部波陡 + 风速门控"估计白帽强度：波陡越接近破碎极限、风速越大，白帽越强。年轻陡浪（风时短、浪未长熟）波高虽小但波峰更尖，反而更容易破碎发白。',
  },
  'max-amplitude': {
    goal: '实验二：让两列波同频、同向且相位对齐（相长干涉），使中央浮标处测得的峰谷高差达到单列波的约 1.8 倍以上。',
    predictionPrompt: '预测：相位差为多少时叠加振幅最大？最大峰谷差是单列波的几倍？',
    knowledge:
      '相长干涉：同频同向的两列波初相位一致时，叠加振幅等于两列振幅之和，峰谷高差达到单列波的 2 倍——这是线性叠加原理的直接体现，能量并未凭空产生。',
  },
  'zero-amplitude': {
    goal: '实验二：让两列波振幅相等、相位差约 180°（相消干涉），使浮标处峰谷高差降到单列波的 20% 以下。',
    predictionPrompt: '预测：怎样才能让海面几乎静止？静止后波浪的能量去哪了？',
    knowledge:
      '相消干涉：等幅、反相的两列波叠加后波面几乎完全抵消。能量没有消失，而是储存在相位相反的叠加场中；只要破坏"等幅"或"反相"任一条件，波面立刻恢复起伏。',
  },
  beating: {
    goal: '实验二：设置相近但不相等的周期制造明显的拍：包络起伏达到 2:1 以上，并用秒表测出拍周期（理论值 T₁T₂/|T₁−T₂|，容差 ±20%）。',
    predictionPrompt: '预测：两个周期越接近，拍是变快还是变慢？拍周期怎么算？',
    knowledge:
      '拍：频率相近的两列简谐波叠加时，合成振幅以两频率之差缓慢起伏。拍频等于频率差，拍周期 = T₁T₂/|T₁−T₂|；周期差越小，包络起伏越慢、拍越"长"。',
  },
  'grid-pattern': {
    goal: '实验二：让两列波以 60°–120° 夹角交叉传播并保持两波均可见，观察格状干涉图样足够时间后提交确认。',
    predictionPrompt: '预测：夹角多大时格纹最清晰？格子形状随夹角怎么变？',
    knowledge:
      '交叉波：两列不同方向的波叠加，峰线与谷线交织成格状图样。交叉角越接近 90°，格子越接近正方形；夹角过小则退化为近乎同向的干涉条纹。',
    heuristicNote: '本任务含启发式判定：两波"均可见"与图样观察时长为近似准则，无法完全量化，判定结果供参考。',
  },
  'unknown-sea': {
    goal: '实验三：在未知海况模式下（理论值已隐藏），只用虚拟仪器估计有效波高 Hs 与谱峰周期 Tp 并提交；Hs 误差 ≤15% 且 Tp 误差 ≤20% 即通过。',
    predictionPrompt: '预测：你会用哪台仪器、什么步骤来估计 Hs 和 Tp？',
    knowledge:
      '有效波高 Hs ≈ 4√m₀，约等于最高三分之一波的平均波高，是海况等级的划分依据；谱峰周期 Tp 是能谱峰值频率的倒数，代表海浪中能量最集中的周期成分。实际海洋观测中两者都靠统计波面记录得到。',
  },
};
