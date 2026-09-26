/**
 * physics 模块测试 —— 覆盖需求强制项：
 *   ① 色散关系（全水深 + 深水/浅水极限 + 守卫）
 *   ② 谱积分恢复 Hs（相对误差 < 5%）
 *   ③ 拍周期 = T1·T2/|T1−T2|
 *   ④ 成长模型对风速单调（+ 风时单调、充分发展封顶）
 *   ⑤ 边界与 NaN 守卫
 *   ⑥ 深水圆轨迹闭合性（+ 有限水深椭圆、大水深稳定性）
 *   ⑦ 平滑过渡（τ≈1 s，仿真时间驱动）、可复现性、Gerstner 防卷绕、教学对照数据
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM_STATE, G, MAX_WAVE_COMPONENTS } from '../src/core/constants';
import type { SimParams, WaveComponent } from '../src/core/types';
import { createWaveField } from '../src/physics/waveField';
import {
  solveWaveNumber,
  wavelengthFromOmega,
} from '../src/physics/dispersion';
import {
  jonswapAlpha,
  jonswapPeakFrequency,
  jonswapSpectrum,
  numericSpectralMoment,
  pmPeakFrequency,
  pmSpectrum,
  PM_ALPHA,
} from '../src/physics/spectra';
import {
  durationLimitedSea,
  fetchLimitedSea,
  fullyDevelopedSea,
  windGrowth,
} from '../src/physics/growth';
import { orbitDiameter, wavePhaseSpeed, waveTeachingInfo } from '../src/physics/teaching';

// ---------- 测试工具 ----------

function baseParams(): SimParams {
  return JSON.parse(JSON.stringify(DEFAULT_SIM_STATE.params)) as SimParams;
}

function windParams(windSpeed: number, windDuration: number, windDirection = 0): SimParams {
  const p = baseParams();
  p.wind = { windSpeed, windDuration, windDirection };
  return p;
}

type Maker = { amplitude: number; period: number; angle: number; phase: number };

function interferenceParams(a: Maker, b: Maker): SimParams {
  const p = baseParams();
  p.interference = { makerA: a, makerB: b };
  return p;
}

function spectrumParams(
  overrides: Partial<SimParams['spectrum']> = {},
): SimParams {
  const p = baseParams();
  p.spectrum = { ...p.spectrum, ...overrides };
  return p;
}

function maxAbsEtaDiff(
  fieldA: ReturnType<typeof createWaveField>,
  fieldB: ReturnType<typeof createWaveField>,
  t: number,
): number {
  const probes: Array<[number, number]> = [
    [3, 4],
    [1, 1],
    [2, 7],
    [5, 0.5],
    [0, 0],
  ];
  let d = 0;
  for (const [x, y] of probes) {
    d = Math.max(d, Math.abs(fieldA.evalSurface(x, y, t).eta - fieldB.evalSurface(x, y, t).eta));
  }
  return d;
}

// ============================================================
// ① 色散关系
// ============================================================

describe('dispersion：色散关系 ω² = g·k·tanh(kh)', () => {
  it('深水极限：k = ω²/g（相对误差 < 1e-9）', () => {
    for (const omega of [0.5, 1, 1.5707963, 2, 4]) {
      const k = solveWaveNumber(omega, Number.POSITIVE_INFINITY);
      expect(Math.abs(k - (omega * omega) / G) / k).toBeLessThan(1e-9);
    }
  });

  it('有限水深：解满足 g·k·tanh(kh) = ω²（残差 < 1e-9 相对），k 随 ω 单调', () => {
    for (const depth of [2, 10, 50]) {
      let prev = 0;
      for (let omega = 0.3; omega <= 3.0001; omega += 0.3) {
        const k = solveWaveNumber(omega, depth);
        const residual = Math.abs(G * k * Math.tanh(k * depth) - omega * omega);
        expect(residual / (omega * omega)).toBeLessThan(1e-9);
        expect(k).toBeGreaterThan(prev);
        prev = k;
      }
    }
  });

  it('浅水极限：kh≪1 时 k ≈ ω/√(gh)（偏差 < 3%），且真解大于两个解析极限', () => {
    // tanh(kh) < kh 且 tanh < 1 ⇒ 精确根同时大于浅水/深水近似值
    const depth = 5;
    const omega = (2 * Math.PI) / 20; // T=20 s 长波（kh ≈ 0.23）
    const k = solveWaveNumber(omega, depth);
    const kShallow = omega / Math.sqrt(G * depth);
    const kDeep = (omega * omega) / G;
    expect(k).toBeGreaterThan(kShallow);
    expect(k).toBeGreaterThan(kDeep);
    expect(Math.abs(k / kShallow - 1)).toBeLessThan(0.03);
    // 该工况对应波长 λ ≈ 139 m，与标准波浪预测表一致
    expect(Math.abs((2 * Math.PI) / k - 139)).toBeLessThan(2);
  });

  it('守卫：ω≤0/NaN 返回 0；水深非法（NaN/0/负）按深水处理', () => {
    expect(solveWaveNumber(0, 10)).toBe(0);
    expect(solveWaveNumber(-1, 10)).toBe(0);
    expect(solveWaveNumber(Number.NaN, 10)).toBe(0);
    for (const depth of [Number.NaN, 0, -5]) {
      const k = solveWaveNumber(1, depth);
      expect(Math.abs(k - 1 / G)).toBeLessThan(1e-12);
    }
  });

  it('分量携带的波数满足色散（深水与有限水深 depth=8）', () => {
    const deep = createWaveField();
    deep.configure(
      'interference',
      interferenceParams(
        { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
        { amplitude: 0.5, period: 6, angle: 30, phase: 90 },
      ),
    );
    for (const c of deep.components()) {
      const k = Math.hypot(c.kx, c.ky);
      expect(Math.abs(k - (c.omega * c.omega) / G) / k).toBeLessThan(1e-9);
    }

    const shallow = createWaveField({ depth: 8 });
    shallow.configure(
      'interference',
      interferenceParams(
        { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
        { amplitude: 0.5, period: 6, angle: 30, phase: 90 },
      ),
    );
    for (const c of shallow.components()) {
      const k = Math.hypot(c.kx, c.ky);
      const residual = Math.abs(G * k * Math.tanh(k * 8) - c.omega * c.omega);
      expect(residual / (c.omega * c.omega)).toBeLessThan(1e-9);
    }
  });
});

// ============================================================
// 谱模型单元（PM / JONSWAP）
// ============================================================

describe('spectra：PM/JONSWAP 谱', () => {
  it('PM 解析矩：数值积分 m0 = αg²(2π)⁻⁴fp⁻⁴/5（<1e-4），Hs ≈ 0.21U²/g（<1%）', () => {
    const U = 10;
    const fp = pmPeakFrequency(U);
    const m0Num = numericSpectralMoment((f) => pmSpectrum(f, fp), 0.005, 3, 4000);
    const m0Ana = (PM_ALPHA * G * G * Math.pow(fp, -4)) / (5 * Math.pow(2 * Math.PI, 4));
    expect(Math.abs(m0Num - m0Ana) / m0Ana).toBeLessThan(1e-4);

    const hs = 4 * Math.sqrt(m0Num);
    const hsClassic = (0.21 * U * U) / G;
    expect(Math.abs(hs - hsClassic) / hsClassic).toBeLessThan(0.01);
  });

  it('JONSWAP：f=fp 处 S_JON/S_PM = γ（峰增强），σ=0.07/0.09 在峰处连续', () => {
    const fp = 0.15;
    const gamma = 3.3;
    const ratio = jonswapSpectrum(fp, fp, gamma, PM_ALPHA) / pmSpectrum(fp, fp, PM_ALPHA);
    expect(ratio).toBeCloseTo(gamma, 9);

    const s = (f: number): number => jonswapSpectrum(f, fp, gamma, PM_ALPHA);
    const eps = 1e-4;
    const jump = Math.abs(s(fp - eps) - s(fp + eps)) / s(fp);
    expect(jump).toBeLessThan(1e-3);
  });

  it('JONSWAP α 与 fp 公式（风区进入谱参数）', () => {
    const U = 10;
    const F = 5e4;
    const xi = (G * F) / (U * U);
    expect(jonswapAlpha(U, F)).toBeCloseTo(0.076 * Math.pow(xi, -0.22), 12);
    expect(jonswapPeakFrequency(U, F)).toBeCloseTo(3.5 * (G / U) * Math.pow(xi, -1 / 3), 12);
    // 风区越短谱峰频率越高（年轻海况）
    expect(jonswapPeakFrequency(U, 1e4)).toBeGreaterThan(jonswapPeakFrequency(U, 3e5));
  });

  it('numericSpectralMoment：Simpson 积分 sanity（∫₀¹f²df = 1/3）', () => {
    const m = numericSpectralMoment((f) => f * f, 0, 1, 1000);
    expect(Math.abs(m - 1 / 3)).toBeLessThan(1e-10);
  });
});

// ============================================================
// ② 实验三：谱海况（分量离散 vs 谱积分）
// ============================================================

describe('实验三：PM/JONSWAP 谱海况', () => {
  it('分量数 ≤ 64；同种子完全可复现，异种子相位不同，mystery 不影响物理', () => {
    const fa = createWaveField();
    fa.configure('spectrum', spectrumParams({ randomSeed: 42 }));
    const fb = createWaveField();
    fb.configure('spectrum', spectrumParams({ randomSeed: 42 }));
    const fc = createWaveField();
    fc.configure('spectrum', spectrumParams({ randomSeed: 7 }));
    const fm = createWaveField();
    fm.configure('spectrum', spectrumParams({ randomSeed: 42, mystery: true }));

    expect(fa.components().length).toBeLessThanOrEqual(MAX_WAVE_COMPONENTS);
    expect(fa.components()).toEqual(fb.components());
    expect(fa.components()).toEqual(fm.components());
    expect(fa.components()).not.toEqual(fc.components());

    // 重复 configure 相同参数：无过渡、输出恒等（确定性）
    fa.configure('spectrum', spectrumParams({ randomSeed: 42 }));
    expect(fa.components()).toEqual(fb.components());
  });

  it('谱积分恢复 Hs：4√(Σa²/2) ≈ 4√(∫S df)，相对误差 < 5%（PM 与 JONSWAP）', () => {
    for (const kind of ['pm', 'jonswap'] as const) {
      const field = createWaveField();
      field.configure('spectrum', spectrumParams({ kind, windSpeed: 10, fetch: 5e4 }));
      const hsComponents = field.observedSeaState().hs;
      const m0Int = numericSpectralMoment((f) => field.spectrum(f), 0.005, 3, 4000);
      const hsIntegral = 4 * Math.sqrt(m0Int);
      expect(hsIntegral).toBeGreaterThan(0);
      expect(Math.abs(hsComponents - hsIntegral) / hsIntegral).toBeLessThan(0.05);
    }
  });

  it('Tp = 1/fp（解析谱峰）；波长满足深水色散', () => {
    const field = createWaveField();
    field.configure('spectrum', spectrumParams({ kind: 'jonswap', windSpeed: 10, fetch: 5e4 }));
    const fp = jonswapPeakFrequency(10, 5e4);
    const sea = field.observedSeaState();
    expect(sea.peakFrequency).toBeCloseTo(fp, 12);
    expect(sea.tp).toBeCloseTo(1 / fp, 12);
    const lambdaExpected = wavelengthFromOmega(2 * Math.PI * fp, Number.POSITIVE_INFINITY);
    expect(sea.wavelength).toBeCloseTo(lambdaExpected, 9);

    const pm = createWaveField();
    pm.configure('spectrum', spectrumParams({ kind: 'pm', windSpeed: 10 }));
    expect(pm.observedSeaState().peakFrequency).toBeCloseTo(pmPeakFrequency(10), 12);
  });

  it('Hs 对风速单调递增（PM 与 JONSWAP）', () => {
    for (const kind of ['pm', 'jonswap'] as const) {
      let prev = 0;
      for (const U of [6, 10, 15, 20, 30]) {
        const field = createWaveField();
        field.configure('spectrum', spectrumParams({ kind, windSpeed: U, fetch: 5e4 }));
        const hs = field.observedSeaState().hs;
        expect(hs).toBeGreaterThan(prev);
        prev = hs;
      }
    }
  });

  it('谱峰位置：S(f) 网格 argmax ≈ fp', () => {
    const field = createWaveField();
    field.configure('spectrum', spectrumParams({ kind: 'jonswap', windSpeed: 10, fetch: 5e4 }));
    const fp = jonswapPeakFrequency(10, 5e4);
    let fBest = 0;
    let sBest = -1;
    for (let f = 0.02; f <= 1; f += 1e-3) {
      const s = field.spectrum(f);
      if (s > sBest) {
        sBest = s;
        fBest = f;
      }
    }
    expect(Math.abs(fBest - fp)).toBeLessThan(2e-3);
  });

  it('spectrum 守卫：实验一/二恒为 0；f 非法返回 0', () => {
    const wind = createWaveField();
    wind.configure('wind', windParams(10, 30));
    expect(wind.spectrum(0.2)).toBe(0);
    const interf = createWaveField();
    interf.configure(
      'interference',
      interferenceParams(
        { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
        { amplitude: 0.5, period: 4, angle: 0, phase: 180 },
      ),
    );
    expect(interf.spectrum(0.2)).toBe(0);

    const spec = createWaveField();
    spec.configure('spectrum', spectrumParams({ windSpeed: 10 }));
    expect(spec.spectrum(Number.NaN)).toBe(0);
    expect(spec.spectrum(-1)).toBe(0);
    expect(spec.spectrum(0)).toBe(0);
    expect(spec.spectrum(0.2)).toBeGreaterThan(0);
  });
});

// ============================================================
// ④ 实验一：风浪成长（风速/风时单调、封顶、白帽）
// ============================================================

describe('实验一：风浪成长教学模型', () => {
  it('平静条件：U<0.3 或风时=0 ⇒ 无分量、海况为零、白帽为 0', () => {
    for (const [U, t] of [
      [0, 30],
      [0.2, 30],
      [10, 0],
    ] as const) {
      const field = createWaveField();
      field.configure('wind', windParams(U, t));
      expect(field.components().length).toBe(0);
      expect(field.evalSurface(1, 1, 1).eta).toBe(0);
      expect(field.observedSeaState().hs).toBe(0);
      expect(field.whitecapIntensity()).toBe(0);
      expect(windGrowth(U, t, 1e5).limiting).toBe('calm');
    }
  });

  it('成长模型对风速与风时单调（Hs、Tp 均非降）', () => {
    let prevHs = -1;
    let prevTp = -1;
    for (let U = 1; U <= 30; U += 1) {
      const g = windGrowth(U, 60, 1e5);
      expect(g.hs).toBeGreaterThanOrEqual(prevHs);
      expect(g.tp).toBeGreaterThanOrEqual(prevTp);
      prevHs = g.hs;
      prevTp = g.tp;
    }
    prevHs = -1;
    prevTp = -1;
    for (let tMin = 1; tMin <= 60; tMin += 1) {
      const g = windGrowth(12, tMin, 1e5);
      expect(g.hs).toBeGreaterThanOrEqual(prevHs);
      expect(g.tp).toBeGreaterThanOrEqual(prevTp);
      prevHs = g.hs;
      prevTp = g.tp;
    }
    // 风区分支：F 单调
    let prevF = -1;
    for (const F of [1e4, 5e4, 1e5, 3e5]) {
      const hs = fetchLimitedSea(10, F).hs;
      expect(hs).toBeGreaterThan(prevF);
      prevF = hs;
    }
  });

  it('取风时/风区限制较小者，并以充分发展（PM）封顶', () => {
    const U = 10;
    const tSec = 3600;
    const dur = durationLimitedSea(U, tSec);
    const fet = fetchLimitedSea(U, 1e5);
    const fd = fullyDevelopedSea(U);
    const g = windGrowth(U, 60, 1e5);
    const expected = Math.min(dur.hs, fet.hs, fd.hs);
    expect(Math.abs(g.hs - expected)).toBeLessThan(1e-9);
    expect(['duration', 'fetch', 'fully-developed']).toContain(g.limiting);
    // 极长风时的分支值远超充分发展 ⇒ 封顶生效（模型内部仍受 60 min 输入钳制，
    // 此处直接用分支函数验证封顶上界逻辑）
    expect(durationLimitedSea(30, 1e7).hs).toBeGreaterThan(fullyDevelopedSea(30).hs);
    expect(fullyDevelopedSea(30).hs).toBeCloseTo((0.21 * 900) / G, 9);
  });

  it('field 集成：observedSeaState 与成长模型一致；Hs 硬上限 ≤ 10 m', () => {
    const field = createWaveField();
    field.configure('wind', windParams(10, 60));
    const g = windGrowth(10, 60, 1e5); // 实验一教学风区 100 km（MODELS.md §2）
    const sea = field.observedSeaState();
    expect(Math.abs(sea.hs - g.hs)).toBeLessThan(1e-12);
    expect(Math.abs(sea.tp - g.tp)).toBeLessThan(1e-12);
    expect(sea.wavelength).toBeCloseTo((G * g.tp * g.tp) / (2 * Math.PI), 9);
    expect(field.components().length).toBeLessThanOrEqual(MAX_WAVE_COMPONENTS);

    // 越界输入钳制：风速 1e9 → 30 m/s，理论 Hs 不超红线
    const extreme = createWaveField();
    extreme.configure('wind', windParams(1e9, 1e9));
    expect(extreme.observedSeaState().hs).toBeLessThanOrEqual(10);
  });

  it('白帽强度：对风速单调、任务一阈值可达（U=15,t=60 ≥ 0.3）、恒在 [0,1]', () => {
    const values: number[] = [];
    for (const U of [5, 8, 10, 12, 15, 20, 24, 30]) {
      const field = createWaveField();
      field.configure('wind', windParams(U, 60));
      const w = field.whitecapIntensity();
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      values.push(w);
    }
    expect(values[0]).toBe(0); // 5 m/s 无白帽
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1] as number);
    }
    const task1 = createWaveField();
    task1.configure('wind', windParams(15, 60));
    expect(task1.whitecapIntensity()).toBeGreaterThanOrEqual(0.3);
  });

  it('方向约定：风向 0° ⇒ 分量均沿 +y 传播（ky>0）', () => {
    const field = createWaveField();
    field.configure('wind', windParams(10, 60, 0));
    expect(field.components().length).toBeGreaterThan(0);
    for (const c of field.components()) {
      expect(c.ky).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// ③ 实验二：拍周期 T1·T2/|T1−T2|
// ============================================================

describe('实验二：双造波机叠加', () => {
  it('拍：Δω 由分量给出，拍周期 = T1·T2/|T1−T2|；包络零点与峰值吻合', () => {
    const T1 = 4;
    const T2 = 4.5;
    const a = 0.25; // H=0.5 ⇒ 振幅 a = H/2
    const field = createWaveField();
    field.configure(
      'interference',
      interferenceParams(
        { amplitude: 0.5, period: T1, angle: 0, phase: 0 },
        { amplitude: 0.5, period: T2, angle: 0, phase: 0 },
      ),
    );
    const comps = field.components();
    expect(comps.length).toBe(2);
    const beatFromOmega = (2 * Math.PI) / Math.abs((comps[0] as WaveComponent).omega - (comps[1] as WaveComponent).omega);
    const beatClassic = (T1 * T2) / Math.abs(T1 - T2); // = 36 s
    expect(beatClassic).toBeCloseTo(36, 9);
    expect(beatFromOmega).toBeCloseTo(beatClassic, 6);

    // 包络零点：t = Tb/2 处两波反相相消（18 s 恰为 T1 的 4.5 倍、T2 的 4 倍）
    expect(Math.abs(field.evalSurface(0, 0, beatClassic / 2).eta)).toBeLessThan(1e-8);
    // 包络峰值窗口内最大振幅 ≥ 1.9·a（相长）且 ≤ 2a+ε
    let maxEta = 0;
    for (let t = 0; t <= beatClassic; t += 0.005) {
      maxEta = Math.max(maxEta, Math.abs(field.evalSurface(0, 0, t).eta));
    }
    expect(maxEta).toBeGreaterThanOrEqual(1.9 * a);
    expect(maxEta).toBeLessThanOrEqual(2 * a + 1e-6);
  });

  it('Gerstner 陡度：q>0、Σ q·k·a < 1（含极端参数），波面恒为可画图像（法线 z>0）', () => {
    const field = createWaveField();
    field.configure(
      'interference',
      interferenceParams(
        { amplitude: 0.5, period: 4, angle: 0, phase: 0 },
        { amplitude: 0.5, period: 4, angle: 0, phase: 180 },
      ),
    );
    let sumQka = 0;
    for (const c of field.components()) {
      expect(c.steepness).toBeGreaterThan(0);
      sumQka += c.steepness * Math.hypot(c.kx, c.ky) * c.amp;
    }
    expect(sumQka).toBeLessThan(1);

    // 极端陡峭组合（H=2 m、T=0.5 s，k·a ≈ 16）仍防卷绕
    const extreme = createWaveField();
    extreme.configure(
      'interference',
      interferenceParams(
        { amplitude: 2, period: 0.5, angle: 0, phase: 0 },
        { amplitude: 2, period: 0.5, angle: 10, phase: 30 },
      ),
    );
    let sumExtreme = 0;
    for (const c of extreme.components()) {
      sumExtreme += c.steepness * Math.hypot(c.kx, c.ky) * c.amp;
    }
    expect(sumExtreme).toBeLessThan(0.61);
    for (let x = -2; x <= 2; x += 0.5) {
      for (let y = -2; y <= 2; y += 0.5) {
        const s = extreme.evalSurface(x, y, 1.23);
        expect(Number.isFinite(s.eta)).toBe(true);
        const { normal } = s;
        const len = Math.hypot(normal.x, normal.y, normal.z);
        expect(len).toBeCloseTo(1, 9);
        expect(normal.z).toBeGreaterThan(0); // 单值波面，无卷绕翻卷
      }
    }
  });

  it('方向角约定：angle=90° ⇒ 沿 +x 传播（kx=k, ky≈0）', () => {
    const field = createWaveField();
    field.configure(
      'interference',
      interferenceParams(
        { amplitude: 1, period: 5, angle: 90, phase: 0 },
        { amplitude: 0, period: 5, angle: 0, phase: 0 },
      ),
    );
    const c = field.components()[0] as WaveComponent;
    const k = Math.hypot(c.kx, c.ky);
    expect(c.kx / k).toBeCloseTo(1, 12);
    expect(Math.abs(c.ky) / k).toBeLessThan(1e-9);
  });
});

// ============================================================
// ⑥ 质点轨迹：深水圆闭合、有限水深椭圆
// ============================================================

describe('particleOrbit：水质点轨迹', () => {
  it('深水圆轨迹闭合性：半径恒等于 a，一个周期后回到起点', () => {
    const a = 0.5; // H=1
    const T = 5;
    const field = createWaveField();
    field.configure(
      'interference',
      interferenceParams(
        { amplitude: 1, period: T, angle: 0, phase: 0 },
        { amplitude: 0, period: T, angle: 0, phase: 0 },
      ),
    );
    const radii: number[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * T;
      const p = field.particleOrbit(0, 0, 0, t);
      radii.push(Math.hypot(p.x, p.y, p.z));
    }
    const rMin = Math.min(...radii);
    const rMax = Math.max(...radii);
    expect(Math.abs(rMin - a)).toBeLessThan(1e-9);
    expect(Math.abs(rMax - a)).toBeLessThan(1e-9);

    const start = field.particleOrbit(0, 0, 0, 0);
    const end = field.particleOrbit(0, 0, 0, T);
    expect(Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z)).toBeLessThan(1e-9);

    // 随深度指数衰减 e^{kz}：z = −λ/2 ⇒ 半径 = a·e^{−π}
    const k = (2 * Math.PI) / ((G * T * T) / (2 * Math.PI));
    const zHalf = -Math.PI / k;
    const deep = field.particleOrbit(0, 0, zHalf, 0.7);
    const deepRadius = Math.hypot(deep.x, deep.y, deep.z - zHalf);
    expect(deepRadius / a).toBeCloseTo(Math.exp(-Math.PI), 9);
  });

  it('有限水深椭圆：垂直/水平半径比 = tanh(k(z+h))；表面即椭圆（<1）；大水深稳定', () => {
    const depth = 20;
    const T = 8;
    const field = createWaveField({ depth });
    field.configure(
      'interference',
      interferenceParams(
        { amplitude: 0.5, period: T, angle: 0, phase: 0 },
        { amplitude: 0, period: T, angle: 0, phase: 0 },
      ),
    );
    const omega = (2 * Math.PI) / T;
    const k = solveWaveNumber(omega, depth);
    const ratioAt = (z: number): { h: number; v: number } => {
      let ampH = 0;
      let ampV = 0;
      for (let i = 0; i < 400; i++) {
        const t = (i / 400) * T;
        const p = field.particleOrbit(0, 0, z, t);
        ampH = Math.max(ampH, Math.abs(p.y)); // 0° 方向：水平运动在 y
        ampV = Math.max(ampV, Math.abs(p.z - z));
      }
      return { h: ampH, v: ampV };
    };

    const mid = ratioAt(-depth / 2);
    expect(mid.v).toBeLessThan(mid.h); // 椭圆压扁
    expect(Math.abs(mid.v / mid.h - Math.tanh(k * (depth / 2)))).toBeLessThan(1e-9);

    const surface = ratioAt(0);
    expect(surface.v / surface.h).toBeLessThan(1); // 有限水深表面也是椭圆
    expect(Math.abs(surface.v / surface.h - Math.tanh(k * depth))).toBeLessThan(1e-9);

    // 大水深（kh ≈ 35）稳定形式不溢出：半水深处轨迹已接近圆
    const deep = createWaveField({ depth: 500 });
    deep.configure(
      'interference',
      interferenceParams(
        { amplitude: 0.5, period: T, angle: 0, phase: 0 },
        { amplitude: 0, period: T, angle: 0, phase: 0 },
      ),
    );
    const kd = solveWaveNumber(omega, 500);
    let ampH = 0;
    let ampV = 0;
    for (let i = 0; i < 400; i++) {
      const t = (i / 400) * T;
      const p = deep.particleOrbit(0, 0, -250, t);
      ampH = Math.max(ampH, Math.abs(p.y));
      ampV = Math.max(ampV, Math.abs(p.z - -250));
    }
    expect(Number.isFinite(ampH)).toBe(true);
    expect(Number.isFinite(ampV)).toBe(true);
    expect(ampV / ampH).toBeGreaterThan(0.9999);
    expect(Math.abs(ampV / ampH - Math.tanh(kd * 250))).toBeLessThan(1e-6);
  });
});

// ============================================================
// ⑤ 边界与 NaN 守卫
// ============================================================

describe('边界与 NaN 守卫', () => {
  it('参数含 NaN/±∞：分量与采样输出全部有限', () => {
    const field = createWaveField();
    field.configure('wind', windParams(Number.NaN, Number.NaN, Number.NaN));
    expect(field.components().length).toBe(0);
    const s1 = field.evalSurface(1, 2, 3);
    expect(Number.isFinite(s1.eta)).toBe(true);
    expect(Math.hypot(s1.normal.x, s1.normal.y, s1.normal.z)).toBeCloseTo(1, 12);

    field.configure(
      'interference',
      interferenceParams(
        { amplitude: Number.NaN, period: Number.NaN, angle: Number.NaN, phase: Number.NaN },
        { amplitude: Number.POSITIVE_INFINITY, period: 4, angle: 0, phase: 0 },
      ),
    );
    for (const c of field.components()) {
      expect(Number.isFinite(c.amp)).toBe(true);
      expect(Number.isFinite(c.omega)).toBe(true);
    }
    const s2 = field.evalSurface(0.5, 0.5, 1);
    expect(Number.isFinite(s2.eta)).toBe(true);

    field.configure('spectrum', spectrumParams({ windSpeed: Number.NaN, fetch: Number.NaN }));
    const sea = field.observedSeaState();
    expect(Number.isFinite(sea.hs)).toBe(true);
    expect(Number.isFinite(sea.tp)).toBe(true);
    expect(Number.isFinite(field.whitecapIntensity())).toBe(true);
    expect(field.whitecapIntensity()).toBeGreaterThanOrEqual(0);
    expect(field.whitecapIntensity()).toBeLessThanOrEqual(1);
  });

  it('evalSurface / particleOrbit 输入 NaN 返回安全值；z>0 钳到水面', () => {
    const field = createWaveField();
    field.configure(
      'interference',
      interferenceParams(
        { amplitude: 1, period: 5, angle: 0, phase: 0 },
        { amplitude: 0, period: 5, angle: 0, phase: 0 },
      ),
    );
    for (const [x, y, t] of [
      [Number.NaN, 0, 0],
      [0, Number.NaN, 0],
      [0, 0, Number.NaN],
    ] as const) {
      const s = field.evalSurface(x, y, t);
      expect(s.eta).toBe(0);
      expect(Math.hypot(s.normal.x, s.normal.y, s.normal.z)).toBeCloseTo(1, 12);
    }
    const bad = field.particleOrbit(Number.NaN, 0, 0, 0);
    expect(Number.isFinite(bad.x + bad.y + bad.z)).toBe(true);
    const above = field.particleOrbit(0, 0, 7, 1.3); // z>0 钳到 0
    expect(above.z).toBeLessThanOrEqual(0.5 + 1e-9); // 位移幅度 ≤ a
    expect(above.z).toBeGreaterThanOrEqual(-0.5 - 1e-9);
  });
});

// ============================================================
// 平滑过渡（真突变：谱种子切换 / 实验切换；τ≈1 s，仿真时间驱动）
// ============================================================

/** 两组分量的总相位弧长（最短弧，逐序号求和）：衡量"旧海况 → 新海况"的状态距离 */
function totalPhaseMotion(
  a: readonly WaveComponent[],
  b: readonly WaveComponent[],
): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a[i] as WaveComponent;
    const cb = b[i] as WaveComponent;
    let d = (cb.phase - ca.phase) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    sum += Math.abs(d);
  }
  return sum;
}

