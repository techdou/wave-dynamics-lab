/**
 * 物理常数、默认参数、参数范围、事件名常量 —— docs/SPEC.md §5.4
 * UI 校验、physics clamp、默认初始状态全部以本文件为唯一来源。
 */
import type { SimState, TaskProgress } from './types';

// ========== 物理常数（SI） ==========
export const G = 9.81; // 重力加速度 m/s²
export const SEA_WATER_DENSITY = 1025; // 海水密度 kg/m³
/** 默认水深（m）；Infinity = 深水近似。实验三浅水椭圆轨迹时可由参数覆盖 */
export const DEFAULT_WATER_DEPTH = Number.POSITIVE_INFINITY;
/** 波分量上限：直供渲染 uniform 数组长度，任何情况下不得超过 */
export const MAX_WAVE_COMPONENTS = 64;
export const DEFAULT_STEP_SECONDS = 1 / 60; // 固定仿真步长 s

// ========== store 事件名（跨模块通信唯一合法通道之一，见 SPEC §8） ==========
export const STORE_EVENTS = {
  EXPERIMENT_CHANGED: 'experiment:changed',
  PARAMS_CHANGED: 'params:changed',
  PLAYBACK_CHANGED: 'playback:changed',
  VIEW_CHANGED: 'view:changed',
  OVERLAYS_CHANGED: 'overlays:changed',
  INSTRUMENT_CHANGED: 'instrument:changed',
  MEASUREMENT_ADDED: 'measurement:added',
  TASKS_UPDATED: 'tasks:updated',
} as const;

// ========== 参数范围 schema（UI 滑块范围与 physics clamp 的唯一来源） ==========
export const PARAM_LIMITS = {
  wind: {
    windSpeed: [0, 30], // m/s
    windDuration: [0, 60], // min
    windDirection: [0, 360], // deg
  },
  interference: {
    amplitude: [0.05, 2], // m（波高 H）
    period: [0.5, 20], // s
    angle: [0, 360], // deg
    phase: [0, 360], // deg
  },
  spectrum: {
    windSpeed: [2, 30], // m/s
    fetch: [10000, 300000], // m
    peakEnhancement: [1, 7], // γ
  },
} as const;

// ========== 六个科研任务的初始进度（SPEC §11） ==========
export const INITIAL_TASKS: readonly TaskProgress[] = [
  {
    taskId: 'whitecap',
    title: '任务一 · 白帽浪观测',
    done: false,
    progress: 0,
    hint: '实验一：将风速提到能产生白帽浪的强度，记录一次波高尺在浪尖破碎处的读数。',
  },
  {
    taskId: 'max-amplitude',
    title: '任务二 · 振幅最大',
    done: false,
    progress: 0,
    hint: '实验二：调节两列波相位差，使叠加振幅达到最大（相长干涉），记录读数。',
  },
  {
    taskId: 'zero-amplitude',
    title: '任务三 · 振幅归零',
    done: false,
    progress: 0,
    hint: '实验二：让两列波振幅相等、相位差 180°，观察波面几乎静止并记录残差。',
  },
  {
    taskId: 'beating',
    title: '任务四 · 拍',
    done: false,
    progress: 0,
    hint: '实验二：设置相近但不同的周期，观察振幅包络的缓慢起伏，测出拍周期。',
  },
  {
    taskId: 'grid-pattern',
    title: '任务五 · 格状波',
    done: false,
    progress: 0,
    hint: '实验二：让两列波以 60°–120° 夹角传播，观察交叉格状干涉图样。',
  },
  {
    taskId: 'unknown-sea',
    title: '任务六 · 未知海况估计',
    done: false,
    progress: 0,
    hint: '实验三：在"未知海况"模式下仅用虚拟仪器测量，估计有效波高与谱峰周期。',
  },
];

// ========== 默认仿真状态（首次进入 = 实验一平静海面） ==========
export const DEFAULT_SIM_STATE: SimState = {
  experiment: 'wind',
  params: {
    // 初始给轻风海况：无风镜面在视觉上无法传达"海"，教学上从轻浪拖到白帽更直观
    wind: { windSpeed: 8, windDuration: 10, windDirection: 0 },
    interference: {
      makerA: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
      makerB: { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
    },
    spectrum: {
      kind: 'jonswap',
      windSpeed: 10,
      fetch: 50000,
      randomSeed: 42,
      peakEnhancement: 3.3,
      mystery: false,
    },
  },
  playback: { paused: false, scale: 1 },
  view: 'sea-surface',
  overlays: { showTrails: false, freezeWaveform: false },
  activeInstrument: null,
  probe: { x: 0, y: 0 },
  tasks: INITIAL_TASKS,
  measurements: [],
};
