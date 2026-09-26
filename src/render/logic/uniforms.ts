/**
 * 波分量 → GPU uniform 数组打包（纯逻辑，供单元测试）。
 * 数据源是 physics.waveField.components()（≤ MAX_WAVE_COMPONENTS 项），
 * 打包结果直供海面 ShaderMaterial 的 float 数组 uniform。
 */
import { MAX_WAVE_COMPONENTS } from '../../core/constants';
import type { WaveComponent } from '../../core/types';

/** 一次打包的可复用缓冲（避免每帧分配 Float32Array） */
export interface WaveUniformPack {
  /** 实际有效分量数（≤ MAX_WAVE_COMPONENTS） */
  count: number;
  amp: Float32Array;
  kx: Float32Array;
  ky: Float32Array;
  omega: Float32Array;
  phase: Float32Array;
  steep: Float32Array;
}

export function createWaveUniformPack(): WaveUniformPack {
  const n = MAX_WAVE_COMPONENTS;
  return {
    count: 0,
    amp: new Float32Array(n),
    kx: new Float32Array(n),
    ky: new Float32Array(n),
    omega: new Float32Array(n),
    phase: new Float32Array(n),
    steep: new Float32Array(n),
  };
}

/**
 * 把分量列表写入 pack（超出 64 的部分截断，不足的部分保留旧值但 count 限定读取范围）。
 * 返回同一 pack 引用便于链式使用。
 */
export function packWaveComponents(
  pack: WaveUniformPack,
  components: readonly WaveComponent[],
): WaveUniformPack {
  const n = Math.min(components.length, MAX_WAVE_COMPONENTS);
  for (let i = 0; i < n; i++) {
    const c = components[i];
    if (!c) continue;
    pack.amp[i] = c.amp;
    pack.kx[i] = c.kx;
    pack.ky[i] = c.ky;
    pack.omega[i] = c.omega;
    pack.phase[i] = c.phase;
    pack.steep[i] = c.steepness;
  }
  pack.count = n;
  return pack;
}

/** 分量中的最大波长 λmax = max(2π/k)；无有效分量时返回 0 */
export function maxWavelength(components: readonly WaveComponent[]): number {
  let lambdaMax = 0;
  for (const c of components) {
    const k = Math.hypot(c.kx, c.ky);
    if (k < 1e-9) continue;
    lambdaMax = Math.max(lambdaMax, (2 * Math.PI) / k);
  }
  return lambdaMax;
}

/**
 * 海面网格世界尺寸（m）：覆盖约 5 个主波长，钳制在 [240, 1400]。
 * 输入相同 ⇒ 输出相同（每帧调用无抖动）；空海况取下限 240。
 */
export function planWorldSize(components: readonly WaveComponent[]): number {
  const lambdaMax = maxWavelength(components);
  if (lambdaMax <= 0) return 240;
  return Math.min(1400, Math.max(240, lambdaMax * 5));
}
