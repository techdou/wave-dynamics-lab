/**
 * 渲染层纯逻辑测试（src/render/logic/**）—— uniform 打包 / 相位姿 / 拖尾 /
 * 粒子出生 / 布点 / 推板与浮标。THREE 与 WebGL 部分以 tsc 零错误为准。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MAX_WAVE_COMPONENTS } from '../src/core/constants';
import type { WaveComponent } from '../src/core/types';
import { createOceanSurface } from '../src/render/oceanSurface';
import { createSkyDome } from '../src/render/skyDome';
import { createParticleField } from '../src/render/particleSystems';
import { createTracerSystem, TRAIL_CAPACITY } from '../src/render/tracerSystem';
import { OCEAN_FRAG, OCEAN_VERT, SKY_FRAG, PARTICLE_FRAG, PARTICLE_VERT } from '../src/render/shaders';
import {
  DEFAULT_ORBIT,
  VIEW_TRANSITION_SECONDS,
  easePoseLerp,
  isPoseUnderwater,
  lerpPose,
  orbitPose,
  viewTargetPose,
} from '../src/render/logic/cameraMath';
import { easeInOutCubic } from '../src/render/logic/mathUtils';
import {
  buoyScenePosition,
  buoyTiltFromNormal,
  paddleDisplacement,
  paddleHinge,
  propagationSceneDir,
} from '../src/render/logic/props';
import {
  countActive,
  createParticlePool,
  emitParticle,
  particleFade,
  sprayEmitChance,
  stepParticles,
  whitecapEmitChance,
} from '../src/render/logic/spawn';
import { RingTrail } from '../src/render/logic/trails';
import { defaultTracerLayout } from '../src/render/logic/tracerLayout';
import {
  createWaveUniformPack,
  maxWavelength,
  packWaveComponents,
  planWorldSize,
} from '../src/render/logic/uniforms';

function comp(partial: Partial<WaveComponent>): WaveComponent {
  return {
    amp: 1,
    kx: 0.1,
    ky: 0,
    omega: 1,
    phase: 0,
    steepness: 0,
    ...partial,
  };
}

describe('render/logic/uniforms：波分量 uniform 打包', () => {
  it('按索引写入六个数组，count 为分量数', () => {
    const pack = createWaveUniformPack();
    packWaveComponents(pack, [
      comp({ amp: 0.5, kx: 0.12, ky: -0.3, omega: 1.57, phase: 0.7, steepness: 0.25 }),
      comp({ amp: 2, kx: 1, ky: 1, omega: 3, phase: 1, steepness: 0 }),
    ]);
    expect(pack.count).toBe(2);
    expect(pack.amp[0]).toBeCloseTo(0.5);
    expect(pack.kx[0]).toBeCloseTo(0.12);
    expect(pack.ky[0]).toBeCloseTo(-0.3);
    expect(pack.omega[0]).toBeCloseTo(1.57);
    expect(pack.phase[0]).toBeCloseTo(0.7);
    expect(pack.steep[0]).toBeCloseTo(0.25);
    expect(pack.amp[1]).toBeCloseTo(2);
  });

  it('超过 64 分量时截断到 MAX_WAVE_COMPONENTS', () => {
    const pack = createWaveUniformPack();
    const many: WaveComponent[] = [];
    for (let i = 0; i < MAX_WAVE_COMPONENTS + 30; i++) {
      many.push(comp({ amp: i }));
    }
    packWaveComponents(pack, many);
    expect(pack.count).toBe(MAX_WAVE_COMPONENTS);
    const last = pack.amp[MAX_WAVE_COMPONENTS - 1];
    expect(last).toBe(MAX_WAVE_COMPONENTS - 1);
  });

  it('空列表 → count 0；重复打包覆盖旧值', () => {
    const pack = createWaveUniformPack();
    packWaveComponents(pack, [comp({ amp: 9 })]);
    packWaveComponents(pack, []);
    expect(pack.count).toBe(0);
    packWaveComponents(pack, [comp({ amp: 3 })]);
    expect(pack.count).toBe(1);
    expect(pack.amp[0]).toBeCloseTo(3);
  });

  it('λmax = 2π/k 取所有分量最大值；planWorldSize = clamp(5λ, 240, 1400)', () => {
    const lambda = maxWavelength([
      comp({ kx: (2 * Math.PI) / 10, ky: 0 }), // λ=10
      comp({ kx: 0, ky: (2 * Math.PI) / 40 }), // λ=40
    ]);
    expect(lambda).toBeCloseTo(40, 6);
    expect(planWorldSize([])).toBe(240);
    expect(planWorldSize([comp({ kx: (2 * Math.PI) / 20 })])).toBe(240); // 5λ=100 < 下限
    expect(planWorldSize([comp({ kx: (2 * Math.PI) / 50 })])).toBeCloseTo(250); // 5λ=250
    expect(planWorldSize([comp({ kx: (2 * Math.PI) / 500 })])).toBe(1400);
    const comps = [comp({ kx: 0.05, ky: 0.02 }), comp({ kx: 0.4, ky: 0.1 })];
    expect(planWorldSize(comps)).toBe(planWorldSize(comps)); // 同输入同输出
  });
});

describe('render/logic/cameraMath：轨道与位姿', () => {
  it('orbitPose：仰角 0° 眼睛在水平面，距离守恒；90° 时在正上方', () => {
    const p = orbitPose({ ...DEFAULT_ORBIT, azimuthDeg: 0, elevationDeg: 0, distance: 80 });
    expect(p.py).toBeCloseTo(p.ty, 9);
    expect(p.pz).toBeCloseTo(80, 9);
    expect(Math.hypot(p.px - p.tx, p.py - p.ty, p.pz - p.tz)).toBeCloseTo(80, 9);
    const up = orbitPose({ ...DEFAULT_ORBIT, elevationDeg: 90, distance: 50 });
    expect(up.py).toBeCloseTo(up.ty + 50, 9);
    expect(up.px).toBeCloseTo(up.tx, 9);
    expect(up.pz).toBeCloseTo(up.tz, 9);
  });

  it('三视角目标位姿：水下视角眼睛在水下，侧视在 +x 侧且注视水下', () => {
    const sea = viewTargetPose('sea-surface', 240);
    const side = viewTargetPose('side-section', 240);
    const under = viewTargetPose('underwater', 240);
    expect(sea.py).toBeGreaterThan(0);
    expect(side.px).toBeGreaterThan(0);
    expect(side.ty).toBeLessThan(0);
    expect(under.py).toBeLessThan(0);
  });

  it('切换时长落在需求区间 [1, 1.2] s', () => {
    expect(VIEW_TRANSITION_SECONDS).toBeGreaterThanOrEqual(1);
    expect(VIEW_TRANSITION_SECONDS).toBeLessThanOrEqual(1.2);
  });
});

describe('render/logic/cameraMath：位姿插值', () => {
  const a = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, fov: 45 };
  const b = { px: 10, py: -20, pz: 30, tx: 1, ty: 2, tz: 3, fov: 58 };

  it('lerpPose：u=0/1 为端点，中间线性', () => {
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toEqual(b);
    const mid = lerpPose(a, b, 0.25);
    expect(mid.px).toBeCloseTo(2.5);
    expect(mid.py).toBeCloseTo(-5);
  });

  it('easePoseLerp：端点精确、关于中点对称、中点=线性中点', () => {
    expect(easePoseLerp(a, b, 0).px).toBe(0);
    expect(easePoseLerp(a, b, 1).px).toBe(10);
    const m1 = easePoseLerp(a, b, 0.2).px;
    const m2 = easePoseLerp(a, b, 0.8).px;
    expect(m1 + m2).toBeCloseTo(10, 9);
    expect(easePoseLerp(a, b, 0.5).px).toBeCloseTo(5, 9);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOutCubic(0.01)).toBeLessThan(0.001); // 起步缓
    expect(1 - easeInOutCubic(0.99)).toBeLessThan(0.001); // 收尾缓
  });

  it('水下判定：眼睛低于该处波面才算入水（恰在波面不算）', () => {
    const eta = (_x: number, _z: number) => 1.2;
    expect(isPoseUnderwater(0, 1.3, 0, eta)).toBe(false);
    expect(isPoseUnderwater(0, 1.2, 0, eta)).toBe(false);
    expect(isPoseUnderwater(0, 1.19, 0, eta)).toBe(true);
  });
});

describe('render/logic/trails：拖尾环形缓冲', () => {
  it('按时间旧→新写出；容量硬上限覆写最老', () => {
    const trail = new RingTrail(4, 100);
    trail.push(0, 0, 0, 0);
    trail.push(1, 1, 1, 1);
    trail.push(2, 2, 2, 2);
    const out = new Float32Array(4 * 3);
    expect(trail.writePositions(out)).toBe(3);
    expect([...out.slice(0, 9)]).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);

    trail.push(3, 3, 3, 3);
    trail.push(4, 4, 4, 4);
    expect(trail.length).toBe(4);
    const out2 = new Float32Array(4 * 3);
    trail.writePositions(out2);
    expect([...out2.slice(0, 12)]).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  });

  it('时间窗口：只保留最近 windowSeconds 秒（含边界 t ≥ newest − window）', () => {
    const trail = new RingTrail(100, 2);
    for (let i = 0; i <= 10; i++) trail.push(i, 0, 0, i * 0.5); // 0..5 s
    const out = new Float32Array(100 * 3);
    const n = trail.writePositions(out);
    expect(n).toBe(5); // t ∈ [3, 5] → i = 6..10
    expect(out[0]).toBeCloseTo(6); // x = i
    expect(out[(n - 1) * 3]).toBeCloseTo(10);
  });

  it('环回索引正确（写满一整圈以上）', () => {
    const trail = new RingTrail(3, 1000);
    for (let i = 0; i < 10; i++) trail.push(i, 0, 0, i);
    const out = new Float32Array(3 * 3);
    const n = trail.writePositions(out);
    expect(n).toBe(3);
    expect(out[0]).toBe(7);
    expect(out[3]).toBe(8);
    expect(out[6]).toBe(9);
  });

  it('last/clear；乱序时间戳被钳制为单调；过小 out 缓冲安全', () => {
    const trail = new RingTrail(8, 10);
    expect(trail.last()).toBeNull();
    trail.push(1, 2, 3, 5);
    trail.push(4, 5, 6, 6);
    expect(trail.last()).toEqual({ x: 4, y: 5, z: 6, t: 6 });
    trail.push(9, 9, 9, 4); // 时间回跳 → 钳到 6
    expect(trail.last()?.t).toBe(6);
    trail.clear();
    expect(trail.length).toBe(0);
    const trail2 = new RingTrail(5, 10);
    trail2.push(1, 1, 1, 0);
    expect(trail2.writePositions(new Float32Array(4))).toBe(1);
  });
});

describe('render/logic/spawn：白帽/飞沫出生与池管理', () => {
  it('白帽出生概率：强度 0 恒不出生；陡度阈值前 0、阈值后爬升封顶', () => {
    expect(whitecapEmitChance(0, 5)).toBe(0);
    expect(whitecapEmitChance(0.8, 0.1)).toBe(0);
    expect(whitecapEmitChance(0.8, 0.35)).toBe(0);
    expect(whitecapEmitChance(0.8, 0.75)).toBeCloseTo(0.8 * 0.9, 9);
    expect(whitecapEmitChance(1.5, 2)).toBeCloseTo(0.9, 9);
  });

  it('飞沫出生概率：6 m/s 以下为 0，随风速线性趋近 1', () => {
    expect(sprayEmitChance(5.9)).toBe(0);
    expect(sprayEmitChance(6)).toBeCloseTo(0, 9);
    expect(sprayEmitChance(17)).toBeCloseTo(0.5, 9);
    expect(sprayEmitChance(40)).toBe(1);
  });

  it('池容量硬上限：反复发射不超过 cap，全满时环形覆盖最老槽', () => {
    const pool = createParticlePool(4);
    let cursor = 0;
    const base = {
      px: 0,
      py: 0,
      pz: 0,
      windVx: 1,
      windVz: 0,
      spray: false,
      rngA: 0.5,
      rngB: 0.5,
      rngC: 0.5,
    };
    for (let i = 0; i < 10; i++) {
      cursor = emitParticle(pool, cursor, base);
      expect(countActive(pool)).toBeLessThanOrEqual(4);
    }
    expect(countActive(pool)).toBe(4);
    // 游标语义：全满时 cursor 恰指向最老槽（第 11 次发射覆盖它）
    const oldest = pool[2];
    expect(oldest).toBeDefined();
    const before = oldest?.px;
    cursor = emitParticle(pool, cursor, { ...base, px: 99 });
    expect(countActive(pool)).toBe(4);
    expect(pool[2]?.px).toBe(99);
    expect(before).not.toBe(99);
    void cursor;
  });

  it('粒子推进：上抛后重力减速、寿命到期回收', () => {
    const pool = createParticlePool(2);
    emitParticle(pool, 0, {
      px: 0, py: 10, pz: 0, windVx: 2, windVz: 0,
      spray: false, rngA: 0, rngB: 0, rngC: 0,
    });
    const p = pool[0];
    expect(p).toBeDefined();
    if (!p) return;
    const vy0 = p.vy; // 初速向上（上抛分量 0.8）
    expect(vy0).toBeGreaterThan(0);
    stepParticles(pool, 0.1);
    expect(p.py).not.toBe(10); // 发生位移
    expect(p.vy).toBeLessThan(vy0); // 重力持续减速
    for (let i = 0; i < 60; i++) stepParticles(pool, 0.05); // 寿命 0.7 s 必到期
    expect(p.active).toBe(false);
    expect(countActive(pool)).toBe(0);
  });

  it('飞沫粒子比浪花更快、更短命、更小；淡出系数随寿命线性衰减', () => {
    const pool = createParticlePool(2);
    const base = { px: 0, py: 0, pz: 0, windVx: 10, windVz: 0, rngA: 0.5, rngB: 0.5, rngC: 0.5 };
    emitParticle(pool, 0, { ...base, spray: false });
    emitParticle(pool, 1, { ...base, spray: true });
    const cap = pool[0];
    const spray = pool[1];
    expect(cap && spray).toBeTruthy();
    if (cap && spray) {
      expect(spray.life).toBeLessThan(cap.life);
      expect(spray.size).toBeLessThan(cap.size);
      expect(spray.vx).toBeGreaterThan(cap.vx);
    }
    if (cap) {
      cap.age = 0;
      expect(particleFade(cap)).toBe(1);
      cap.age = cap.life * 0.5;
      expect(particleFade(cap)).toBeCloseTo(0.5);
      cap.age = cap.life * 3;
      expect(particleFade(cap)).toBe(0);
    }
  });
});

describe('render/logic/tracerLayout：多层深度布点', () => {
  it('默认布点 5 层深度 × 5 水平位 = 25 粒，全部在剖面平面 x=0，含近表层与深水', () => {
    const layout = defaultTracerLayout();
    expect(layout.length).toBe(25);
    for (const s of layout) {
      expect(s.x).toBe(0);
      expect(s.z).toBeLessThanOrEqual(0);
    }
    const zs = new Set(layout.map((s) => s.z));
    expect(zs.has(-0.35)).toBe(true);
    expect(zs.has(-18)).toBe(true);
    expect(new Set(layout.map((s) => s.y)).size).toBe(5);
  });
});

describe('render/logic/props：造波机推板与浮标', () => {
  it('推板位移：振幅=H/2、相位 sin(φ−ωt)、周期换算正确', () => {
    expect(paddleDisplacement(0.5, 0, 4, 0)).toBeCloseTo(0, 12);
    expect(paddleDisplacement(0.5, 0, 4, 1)).toBeCloseTo(-0.5, 9);
    expect(paddleDisplacement(0.5, 90, 4, 0)).toBeCloseTo(0.5, 9);
    let peak = 0;
    for (let t = 0; t < 4; t += 0.01) {
      peak = Math.max(peak, Math.abs(paddleDisplacement(0.8, 37, 4, t)));
    }
    expect(peak).toBeCloseTo(0.8, 2);
  });

  it('传播方向映射：0° 沿物理 +y ⇒ 场景 −z；90° 沿物理 +x ⇒ 场景 +x', () => {
    expect(propagationSceneDir(0)).toEqual({ dx: 0, dz: -1 });
    const d = propagationSceneDir(90);
    expect(d.dx).toBeCloseTo(1, 12);
    expect(d.dz).toBeCloseTo(0, 12);
  });

  it('推板铰点在传播反方向边界，两块板错开 7 m', () => {
    const a = paddleHinge(0, 240, 0);
    const b = paddleHinge(0, 240, 1);
    expect(a.z).toBeCloseTo(240 / 2 - 6, 9);
    expect(a.x).toBeCloseTo(0, 9);
    expect(Math.abs(b.z)).toBeLessThan(Math.abs(a.z));
    expect(a.z - b.z).toBeCloseTo(7, 9);
  });

  it('浮标位置映射：场景 y=η、z=−物理y', () => {
    expect(buoyScenePosition(3, -7, 0.42)).toEqual({ x: 3, y: 0.42, z: 7 });
  });

  it('浮标摇摆：竖直法线角 0；倾斜法线角 = acos(n_y) 且轴水平', () => {
    const flat = buoyTiltFromNormal({ x: 0, y: 0, z: 1 });
    expect(flat.angle).toBe(0);
    const tilted = buoyTiltFromNormal({ x: 1, y: 0, z: 1 });
    expect(tilted.angle).toBeCloseTo(Math.PI / 4, 9);
    expect(Math.hypot(tilted.axisX, tilted.axisY, tilted.axisZ)).toBeCloseTo(1, 9);
    expect(tilted.axisY).toBe(0);
  });
});

describe('render/冒烟：node 侧可运行的子系统与 shader 一致性', () => {
  it('fog:true 的材质必须自带配套 fog chunk（缺 pars/vertex 会导致 GLSL 链接失败、整个 mesh 不渲染）', () => {
    // 回归防护：fog_fragment 引用 vFogDepth，需要顶点侧 fog_pars_vertex + fog_vertex
    // （写入 vFogDepth）与片元侧 fog_pars_fragment（声明 varying）配套，缺一即链接失败。
    // 此类错误 tsc/vite 均测不出（GLSL 只是字符串），曾在真机上导致海面整体不可见。
    const ocean = createOceanSurface();
    const sky = createSkyDome(2800);
    const field = createParticleField(4, '#eef4f4', 0.8);
    const matOf = (m: THREE.Material | THREE.Material[]): THREE.ShaderMaterial => m as THREE.ShaderMaterial;
    const useFog = (src: string): boolean => src.includes('fog_fragment');

    expect(matOf(ocean.mesh.material).fog).toBe(true);
    expect(useFog(OCEAN_FRAG)).toBe(true);
    expect(OCEAN_FRAG).toContain('fog_pars_fragment');
    expect(OCEAN_VERT).toContain('fog_pars_vertex');
    expect(OCEAN_VERT).toContain('fog_vertex');

    expect(matOf(field.points.material).fog).toBe(true);
    expect(useFog(PARTICLE_FRAG)).toBe(true);
    expect(PARTICLE_FRAG).toContain('fog_pars_fragment');
    expect(PARTICLE_VERT).toContain('fog_pars_vertex');
    expect(PARTICLE_VERT).toContain('fog_vertex');

    // 天空不接雾：声明与实现须一致（fog:false 且片元不含 fog_fragment）
    expect(matOf(sky.mesh.material).fog).toBe(false);
    expect(useFog(SKY_FRAG)).toBe(false);
    ocean.dispose();
    sky.dispose();
    field.dispose();
  });

  it('JS uniform 键都在对应 GLSL 源中有声明（防拼写漂移）', () => {
    const ocean = createOceanSurface();
    const sky = createSkyDome(2800);
    const field = createParticleField(8, '#eef4f4', 0.8);
    const declared = (src: string, name: string): boolean =>
      new RegExp(String.raw`uniform\s+\w+\s+${name}\s*(\[\d+\])?\s*;`).test(src);
    // UniformsLib.fog 提供的内置键由 three 的程序前缀声明（USE_FOG 下注入 fogColor/fogDensity 等），
    // 不在本项目 GLSL 源码字符串中，豁免校验。
    const fogLibKeys = new Set(Object.keys(THREE.UniformsLib.fog));
    for (const [name] of Object.entries(
      (ocean.mesh.material as THREE.ShaderMaterial).uniforms,
    )) {
      if (fogLibKeys.has(name)) continue;
      expect(declared(OCEAN_VERT, name) || declared(OCEAN_FRAG, name), name).toBe(true);
    }
    for (const [name] of Object.entries(
      (sky.mesh.material as THREE.ShaderMaterial).uniforms,
    )) {
      expect(declared(SKY_FRAG, name), name).toBe(true);
    }
    for (const [name] of Object.entries(
      (field.points.material as THREE.ShaderMaterial).uniforms,
    )) {
      if (fogLibKeys.has(name)) continue;
      expect(declared(PARTICLE_VERT, name) || declared(PARTICLE_FRAG, name), name).toBe(true);
    }
    ocean.dispose();
    sky.dispose();
    field.dispose();
  });

  it('海面 update/setWorldSize 复用 pack 缓冲且不抛错', () => {
    const ocean = createOceanSurface();
    const pack = createWaveUniformPack();
    packWaveComponents(pack, [comp({ amp: 0.7, kx: 0.2 })]);
    expect(() => ocean.update(pack, 3.2, 0.4, Number.POSITIVE_INFINITY)).not.toThrow();
    const oceanUniforms = (ocean.mesh.material as THREE.ShaderMaterial).uniforms;
    expect(oceanUniforms.uCount?.value).toBe(1);
    expect(oceanUniforms.uWaterDepth?.value).toBe(80); // 深水默认
    expect(() => ocean.setWorldSize(480)).not.toThrow();
    expect(ocean.mesh.geometry.getAttribute('position').count).toBe(257 * 257); // 256×256 分段
    ocean.dispose();
  });

  it('粒子场 sync：活跃数 ≤ 容量、drawRange 收敛', () => {
    const field = createParticleField(4, '#ffffff', 0.9);
    const pool = createParticlePool(6); // 池大于场容量也不越界
    let cursor = 0;
    const base = { px: 1, py: 0, pz: 2, windVx: 0, windVz: 0, spray: false, rngA: 0.5, rngB: 0.5, rngC: 0.5 };
    for (let i = 0; i < 6; i++) cursor = emitParticle(pool, cursor, base);
    stepParticles(pool, 0.016);
    expect(() => field.sync(pool)).not.toThrow();
    const geometry = (field.points as THREE.Points).geometry;
    expect(geometry.drawRange.count).toBe(4); // 容量截断
    field.dispose();
  });

  it('示踪系统：采样→几何重建→显隐→dispose 全链路（node 可跑部分）', () => {
    const tracer = createTracerSystem(defaultTracerLayout());
    const orbit = (x: number, y: number, z: number, t: number) => ({
      x: x + Math.sin(t) * 0.5,
      y,
      z: z + Math.cos(t) * 0.5,
    });
    for (let s = 1; s <= 120; s++) tracer.sampleAll(s / 60, orbit);
    expect(() => tracer.syncGeometry()).not.toThrow();
    const line = tracer.group.children[0] as THREE.Line;
    expect(line.geometry.drawRange.count).toBeGreaterThan(50); // 2 s × 60 步
    expect(line.geometry.drawRange.count).toBeLessThanOrEqual(TRAIL_CAPACITY);
    tracer.setTrailsVisible(false);
    expect(line.visible).toBe(false);
    expect(() => tracer.dispose()).not.toThrow();
  });

  it('天空穹顶：水下过渡系数被钳制在 [0,1]', () => {
    const sky = createSkyDome(2000);
    expect(() => sky.setUnderwaterBlend(0.5)).not.toThrow();
    expect(() => sky.setUnderwaterBlend(2)).not.toThrow();
    expect(() => sky.setUnderwaterBlend(-1)).not.toThrow();
    sky.dispose();
  });
});