describe('平滑过渡', () => {
  it('谱种子突变：显示分量按 τ≈1 s 指数趋近新海况并吸附（仿真时间驱动）', () => {
    const mk = (seed: number): ReturnType<typeof createWaveField> => {
      const f = createWaveField();
      f.configure('spectrum', spectrumParams({ randomSeed: seed }));
      return f;
    };
    const fOld = mk(42);
    fOld.evalSurface(0, 0, 100); // 确保旧态就位
    const fNew = mk(7);
    const fT = mk(42);
    fT.configure('spectrum', spectrumParams({ randomSeed: 7 })); // 突变 → 建立过渡

    // η 上新旧海况确有差异（过渡有意义）
    expect(maxAbsEtaDiff(fOld, fNew, 110)).toBeGreaterThan(0.01);

    // 过渡进度用分量相位弧长度量：lerpAngle 使弧长随 elapsed 精确按 p 比例推进
    const arc = totalPhaseMotion(fOld.components(), fNew.components());
    expect(arc).toBeGreaterThan(0.1);
    fT.evalSurface(3, 4, 100); // 首次调用：锚定仿真时间（本调用 elapsed = 0）
    fT.evalSurface(3, 4, 100.05); // Δt = 0.05 s → p = 1−e^(−0.05) ≈ 4.9%
    const early = totalPhaseMotion(fOld.components(), fT.components()) / arc;
    expect(early).toBeGreaterThan(0.02);
    expect(early).toBeLessThan(0.2);
    fT.evalSurface(3, 4, 103); // Δt ≈ 3 s → p ≈ 95%
    const mid = totalPhaseMotion(fOld.components(), fT.components()) / arc;
    expect(mid).toBeGreaterThan(0.8);
    // 吸附后与直接配置目标海况的场逐点一致
    fT.evalSurface(3, 4, 110);
    expect(maxAbsEtaDiff(fT, fNew, 110)).toBeLessThan(1e-9);
  });

  it('实验切换突变（分量数不同）：过渡期分量数 ≤ 64，最终吸附到目标', () => {
    const field = createWaveField();
    field.configure('wind', windParams(10, 60));
    field.evalSurface(0, 0, 50);
    const nOld = field.components().length;
    expect(nOld).toBeGreaterThan(0);

    field.configure('spectrum', spectrumParams({ randomSeed: 42 }));
    const during = field.components();
    expect(during.length).toBeLessThanOrEqual(MAX_WAVE_COMPONENTS);
    expect(during.length).toBe(Math.max(nOld, 48)); // 交叉淡化：两侧补零对齐

    const target = createWaveField();
    target.configure('spectrum', spectrumParams({ randomSeed: 42 }));
    field.evalSurface(0, 0, 10); // 锚定仿真时间
    field.evalSurface(0, 0, 200); // elapsed 190 s ≥ 吸附阈值
    expect(field.components()).toEqual(target.components());
    expect(field.components().length).toBe(48);
  });

  it('连续参数漂移不建过渡：components() 即时等于新目标（SPEC §9.1 公式连续）', () => {
    const field = createWaveField();
    field.configure('wind', windParams(10, 60));
    field.evalSurface(0, 0, 100);
    field.configure('wind', windParams(20, 60)); // 风速连续调整 → 直接目标态
    const other = createWaveField();
    other.configure('wind', windParams(20, 60));
    expect(field.components()).toEqual(other.components());

    field.configure('wind', windParams(0, 0)); // 连续漂移到平静：同样即时
    const calm = createWaveField();
    calm.configure('wind', windParams(0, 0));
    expect(field.components()).toEqual(calm.components());
  });

  it('仿真时间回退（reset）时重锚不崩溃，过渡仍收敛到新目标', () => {
    const field = createWaveField();
    field.configure('spectrum', spectrumParams({ randomSeed: 42 }));
    field.evalSurface(0, 0, 500);
    field.configure('spectrum', spectrumParams({ randomSeed: 7 }));
    field.evalSurface(0, 0, 200); // 时间回退 → 重锚
    const target = createWaveField();
    target.configure('spectrum', spectrumParams({ randomSeed: 7 }));
    field.evalSurface(0, 0, 200.5);
    expect(maxAbsEtaDiff(field, target, 200.5).valueOf()).toBeGreaterThan(0);
    field.evalSurface(0, 0, 210);
    expect(maxAbsEtaDiff(field, target, 210)).toBeLessThan(1e-9);
  });
});

