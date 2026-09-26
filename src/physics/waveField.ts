/**
 * ============================================================
 * 物理层契约：WaveField —— docs/SPEC.md §6（实现版 v1.0）
 * ============================================================
 * 【签名即最终契约】本文件相对骨架仅替换函数体实现，
 * 所有导出签名、类型与语义未改动（含 WaveFieldDeps/WaveField/WaveComponent 契约）。
 *
 * 实现概要（数学细节与教学简化声明见 src/physics/MODELS.md）：
 *  - 统一波场：三种实验共用同一条 ≤64 个 WaveComponent 的分量列表（渲染 uniform 直供）；
 *  - 色散：ω² = g·k·tanh(kh)，牛顿迭代由 ω 反解 k（dispersion.ts，含浅水守卫）；
 *  - 实验一：SPM/JONSWAP 量纲一致成长律，风时限制与风区限制取较小者，
 *    再以充分发展（PM）封顶 —— 简化教学模型，非完整海洋数值模型；
 *  - 实验二：双列规则波多正弦/Gerstner 叠加（方向角+初相位直给；
 *    陡度 q 满足 q·k·a ≤ 0.3、两分量合计 < 1 防卷绕自交）；
 *  - 实验三：PM/JONSWAP 谱 48 分量离散（0.5fp–4fp 中点频箱、cos² 方向分布
 *    分层采样、固定种子可复现相位，禁用真随机）；
 *  - 平滑过渡：真突变（实验切换、谱种子、谱型切换）后，显示分量以时间常数
 *    τ≈1 s 指数趋近目标（仿真时间驱动；挂钟仅兜底无仿真时间锚点的调用路径，
 *    暂停/冻结波形时过渡同步冻结），海面 1 秒内可见响应；
 *    连续参数按 SPEC §9.1"公式连续 ⇒ 分量连续"直接取目标态（拖动无滞后）；
 *    理论值（observedSeaState/spectrum/whitecapIntensity）恒读目标态（确定性），
 *    可视量（components/evalSurface/particleOrbit）读过渡中的显示态；
 *    相同输入参数（含种子）⇒ 相同目标分量；过渡完成（约 7 s 后）components()
 *    即为目标分量，且新鲜实例首次 configure 无过渡（直接目标态）。
 *  - 所有外部输入 clamp + NaN 守卫（风速 0–30、风时 0–60 min、波高 0–2、
 *    周期 0.5–20 s、Hs ≤ 10 等，边界值来源 core/constants.PARAM_LIMITS）。
 */
import { DEFAULT_WATER_DEPTH, MAX_WAVE_COMPONENTS } from '../core/constants';
import type {
  ExperimentId,
  InterferenceExperimentParams,
  SeaStateSummary,
  SimParams,
  SpectrumExperimentParams,
  SurfaceSample,
  Vec3,
  WindExperimentParams,
  WaveComponent,
} from '../core/types';
import { solveWaveNumber, wavelengthFromOmega } from './dispersion';
import {
  jonswapAlpha,
  jonswapPeakFrequency,
  jonswapSpectrum,
  pmPeakFrequency,
  pmSpectrum,
  PM_ALPHA,
} from './spectra';
import { clampNum, windGrowth, type WindGrowthResult } from './growth';
import { mulberry32, shuffledIndices } from './random';

export interface WaveFieldDeps {
  /** 水深（m），默认 Infinity = 深水近似；有限值用于浅水椭圆轨迹 */
  depth?: number;
  /** 受种子控制的伪随机数工厂（实验三随机相位）。默认内置 mulberry32 */
  rngFactory?: (seed: number) => () => number;
}

export interface WaveField {
  readonly depth: number;
  /**
   * 应用实验参数（全量替换式，非增量）。切换实验或任意参数变化后必须调用。
   * 实现必须保证：相同输入参数（含随机种子）⇒ 相同分量输出。
   */
  configure(experiment: ExperimentId, params: SimParams): void;
  /** 当前波分量（长度 ≤ 64，只读）；渲染层据此填充 uniform */
  components(): readonly WaveComponent[];
  /** 采样波面：返回 η 与单位法线（物理坐标系 z-up） */
  evalSurface(x: number, y: number, t: number): SurfaceSample;
  /**
   * 水质点轨迹：位于 (x,y) 水平位置、静水深 z（≤0）处的水团在 t 时刻的瞬时坐标。
   * 深水 ⇒ 圆轨迹；有限深水 ⇒ 椭圆轨迹（浅水椭圆压扁）。
   */
  particleOrbit(x: number, y: number, z: number, t: number): Vec3;
  /** 海浪谱密度 S(f)（m²·s）。实验一/二返回 0（非谱海况）；f 单位 Hz */
  spectrum(f: number): number;
  /** 白帽浪强度，[0,1]（教学经验映射，见 SPEC §16） */
  whitecapIntensity(): number;
  /** 理论海况摘要：仪器对答案与 AI 上下文的唯一依据 */
  observedSeaState(): SeaStateSummary;
}

