/**
 * ============================================================
 * 全项目唯一类型契约 —— docs/SPEC.md §5
 * ============================================================
 * 任何跨模块共享的类型必须定义在本文件；
 * 模块私有类型放各自模块目录内。
 * 修改本文件 = 修改全项目契约，必须同步更新 SPEC.md 并知会七个模块工程师。
 *
 * 单位约定（全项目统一 SI）：
 *   长度 m、时间 s、频率 Hz、角度 API 层统一用「度」、
 *   波数与角频率等物理量在类型注释中标明单位。
 * 坐标约定（物理层，z 轴向上）：
 *   x 向右（东）、y 向前（北）、z 向上；水面静平衡面为 z=0。
 *   渲染层 Three.js 场景为 y-up，映射规则见 SPEC §6.2：sx=x, sy=z, sz=-y。
 */

// ========== 基础枚举 ==========

/** 三个递进实验 */
export type ExperimentId = 'wind' | 'interference' | 'spectrum';

/** 三种视角 */
export type ViewKind = 'sea-surface' | 'side-section' | 'underwater';

/** 渲染画质档位：low 只削减视觉开销（像素比/后处理/泡沫更新频率），物理与读数不变 */
export type QualityLevel = 'high' | 'low';

/** 播放倍速（需求只要求 1x / 2x） */
export type TimeScale = 1 | 2;

/** 虚拟仪器 */
export type InstrumentKind = 'wave-ruler' | 'stopwatch' | 'drifter-buoy';

/** 六个科研任务（顺序即任务一 ~ 任务六） */
export type TaskId =
  | 'whitecap'
  | 'max-amplitude'
  | 'zero-amplitude'
  | 'beating'
  | 'grid-pattern'
  | 'unknown-sea';

// ========== 通用向量 ==========

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ========== 三实验参数 schema ==========

/** 实验一：风浪生成机制参数 */
export interface WindExperimentParams {
  /** 风速，m/s，范围 [0, 30] */
  windSpeed: number;
  /** 风时（风吹持续时间），min，范围 [0, 60] */
  windDuration: number;
  /** 风向，deg，范围 [0, 360)；0° 表示沿 +y（北）传播 */
  windDirection: number;
}

/** 实验二：单个造波机参数 */
export interface WaveMakerParams {
  /** 造波波高 H（m），范围 [0.05, 2]；内部物理分量振幅 = H/2 */
  amplitude: number;
  /** 波周期 T（s），范围 [0.5, 20] */
  period: number;
  /** 传播方向 θ（deg），范围 [0, 360)；0° = 沿 +y */
  angle: number;
  /** 初相位 φ（deg），范围 [0, 360) */
  phase: number;
}

/** 实验二：双造波机叠加参数 */
export interface InterferenceExperimentParams {
  makerA: WaveMakerParams;
  makerB: WaveMakerParams;
}

/** 实验三：海浪谱类型 */
export type SpectrumKind = 'pm' | 'jonswap';

/** 实验三：不规则随机海况参数 */
export interface SpectrumExperimentParams {
  kind: SpectrumKind;
  /** 19.5 m 高度等效风速 U（m/s），范围 [2, 30] */
  windSpeed: number;
  /** 风区长度 F（m），范围 [1e4, 3e5]，仅 JONSWAP 有效 */
  fetch: number;
  /** 随机相位种子（同种子 ⇒ 同一海况，保证可复现） */
  randomSeed: number;
  /** JONSWAP 峰升高因子 γ，范围 [1, 7]，PM 时忽略 */
  peakEnhancement: number;
  /** 未知海况模式（教师端开启：隐藏理论值，仅供任务六） */
  mystery: boolean;
}

/** 三实验参数合集（SimState.params 的形状） */
export interface SimParams {
  wind: WindExperimentParams;
  interference: InterferenceExperimentParams;
  spectrum: SpectrumExperimentParams;
}

// ========== 运行时状态 ==========

export interface PlaybackState {
  paused: boolean;
  scale: TimeScale;
}

/** 可视化叠加开关 */
export interface OverlayState {
  /** 水质点示踪轨迹显示 */
  showTrails: boolean;
  /** 冻结波形（暂停空间形态、只走时间，用于观察质点轨迹） */
  freezeWaveform: boolean;
}

/** 探针位置（水平坐标，m）：η(t) 时间序列 / 波高尺的采样点 */
export interface ProbeState {
  x: number;
  y: number;
}

export interface TaskProgress {
  taskId: TaskId;
  title: string;
  done: boolean;
  /** 中间进度 0..1，无中间进度语义的任务恒为 0 或 1 */
  progress: number;
  hint: string;
}

/** 一次仪器测量记录 */
export interface MeasurementRecord {
  id: string;
  tool: InstrumentKind;
  /** 记录时刻：仿真时间（s） */
  simTime: number;
  /** 测量值集合，键名由各仪器模块定义并写入 SPEC §12（如 waveHeight、period、eta） */
  values: Record<string, number>;
  note?: string;
}

/** 统一仿真状态（单一数据源，见 SPEC §9 数据闭环） */
export interface SimState {
  experiment: ExperimentId;
  params: SimParams;
  playback: PlaybackState;
  view: ViewKind;
  overlays: OverlayState;
  /** 当前激活仪器，null = 未激活 */
  activeInstrument: InstrumentKind | null;
  /** 采样探针位置（水平坐标 m） */
  probe: ProbeState;
  tasks: readonly TaskProgress[];
  measurements: readonly MeasurementRecord[];
}

// ========== 物理数据接口（physics 数据接口，见 SPEC §6） ==========

/**
 * 单个波分量（线性叠加模型的基元，≤ MAX_WAVE_COMPONENTS 个，直供渲染 uniform）。
 * 波面：η = Σ amp·sin(kx·x + ky·y − ω·t + phase)
 */
export interface WaveComponent {
  /** 振幅 a（m） */
  amp: number;
  /** 波数 x 分量（rad/m） */
  kx: number;
  /** 波数 y 分量（rad/m） */
  ky: number;
  /** 角频率 ω（rad/s） */
  omega: number;
  /** 初相位（rad） */
  phase: number;
  /** Gerstner 陡度因子 q（无量纲；水平位移幅度 = q·amp。骨架实现恒为 0） */
  steepness: number;
}

/** 波面采样：高度 + 单位法线（物理坐标系，z-up） */
export interface SurfaceSample {
  /** 波面高度 η（m） */
  eta: number;
  /** 单位法线（模长 1） */
  normal: Vec3;
}

/** 理论海况摘要（仪器"对答案"的唯一依据，见 SPEC §12） */
export interface SeaStateSummary {
  /** 有效波高 Hs（m） */
  hs: number;
  /** 谱峰周期 Tp（s） */
  tp: number;
  /** 谱峰频率 fp（Hz） */
  peakFrequency: number;
  /** 主波长 λ（m，深水色散） */
  wavelength: number;
}

// ========== store 通用类型 ==========

export type Listener<T> = (state: T, prev: T) => void;

export type Unsubscribe = () => void;