// ============================================================
// teaching：教学对照数据（波形传播 ≠ 水质点前移）
// ============================================================

describe('teaching：波速与质点轨迹直径', () => {
  it('深水相速度 c = gT/2π；有限水深变慢；浅水趋向 √(gh)', () => {
    const T = 5;
    const cDeep = wavePhaseSpeed(T, Number.POSITIVE_INFINITY);
    expect(cDeep).toBeCloseTo((G * T) / (2 * Math.PI), 9);
    expect(wavePhaseSpeed(T, 20)).toBeLessThan(cDeep);
    expect(wavePhaseSpeed(T, 2)).toBeLessThan(Math.sqrt(G * 2) + 1e-9); // 浅水上界
    expect(wavePhaseSpeed(Number.NaN, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('表面轨迹直径 = 波高 H；深水衰减 e^{kz}；对照数据自洽', () => {
    const H = 1;
    const T = 5;
    const info = waveTeachingInfo(H, T, Number.POSITIVE_INFINITY);
    expect(info.surfaceOrbitDiameter).toBeCloseTo(H, 12);
    expect(info.phaseSpeed).toBeCloseTo((G * T) / (2 * Math.PI), 9);
    expect(info.wavelength).toBeCloseTo((G * T * T) / (2 * Math.PI), 9);
    // 默认 z=0：水面衰减比恒为 1
    expect(info.decayRatioAtZ).toBeCloseTo(1, 12);

    const z = -info.wavelength / 2;
    expect(orbitDiameter(H / 2, T, Number.POSITIVE_INFINITY, z)).toBeCloseTo(
      H * Math.exp(-Math.PI),
      9,
    );

    const deep = waveTeachingInfo(H, T, Number.POSITIVE_INFINITY, z);
    expect(deep.decayRatioAtZ).toBeCloseTo(Math.exp(-Math.PI), 9);
    expect(deep.orbitDiameterAtZ / deep.surfaceOrbitDiameter).toBeCloseTo(
      Math.exp(-Math.PI),
      9,
    );
  });
});
