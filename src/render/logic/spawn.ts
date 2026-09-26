/**
 * 浪花粒子（白帽泡沫 + 风驱飞沫）纯逻辑（无 THREE 依赖，供单元测试）。
 * 设计要点：
 *  - 固定容量对象池（硬上限，防内存无限增长），满时环形复用最老槽位；
 *  - 出生判定输入全部来自真实物理量：whitecapIntensity()、evalSurface 波陡、
 *    实验参数中的风速/风向；
 *  - 随机数由外部注入（rng01 ∈ [0,1)），保证可测试。
 */
import { G } from '../../core/constants';

export interface SprayParticle {
  active: boolean;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  /** 渲染尺寸系数（场景 m） */
  size: number;
}

export function createParticlePool(capacity: number): SprayParticle[] {
  const pool: SprayParticle[] = [];
  for (let i = 0; i < capacity; i++) {
    pool.push({
      active: false,
      px: 0,
      py: -1e4,
      pz: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
      life: 1,
      size: 0.3,
    });
  }
  return pool;
}

export function countActive(pool: readonly SprayParticle[]): number {
  let n = 0;
  for (const p of pool) if (p.active) n += 1;
  return n;
}

/**
 * 白帽出生概率 [0,1]：
 * 全局白帽强度 ×（局部波陡超过阈值后的归一化余量）。
 * intensity = 0（无风平海况）⇒ 恒为 0，任何陡度都不出生。
 */
export function whitecapEmitChance(
  intensity: number,
  steepness: number,
  steepThreshold = 0.35,
): number {
  if (intensity <= 0) return 0;
  const margin = Math.min(1, Math.max(0, (steepness - steepThreshold) / 0.4));
  return margin * Math.min(1, intensity) * 0.9;
}

/** 飞沫出生概率 [0,1]：风速 ≥ 6 m/s 起出现，28 m/s 趋近每帧必发 */
export function sprayEmitChance(windSpeed: number): number {
  if (windSpeed < 6) return 0;
  return Math.min(1, (windSpeed - 6) / 22);
}

export interface EmitOptions {
  /** 出生点（场景坐标） */
  px: number;
  py: number;
  pz: number;
  /** 风的水平速度矢量（场景 m/s） */
  windVx: number;
  windVz: number;
  /** 白帽=false（浪花团），true=飞沫（更小更快更短命） */
  spray: boolean;
  /** 三个独立 [0,1) 随机数 */
  rngA: number;
  rngB: number;
  rngC: number;
}

/**
 * 从池中取一个空闲槽发射粒子（环形游标扫描；全满时覆盖游标处最老槽）。
 * 返回新游标。速度按粒子类型合成风驱 + 上抛分量。
 */
export function emitParticle(
  pool: SprayParticle[],
  cursor: number,
  opts: EmitOptions,
): number {
  const cap = pool.length;
  let slot = -1;
  for (let i = 0; i < cap; i++) {
    const idx = (cursor + i) % cap;
    const p = pool[idx];
    if (p && !p.active) {
      slot = idx;
      break;
    }
  }
  if (slot < 0) {
    slot = cursor % cap; // 池满：覆盖最老（环形语义即最老优先复用）
  }
  const p = pool[slot];
  if (!p) return (slot + 1) % cap;

  if (opts.spray) {
    const speed = 0.8 + opts.rngC * 0.8; // 风速比例系数
    p.vx = opts.windVx * speed;
    p.vz = opts.windVz * speed;
    p.vy = 1.5 + opts.rngA * 2.5;
    p.life = 0.35 + opts.rngB * 0.5;
    p.size = 0.1 + opts.rngC * 0.12;
  } else {
    const speed = 0.18 + opts.rngC * 0.2;
    p.vx = opts.windVx * speed;
    p.vz = opts.windVz * speed;
    p.vy = 0.8 + opts.rngA * 1.6;
    p.life = 0.7 + opts.rngB * 1.1;
    p.size = 0.28 + opts.rngA * 0.35;
  }
  p.px = opts.px;
  p.py = opts.py;
  p.pz = opts.pz;
  p.age = 0;
  p.active = true;
  return (slot + 1) % cap;
}

/**
 * 推进全部粒子一个真实帧步：阻尼重力 + 位置积分 + 寿命回收。
 * 返回推进后活跃数。
 */
export function stepParticles(pool: SprayParticle[], dt: number): number {
  let active = 0;
  const drag = Math.exp(-1.4 * dt); // 空气阻尼（帧率无关）
  for (const p of pool) {
    if (!p.active) continue;
    p.age += dt;
    if (p.age >= p.life) {
      p.active = false;
      continue;
    }
    p.vx *= drag;
    p.vz *= drag;
    p.vy = p.vy * drag - G * 0.45 * dt;
    p.px += p.vx * dt;
    p.py += p.vy * dt;
    p.pz += p.vz * dt;
    active += 1;
  }
  return active;
}

/** 粒子渲染淡出系数 [0,1]：1 - age/life（配合点着色器 alpha） */
export function particleFade(p: SprayParticle): number {
  return Math.max(0, 1 - p.age / p.life);
}