// ============================================================
// 实现细节（导出契约之上均为模块内部）
// ============================================================

const degToRad = (deg: number): number => (deg * Math.PI) / 180;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 波面叠加用稳定种子：实验一相位只依赖种子，不随 U/风时重排（SPEC §9.1 连续过渡） */
const WIND_PHASE_SEED = 20260924;
/** 实验一分量数（< MAX_WAVE_COMPONENTS=64） */
const WIND_COMPONENT_COUNT = 24;
/** 实验三分量数（≈48，SPEC §13 教学离散） */
const SPECTRUM_COMPONENT_COUNT = 48;
/** 实验一无风区滑块：教学固定风区（m），见 MODELS.md §2（集成期开放导出供测试对齐） */
export const WIND_TEACHING_FETCH = 1e5;

/** Gerstner 防卷绕：单分量 q·k·a 上限；两分量合计 ≤ 0.6 < 1（波面保持单值图像） */
const GERSTNER_QKA_MAX = 0.3;
/** Gerstner 每分量 q 硬上限（水平位移 ≤ 0.35·振幅，避免小振幅长周期波的荒诞水平位移） */
const GERSTNER_Q_MAX = 0.35;

/** 白帽教学标定（实验一/三，"局部陡度" ak = k_p·Hs/2 与风速门控加权）：
 *  5 m/s 无白帽；15 m/s @60min ≈ 0.44（任务一阈值 0.3 可达）；24 m/s ≈ 0.87；30 m/s 饱和 */
const WC_AK_ONSET = 0.115;
const WC_AK_FULL = 0.17;
const WC_U_ONSET = 10;
const WC_U_FULL = 25;
const WC_STEEP_WEIGHT = 0.6;
const WC_WIND_WEIGHT = 0.4;
/** 实验二白帽：最大局部陡度 s = q·k·a 的教学映射（s=0.157 对应单波 H/L≈1/7 破碎临界） */
const WC_INTERF_ONSET = 0.05;
const WC_INTERF_FULL = 0.3;

/** 平滑过渡：时间常数（s）与吸附阈值（elapsed ≥ SNAP 后 components() 严格等于目标） */
const TRANSITION_TAU = 1.0;
const TRANSITION_SNAP_SECONDS = 7;

/** 消毒后的参数快照（全部为有限数，configure 时一次算好） */
interface MakerS {
  amplitude: number;
  period: number;
  angleRad: number;
  phaseRad: number;
}
interface WindParamsS {
  windSpeed: number;
  windDuration: number;
  windDirectionRad: number;
}
interface SpectrumParamsS {
  kind: SpectrumExperimentParams['kind'];
  windSpeed: number;
  fetch: number;
  randomSeed: number;
  peakEnhancement: number;
}

function sanitizeWind(p: WindExperimentParams | undefined): WindParamsS {
  const speed = p ? clampNum(p.windSpeed, 0, 30) : 0;
  const duration = p ? clampNum(p.windDuration, 0, 60) : 0;
  const dirDeg = p ? clampNum(p.windDirection, 0, 360) % 360 : 0;
  return { windSpeed: speed, windDuration: duration, windDirectionRad: degToRad(dirDeg) };
}

function sanitizeMaker(p: InterferenceExperimentParams['makerA'] | undefined): MakerS {
  // 波高下界取 0（"造波机关闭"）：UI 仍按 PARAM_LIMITS 的 [0.05,2] 校验，
  // 物理层放宽到 0 以支持"单波/全静"教学场景（如骨架测试的零振幅分量）。
  const amplitude = p ? clampNum(p.amplitude, 0, 2) : 0;
  const period = p ? clampNum(p.period, 0.5, 20) : 4;
  const angleDeg = p ? clampNum(p.angle, 0, 360) % 360 : 0;
  const phaseDeg = p ? clampNum(p.phase, 0, 360) % 360 : 0;
  return { amplitude, period, angleRad: degToRad(angleDeg), phaseRad: degToRad(phaseDeg) };
}

function sanitizeSpectrum(p: SpectrumExperimentParams | undefined): SpectrumParamsS {
  const kind = p && (p.kind === 'pm' || p.kind === 'jonswap') ? p.kind : 'jonswap';
  return {
    kind,
    windSpeed: p ? clampNum(p.windSpeed, 2, 30) : 10,
    fetch: p ? clampNum(p.fetch, 1e4, 3e5) : 5e4,
    randomSeed: p && Number.isFinite(p.randomSeed) ? p.randomSeed >>> 0 : 42,
    peakEnhancement: p ? clampNum(p.peakEnhancement, 1, 7) : 3.3,
  };
}

/** 分量列表深度比较（过渡收敛判定：参数未变 ⇒ 不建过渡，输出确定性） */
function componentsEqual(a: readonly WaveComponent[], b: readonly WaveComponent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a[i] as WaveComponent;
    const cb = b[i] as WaveComponent;
    if (
      Math.abs(ca.amp - cb.amp) > 1e-12 ||
      Math.abs(ca.kx - cb.kx) > 1e-12 ||
      Math.abs(ca.ky - cb.ky) > 1e-12 ||
      Math.abs(ca.omega - cb.omega) > 1e-12 ||
      Math.abs(ca.phase - cb.phase) > 1e-12 ||
      Math.abs(ca.steepness - cb.steepness) > 1e-12
    ) {
      return false;
    }
  }
  return true;
}

