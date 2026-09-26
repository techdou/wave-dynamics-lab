/**
 * 浮标运动学（纯逻辑）—— SPEC §7.4："以主波相速度随波移动的探针"。
 * 主波 = components() 中振幅最大的分量；相速度 cp = ω/k（深水 = λ/Tp）。
 * 浮标以 cp 沿主波传播方向平移，骑在同一波相上，故其垂向位移贴近波形包络。
 */
import type { WaveComponent } from '../core/types';

export interface MainWaveInfo {
  /** 传播方向单位向量 x 分量 */
  dirX: number;
  /** 传播方向单位向量 y 分量 */
  dirY: number;
  /** 相速度 cp = ω/k（m/s） */
  phaseSpeed: number;
  /** 波数 k（rad/m） */
  waveNumber: number;
  /** 角频率 ω（rad/s） */
  omega: number;
  /** 振幅（m） */
  amplitude: number;
}

/** 从当前分量中提取主波信息；无有效分量（平静海面）返回 null */
export function mainWaveFromComponents(
  comps: readonly WaveComponent[],
): MainWaveInfo | null {
  let dominant: WaveComponent | null = null;
  for (const c of comps) {
    if (c.amp <= 1e-9 || c.omega <= 1e-9) continue;
    if (!dominant || c.amp > dominant.amp) dominant = c;
  }
  if (!dominant) return null;
  const k = Math.hypot(dominant.kx, dominant.ky);
  if (k < 1e-9) return null;
  return {
    dirX: dominant.kx / k,
    dirY: dominant.ky / k,
    phaseSpeed: dominant.omega / k,
    waveNumber: k,
    omega: dominant.omega,
    amplitude: dominant.amp,
  };
}

/**
 * 浮标位置：p(t) = p0 + ĉ·cp·(t − t0)。
 * 以主波相速度沿传播方向漂移，与波形保持同相位（随浪）。
 */
export function buoyPositionAt(
  p0: { x: number; y: number },
  t0: number,
  t: number,
  wave: MainWaveInfo,
): { x: number; y: number } {
  const dt = t - t0;
  return {
    x: p0.x + wave.dirX * wave.phaseSpeed * dt,
    y: p0.y + wave.dirY * wave.phaseSpeed * dt,
  };
}