function zeroAmpLike(c: WaveComponent): WaveComponent {
  return { amp: 0, kx: c.kx, ky: c.ky, omega: c.omega, phase: c.phase, steepness: c.steepness };
}

/** 最短弧相位插值（避免 359°→1° 之类的反向长程旋转） */
function lerpAngle(a: number, b: number, p: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return a + d * p;
}

/**
 * 过渡态混合：逐序号配对新旧分量。
 * 振幅/角频率/陡度线性插值、相位最短弧插值、方向单位向量插值后
 * 由色散关系重建 k（保证任意过渡时刻 k 与 ω 严格满足 ω²=g·k·tanh(kh)）。
 * 一侧缺项用零振幅补齐 ⇒ 分量数不同的两次 configure 也能平滑交叉淡化。
 */
function blendComponents(
  from: readonly WaveComponent[],
  to: readonly WaveComponent[],
  p: number,
  depth: number,
): WaveComponent[] {
  const n = Math.max(from.length, to.length);
  const out: WaveComponent[] = [];
  for (let i = 0; i < n; i++) {
    const a = i < from.length ? (from[i] as WaveComponent) : zeroAmpLike(to[i] as WaveComponent);
    const b = i < to.length ? (to[i] as WaveComponent) : zeroAmpLike(from[i] as WaveComponent);
    const amp = a.amp + (b.amp - a.amp) * p;
    const omega = a.omega + (b.omega - a.omega) * p;
    const phase = lerpAngle(a.phase, b.phase, p);
    const steepness = a.steepness + (b.steepness - a.steepness) * p;
    const ka = Math.hypot(a.kx, a.ky);
    const kb = Math.hypot(b.kx, b.ky);
    let ux = a.kx / (ka || 1) + ((b.kx / (kb || 1)) - a.kx / (ka || 1)) * p;
    let uy = a.ky / (ka || 1) + ((b.ky / (kb || 1)) - a.ky / (ka || 1)) * p;
    const ul = Math.hypot(ux, uy);
    if (ul < 1e-9) {
      ux = 0;
      uy = 1; // 退化兜底：默认沿 +y
    } else {
      ux /= ul;
      uy /= ul;
    }
    const k = solveWaveNumber(omega, depth); // 过渡中亦严格满足色散
    out.push({ amp, kx: k * ux, ky: k * uy, omega, phase, steepness });
  }
  return out;
}

/** cos² 方向分布（s=2）在 ±45° 带内的 CDF 反解（分层采样用，模块级缓存） */
const DIR_BAND = Math.PI / 4; // 半带宽
/** 带内 ∫cos²θ dθ 全质量 = [θ/2 + sin(2θ)/4] 从 −π/4 到 π/4 = π/4 + 1/2 */
const DIR_BAND_MASS = 2 * (DIR_BAND / 2 + Math.sin(2 * DIR_BAND) / 4);
let dirQuantileFn: ((u: number) => number) | null = null;
function directionQuantile(u: number): number {
  if (dirQuantileFn === null) {
    const cdf = (th: number): number =>
      (th / 2 + Math.sin(2 * th) / 4 + DIR_BAND_MASS / 2) / DIR_BAND_MASS;
    dirQuantileFn = (u: number): number => {
      const uu = clamp01(u);
      let lo = -DIR_BAND;
      let hi = DIR_BAND;
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        if (cdf(mid) < uu) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
  }
  return dirQuantileFn(u);
}

/** 由分量列表求零阶矩 m0 = Σ a²/2（分量离散 ⇒ 数值离散估计，SPEC §13 #8） */
function moment0FromComponents(comps: readonly WaveComponent[]): number {
  let m0 = 0;
  for (const c of comps) m0 += (c.amp * c.amp) / 2;
  return m0;
}

/** 骨架沿用：分量列表 → 海况摘要（主波 = 振幅最大分量；供实验二解析真值） */
function seaStateFromComponents(comps: readonly WaveComponent[]): SeaStateSummary {
  if (comps.length === 0) return { hs: 0, tp: 0, peakFrequency: 0, wavelength: 0 };
  const m0 = moment0FromComponents(comps);
  let dominant: WaveComponent = comps[0] as WaveComponent;
  for (const c of comps) if (c.amp > dominant.amp) dominant = c;
  const tp = dominant.omega > 0 ? (2 * Math.PI) / dominant.omega : 0;
  const k = Math.hypot(dominant.kx, dominant.ky);
  return {
    hs: 4 * Math.sqrt(m0),
    tp,
    peakFrequency: tp > 0 ? 1 / tp : 0,
    wavelength: k > 1e-9 ? (2 * Math.PI) / k : 0,
  };
}

const CALM_SEA_STATE: SeaStateSummary = { hs: 0, tp: 0, peakFrequency: 0, wavelength: 0 };

interface TransitionState {
  from: readonly WaveComponent[];
  startWallMs: number;
  /** 仿真时间锚点：首个带时间的调用建立；时钟回退（reset）时重锚 */
  simStart: number | null;
  simNow: number;
  /** 已达到的过渡进度（秒，单调不减）：仿真时间驱动，挂钟仅在无仿真锚点时兜底 */
  progressSeconds: number;
}

function createWaveFieldImpl(deps: WaveFieldDeps): WaveField {
  const depth = deps.depth ?? DEFAULT_WATER_DEPTH;
  const rngFactory = deps.rngFactory ?? mulberry32;
  /** 深水判定（浅水守卫：过小水深按深水处理，避免 cosh/sinh 除零） */
  const isFiniteDepth = Number.isFinite(depth) && depth > 1e-3;

  let currentExperiment: ExperimentId = 'wind';
  let configured = false;
  let everConfigured = false;
  /** 突变检测用的上次配置指纹（实验 id / 谱种子 / 谱型） */
  let lastExperiment: ExperimentId | null = null;
  let lastSpectrumSeed: number | null = null;
  let lastSpectrumKind: SpectrumExperimentParams['kind'] | null = null;
  let windParams = sanitizeWind(undefined);
  let interferenceParams = { makerA: sanitizeMaker(undefined), makerB: sanitizeMaker(undefined) };
  let spectrumParams = sanitizeSpectrum(undefined);

  // 目标态（理论真值，确定性）与显示态（平滑过渡中，供渲染/采样）
  let targetComps: readonly WaveComponent[] = [];
  let displayComps: readonly WaveComponent[] = [];
  let displayHasSteepness = false;
  let transition: TransitionState | null = null;
  let lastBlendP = -1;

  // configure 时算好的理论缓存（observedSeaState / whitecap 用）
  let windGrowthCache: WindGrowthResult = { hs: 0, tp: 0, limiting: 'calm' };
  let spectrumFpCache = 0;
  let spectrumAlphaCache = PM_ALPHA;
  let spectrumM0Cache = 0;

  // ---------- 过渡推进 ----------

  function advanceTransition(simT?: number): void {
    const tr = transition;
    if (tr === null) return;
    if (simT !== undefined && Number.isFinite(simT)) {
      if (tr.simStart === null || simT < tr.simNow - 0.5) {
        tr.simStart = simT; // 首次锚定 / 时钟回退（reset）重锚
        tr.simNow = simT;
      } else if (simT > tr.simNow) {
        tr.simNow = simT;
      }
    }
    // 进度只由仿真时间驱动（暂停 / 冻结波形时仿真时间不走 → 过渡同步冻结，
    // 与"暂停定格海面"的教学语义一致）；挂钟仅兜底"从未有仿真时间锚点"的
    // 无时钟调用路径（如纯逻辑测试反复 configure + components()），避免永久不收敛。
    const candidate =
      tr.simStart !== null
        ? tr.simNow - tr.simStart
        : (Date.now() - tr.startWallMs) / 1000;
    // 进度单调不回退
    tr.progressSeconds = Math.max(tr.progressSeconds, candidate);
    if (tr.progressSeconds >= TRANSITION_SNAP_SECONDS) {
      displayComps = targetComps;
      transition = null;
      lastBlendP = 1;
      displayHasSteepness = targetComps.some((c) => c.steepness > 0);
      return;
    }
    const p = 1 - Math.exp(-tr.progressSeconds / TRANSITION_TAU);
    if (Math.abs(p - lastBlendP) < 1e-4) return; // 变化太小不重算（避免每调用重建）
    lastBlendP = p;
    displayComps = blendComponents(tr.from, targetComps, p, depth);
    displayHasSteepness = displayComps.some((c) => c.steepness > 0);
  }

  // ---------- 各实验目标分量构建 ----------

  /**
   * 实验一：成长模型（growth.ts）给出 Hs/Tp ⇒ 24 分量窄谱离散。
   * 能量按高斯频率权重 + cos² 方向权重分配，归一化保证 Σa²/2 = (Hs/4)² 精确成立；
   * 相位来自固定种子 ⇒ 风速/风时连续拖动时相位不重排（SPEC §9.1）。
   */
  function buildWindComponents(p: WindParamsS): WaveComponent[] {
    const growth = windGrowth(p.windSpeed, p.windDuration, WIND_TEACHING_FETCH);
    if (growth.limiting === 'calm' || growth.hs <= 0 || growth.tp <= 0) return [];
    const fp = 1 / growth.tp;
    const n = WIND_COMPONENT_COUNT;
    const rng = rngFactory(WIND_PHASE_SEED);
    const dir = p.windDirectionRad;

    // 教学窄谱：0.6fp–3.0fp 线性布点，高斯权重集中于谱峰
    const freqs: number[] = [];
    const thetas: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < n; i++) {
      const fi = fp * (0.6 + (2.4 * i) / (n - 1));
      const theta = dir + (rng() - 0.5) * (Math.PI / 2); // ±45° 方向散布
      const spread = Math.cos(theta - dir) * Math.cos(theta - dir); // cos² 方向分布
      freqs.push(fi);
      thetas.push(theta);
      weights.push(Math.exp(-Math.pow((fi - fp) / (0.45 * fp), 2)) * spread);
    }
    let sumW2 = 0;
    for (const w of weights) sumW2 += w * w;
    // σ_η = Hs/4 = √(Σ a²/2) ⇒ a_i = (Hs/4)·√2·w_i/√(Σw²)，Hs=4√m0 精确
    const ampScale = ((growth.hs / 4) * Math.SQRT2) / Math.sqrt(sumW2);

    const comps: WaveComponent[] = [];
    for (let i = 0; i < n; i++) {
      const omega = 2 * Math.PI * (freqs[i] as number);
      const k = solveWaveNumber(omega, depth);
      const theta = thetas[i] as number;
      comps.push({
        amp: ampScale * (weights[i] as number),
        kx: k * Math.sin(theta),
        ky: k * Math.cos(theta),
        omega,
        phase: rng() * Math.PI * 2,
        steepness: 0, // 实验一为线性 Airy（SPEC §13 #1 学生可见声明）
      });
    }
    return comps;
  }

  /**
   * 实验二：两列规则波单频分量（方向角/初相位由参数直给）。
   * Gerstner 陡度 q = min(0.35, 0.3/(k·a))：
   *   ⇒ q·k·a ≤ 0.3 每分量、合计 ≤ 0.6 < 1（防卷绕自交），
   *   且小振幅/长周期时水平位移退化为 0.35·a（避免荒诞的大水平位移）。
   */
  function buildInterferenceComponents(p: {
    makerA: MakerS;
    makerB: MakerS;
  }): WaveComponent[] {
    const toComponent = (m: MakerS): WaveComponent => {
      const omega = (2 * Math.PI) / m.period;
      const k = solveWaveNumber(omega, depth); // 全水深色散（牛顿反解）
      const a = m.amplitude / 2; // 输入为波高 H，物理振幅 = H/2
      const q =
        a > 0 && k > 1e-9
          ? Math.min(GERSTNER_Q_MAX, GERSTNER_QKA_MAX / (k * a))
          : 0;
      return {
        amp: a,
        kx: k * Math.sin(m.angleRad),
        ky: k * Math.cos(m.angleRad),
        omega,
        phase: m.phaseRad,
        steepness: q,
      };
    };
    return [toComponent(p.makerA), toComponent(p.makerB)];
  }

  /**
   * 实验三：PM/JONSWAP 谱 48 分量离散（教学版，SPEC §13 #5 升级）。
   *  - 频率：0.5fp–4fp 均匀 48 箱、中点取样（积分偏差 ≪5%）；
   *  - 方向：cos²(s=2) 分布 ±45°，按 CDF 分位抽取方向（逆变换采样）。
   *    关键：方向密度已吸收 cos² 形状 ⇒ 每频箱携带该箱全部能量
   *    （a_i = √(2·S(f_i)·Δf)，单位权重），能量对方向采样零方差，
   *    保证 Σa²/2 ≈ ∫S df（Hs 恢复误差仅来自频带截断 ≈0.5%）；
   *    分位 u 网格经固定种子置换后与频率箱配对 ⇒ 频率-方向不相关；
   *  - 相位：rng(seed)·2π，同种子同海况（禁用真随机）；
   *  - JONSWAP：α = 0.076(gF/U²)^(−0.22)，fp = 3.5(g/U)(gF/U²)^(−1/3)（风区决定峰位）；
   *    PM：α = 0.0081，fp = 0.877·g/(2π·U)。
   */
  function buildSpectrumComponents(p: SpectrumParamsS): WaveComponent[] {
    const fp =
      p.kind === 'pm'
        ? pmPeakFrequency(p.windSpeed)
        : jonswapPeakFrequency(p.windSpeed, p.fetch);
    if (!(fp > 0)) return [];
    const alpha =
      p.kind === 'pm' ? PM_ALPHA : jonswapAlpha(p.windSpeed, p.fetch);
    const gamma = p.kind === 'pm' ? 1 : p.peakEnhancement;

    const n = SPECTRUM_COMPONENT_COUNT;
    const fLow = 0.5 * fp;
    const fHigh = 4 * fp;
    const df = (fHigh - fLow) / n;

    // 方向逆变换采样：u 网格经固定种子置换后取 cos²-CDF 分位 ⇒ 频向不相关
    const rng = rngFactory(p.randomSeed);
    const perm = shuffledIndices(
      Array.from({ length: n }, (_, i) => i),
      rng,
    );

    const comps: WaveComponent[] = [];
    for (let i = 0; i < n; i++) {
      const fi = fLow + (i + 0.5) * df; // 中点规则
      const S =
        p.kind === 'pm'
          ? pmSpectrum(fi, fp, alpha)
          : jonswapSpectrum(fi, fp, gamma, alpha);
      const theta = directionQuantile(((perm[i] as number) + 0.5) / n);
      const omega = 2 * Math.PI * fi;
      const k = solveWaveNumber(omega, depth);
      comps.push({
        amp: Math.sqrt(2 * S * df), // 方向密度已吸收 cos² 形状 ⇒ 单位能量权重
        kx: k * Math.sin(theta),
        ky: k * Math.cos(theta),
        omega,
        phase: rng() * Math.PI * 2,
        steepness: 0, // 不规则海况保持线性 Airy（教学声明见 MODELS.md）
      });
    }
    return comps;
  }

  // ---------- WaveField 实例 ----------

  const waveField: WaveField = {
    depth,

    configure(experiment, params) {
      currentExperiment = experiment;
      configured = true;
      // 突变检测（决定是否需要时间平滑）：实验切换、谱种子、谱型。
      // 其余参数（风速/风时/风向/波高/周期/方向/相位/U/F/γ）在构建公式下
      // 对目标分量连续（SPEC §9.1"公式连续 ⇒ 分量连续"），直接取目标态，
      // 滑块拖动即时且平滑，无过渡滞后。
      const structuralChange =
        lastExperiment !== null && lastExperiment !== experiment;
      const prevSpectrumSeed = lastSpectrumSeed;
      const prevSpectrumKind = lastSpectrumKind;

      windParams = sanitizeWind(params?.wind);
      interferenceParams = {
        makerA: sanitizeMaker(params?.interference?.makerA),
        makerB: sanitizeMaker(params?.interference?.makerB),
      };
      spectrumParams = sanitizeSpectrum(params?.spectrum);
      const spectrumDiscreteChange =
        spectrumParams.randomSeed !== prevSpectrumSeed ||
        spectrumParams.kind !== prevSpectrumKind;

      // 重建目标分量
      let next: readonly WaveComponent[];
      switch (experiment) {
        case 'wind':
          next = buildWindComponents(windParams);
          windGrowthCache = windGrowth(
            windParams.windSpeed,
            windParams.windDuration,
            WIND_TEACHING_FETCH,
          );
          break;
        case 'interference':
          next = buildInterferenceComponents(interferenceParams);
          break;
        case 'spectrum':
          next = buildSpectrumComponents(spectrumParams);
          spectrumFpCache =
            spectrumParams.kind === 'pm'
              ? pmPeakFrequency(spectrumParams.windSpeed)
              : jonswapPeakFrequency(spectrumParams.windSpeed, spectrumParams.fetch);
          spectrumAlphaCache =
            spectrumParams.kind === 'pm'
              ? PM_ALPHA
              : jonswapAlpha(spectrumParams.windSpeed, spectrumParams.fetch);
          break;
      }
      next = next.slice(0, MAX_WAVE_COMPONENTS);
      spectrumM0Cache = moment0FromComponents(next);
      lastExperiment = experiment;
      lastSpectrumSeed = spectrumParams.randomSeed;
      lastSpectrumKind = spectrumParams.kind;

      // 平滑过渡决策：
      //  - 新鲜实例首次 configure / 连续参数漂移（公式连续）⇒ 直接目标态（确定性）；
      //  - 真突变（实验切换、谱种子、谱型）⇒ τ≈1 s 指数过渡；
      //    突变落在平静态（prev 为空）时，过渡从零振幅淡入（blendComponents 补零）。
      const prev = displayComps;
      const structural =
        structuralChange || (experiment === 'spectrum' && spectrumDiscreteChange);
      if (
        (!everConfigured && prev.length === 0) ||
        !structural ||
        componentsEqual(prev, next)
      ) {
        everConfigured = true;
        targetComps = next;
        displayComps = next;
        displayHasSteepness = next.some((c) => c.steepness > 0);
        transition = null;
        lastBlendP = 1;
        return;
      }
      targetComps = next;
      transition = {
        from: prev,
        startWallMs: Date.now(),
        simStart: null,
        simNow: Number.NaN,
        progressSeconds: 0,
      };
      lastBlendP = -1; // display 保持 prev，等待下一次带时间的调用推进
      everConfigured = true;
    },

    components() {
      advanceTransition(); // 挂钟兜底推进（仅当尚无仿真时间锚点时生效；暂停时不推进）
      return displayComps;
    },

    evalSurface(x, y, t) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) {
        return { eta: 0, normal: { x: 0, y: 0, z: 1 } }; // NaN 守卫：静水面
      }
      advanceTransition(t);
      const comps = displayComps;
      if (comps.length === 0) return { eta: 0, normal: { x: 0, y: 0, z: 1 } };

      if (!displayHasSteepness) {
        // 线性 Airy 快路径（实验一/三，q ≡ 0）
        let eta = 0;
        let dEtaDx = 0;
        let dEtaDy = 0;
        for (const c of comps) {
          const theta = c.kx * x + c.ky * y - c.omega * t + c.phase;
          eta += c.amp * Math.sin(theta);
          const coeff = c.amp * Math.cos(theta);
          dEtaDx += coeff * c.kx;
          dEtaDy += coeff * c.ky;
        }
        const len = Math.hypot(dEtaDx, dEtaDy, 1);
        return {
          eta,
          normal: { x: -dEtaDx / len, y: -dEtaDy / len, z: 1 / len },
        };
      }

      // Gerstner 路径（实验二，q > 0）：先不动点反解源坐标 (x0,y0)，
      // Σ q·k·a < 1 保证映射收缩（迭代收敛）；再在源坐标处解析求切向叉积法线。
      const n = comps.length;
      const kk = new Float64Array(n);
      const ux = new Float64Array(n);
      const uy = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const c = comps[i] as WaveComponent;
        const k = Math.hypot(c.kx, c.ky);
        kk[i] = k;
        ux[i] = k > 1e-12 ? c.kx / k : 0;
        uy[i] = k > 1e-12 ? c.ky / k : 0;
      }
      let x0 = x;
      let y0 = y;
      for (let iter = 0; iter < 32; iter++) {
        let dx = 0;
        let dy = 0;
        for (let i = 0; i < n; i++) {
          const c = comps[i] as WaveComponent;
          if (c.steepness <= 0 || c.amp === 0) continue;
          const theta =
            (c.kx * x0 + c.ky * y0 - c.omega * t + c.phase);
          const d = c.steepness * c.amp;
          const cosT = Math.cos(theta);
          dx += d * cosT * (ux[i] as number);
          dy += d * cosT * (uy[i] as number);
        }
        const nx = x - dx;
        const ny = y - dy;
        const move = Math.abs(nx - x0) + Math.abs(ny - y0);
        x0 = nx;
        y0 = ny;
        if (move < 1e-10) break;
      }
      let eta = 0;
      let dxx = 0; // ∂Dx/∂x0
      let dxy = 0; // ∂Dy/∂x0
      let dyx = 0; // ∂Dx/∂y0
      let dyy = 0; // ∂Dy/∂y0
      let dzx = 0; // ∂η/∂x0
      let dzy = 0; // ∂η/∂y0
      for (let i = 0; i < n; i++) {
        const c = comps[i] as WaveComponent;
        const theta = c.kx * x0 + c.ky * y0 - c.omega * t + c.phase;
        eta += c.amp * Math.sin(theta);
        const k = kk[i] as number;
        if (c.steepness > 0 && c.amp !== 0 && k > 1e-12) {
          const sa = c.steepness * c.amp; // 水平位移幅度 = q·a
          const kx = c.kx;
          const ky = c.ky;
          const uxi = ux[i] as number;
          const uyi = uy[i] as number;
          const sn = Math.sin(theta);
          dxx -= sa * kx * uxi * sn;
          dyx -= sa * ky * uxi * sn;
          dxy -= sa * kx * uyi * sn;
          dyy -= sa * ky * uyi * sn;
        }
        dzx += c.amp * c.kx * Math.cos(theta);
        dzy += c.amp * c.ky * Math.cos(theta);
      }
      // N = Tx × Ty，Tx = (1+dxx, dyx, dzx)，Ty = (dxy, 1+dyy, dzy)
      const nx = dyx * dzy - dzx * (1 + dyy);
      const ny = dzx * dxy - (1 + dxx) * dzy;
      const nz = (1 + dxx) * (1 + dyy) - dyx * dxy;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 1e-12)) return { eta, normal: { x: 0, y: 0, z: 1 } };
      return { eta, normal: { x: nx / len, y: ny / len, z: nz / len } };
    },

    particleOrbit(x, y, z, t) {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z) ||
        !Number.isFinite(t)
      ) {
        return { x: 0, y: 0, z: 0 }; // NaN 守卫
      }
      advanceTransition(t);
      // 静水深基准钳制：z>0 视为水面，z<−h 视为水底（无效输入不外溢）
      const zBase = isFiniteDepth ? Math.min(Math.max(z, -depth), 0) : Math.min(z, 0);
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (const c of displayComps) {
        const k = Math.hypot(c.kx, c.ky);
        if (k < 1e-9 || c.amp === 0) continue;
        const theta = c.kx * x + c.ky * y - c.omega * t + c.phase;
        if (!isFiniteDepth) {
          // 深水：圆轨迹，振幅衰减 e^{kz}（zBase ≤ 0 ⇒ 不溢出）
          const decay = Math.exp(k * zBase);
          dx += c.amp * decay * Math.cos(theta) * (c.kx / k);
          dy += c.amp * decay * Math.cos(theta) * (c.ky / k);
          dz += c.amp * decay * Math.sin(theta);
        } else {
          // 有限深水：椭圆轨迹（水平 cosh / 垂直 sinh，浅水压扁）
          // 用 e^{u−v}·(1±e^{−2u})/(1−e^{−2v}) 稳定形式，kh 很大也不溢出
          const kh = k * depth;
          if (kh < 1e-6) {
            const decay = Math.exp(k * zBase); // 极浅退化守卫
            dx += c.amp * decay * Math.cos(theta) * (c.kx / k);
            dy += c.amp * decay * Math.cos(theta) * (c.ky / k);
            dz += c.amp * decay * Math.sin(theta);
            continue;
          }
          const u = k * (zBase + depth);
          const em2u = Math.exp(-2 * u);
          const denom = 1 - Math.exp(-2 * kh);
          const ampH = (c.amp * Math.exp(u - kh) * (1 + em2u)) / denom;
          const ampV = (c.amp * Math.exp(u - kh) * (1 - em2u)) / denom;
          dx += ampH * Math.cos(theta) * (c.kx / k);
          dy += ampH * Math.cos(theta) * (c.ky / k);
          dz += ampV * Math.sin(theta);
        }
      }
      return { x: x + dx, y: y + dy, z: zBase + dz };
    },

    spectrum(f) {
      // 实验一/二为非谱海况，恒 0（图表层据此隐藏谱图，SPEC §10）
      if (!configured || currentExperiment !== 'spectrum') return 0;
      if (!Number.isFinite(f) || f <= 0) return 0;
      return spectrumParams.kind === 'pm'
        ? pmSpectrum(f, spectrumFpCache, spectrumAlphaCache)
        : jonswapSpectrum(
            f,
            spectrumFpCache,
            spectrumParams.peakEnhancement,
            spectrumAlphaCache,
          );
    },

    whitecapIntensity() {
      // 【教学近似】白帽/破碎强度 0–1，标定依据见 MODELS.md 与常量注释
      if (!configured) return 0;
      switch (currentExperiment) {
        case 'wind': {
          if (windGrowthCache.limiting === 'calm' || windGrowthCache.hs <= 0) return 0;
          const kp = solveWaveNumber((2 * Math.PI) / windGrowthCache.tp, depth);
          const ak = (kp * windGrowthCache.hs) / 2; // "局部陡度"：谱峰 k × 半波高
          const steepTerm = (ak - WC_AK_ONSET) / (WC_AK_FULL - WC_AK_ONSET);
          const windTerm =
            (windParams.windSpeed - WC_U_ONSET) / (WC_U_FULL - WC_U_ONSET);
          return clamp01(WC_STEEP_WEIGHT * steepTerm + WC_WIND_WEIGHT * windTerm);
        }
        case 'interference': {
          // 按目标分量最大局部陡度 s = q·k·a 映射（s≈0.157 对应单波 H/L≈1/7 破碎临界）
          let sMax = 0;
          for (const c of targetComps) {
            const k = Math.hypot(c.kx, c.ky);
            sMax = Math.max(sMax, c.steepness * k * c.amp);
          }
          return clamp01((sMax - WC_INTERF_ONSET) / (WC_INTERF_FULL - WC_INTERF_ONSET));
        }
        case 'spectrum': {
          if (spectrumM0Cache <= 0) return 0;
          const hs = 4 * Math.sqrt(spectrumM0Cache);
          const tp = spectrumFpCache > 0 ? 1 / spectrumFpCache : 0;
          if (!(tp > 0)) return 0;
          const kp = solveWaveNumber((2 * Math.PI) / tp, depth);
          const ak = (kp * hs) / 2;
          const steepTerm = (ak - WC_AK_ONSET) / (WC_AK_FULL - WC_AK_ONSET);
          const windTerm =
            (spectrumParams.windSpeed - WC_U_ONSET) / (WC_U_FULL - WC_U_ONSET);
          return clamp01(WC_STEEP_WEIGHT * steepTerm + WC_WIND_WEIGHT * windTerm);
        }
      }
    },

    observedSeaState() {
      // 理论真值恒读目标态（不受平滑过渡影响，确定性）
      if (!configured) return CALM_SEA_STATE;
      switch (currentExperiment) {
        case 'wind': {
          const g = windGrowthCache;
          if (g.limiting === 'calm' || !(g.tp > 0)) return CALM_SEA_STATE;
          return {
            hs: g.hs,
            tp: g.tp,
            peakFrequency: 1 / g.tp,
            wavelength: wavelengthFromOmega((2 * Math.PI) / g.tp, depth),
          };
        }
        case 'interference':
          return seaStateFromComponents(targetComps);
        case 'spectrum': {
          // 不规则波：Hs = 4√m0（分量离散），Tp = 1/fp（解析谱峰，需求指定）
          if (!(spectrumFpCache > 0) || spectrumM0Cache <= 0) return CALM_SEA_STATE;
          return {
            hs: 4 * Math.sqrt(spectrumM0Cache),
            tp: 1 / spectrumFpCache,
            peakFrequency: spectrumFpCache,
            wavelength: wavelengthFromOmega(2 * Math.PI * spectrumFpCache, depth),
          };
        }
      }
    },
  };

  return waveField;
}

export function createWaveField(deps: WaveFieldDeps = {}): WaveField {
  return createWaveFieldImpl(deps);
}
