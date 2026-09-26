/**
 * 水质点示踪系统（THREE 层）。
 * 多层深度布点（logic/tracerLayout）+ 每仿真步 physics.particleOrbit 采样；
 * 「显示轨迹」= 每粒子保留最近数秒位置的拖尾（RingTrail 环形缓冲 + 硬上限）；
 * 「冻结波形」时波形时间停住，但本系统仍以继续前进的仿真时间采样
 * particleOrbit —— 波形静止而质点仍在原地转轨道，直接支撑教学对比。
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import type { TracerSpec } from './logic/tracerLayout';
import { RingTrail } from './logic/trails';

/** 拖尾硬上限（点数）；固定仿真步 1/60 s 时约 6.6 s */
export const TRAIL_CAPACITY = 400;
/** 拖尾保留窗口（仿真秒） */
export const TRAIL_WINDOW_SECONDS = 6;

export interface TracerSystem {
  group: THREE.Group;
  /** 每个固定仿真步调用一次（clock.onStep） */
  sampleAll(simTime: number, orbit: (x: number, y: number, z: number, t: number) => Vec3): void;
  /** 每帧渲染前把环形缓冲内容重建到顶点缓冲 */
  syncGeometry(): void;
  /** 「显示轨迹」开关：拖尾线显隐（当前位置标记不受影响） */
  setTrailsVisible(visible: boolean): void;
  dispose(): void;
}

/** 拖尾尾色（线性 RGB，加色混合下暗色即透明） */
const TRAIL_TINT = { r: 0.22, g: 0.75, b: 0.7 };

interface TracerEntry {
  trail: RingTrail;
  line: THREE.Line;
  positionAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
}

export function createTracerSystem(layout: readonly TracerSpec[]): TracerSystem {
  const group = new THREE.Group();
  const entries: TracerEntry[] = [];

  const lineMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  for (let i = 0; i < layout.length; i++) {
    const geometry = new THREE.BufferGeometry();
    const positionAttr = new THREE.BufferAttribute(
      new Float32Array(TRAIL_CAPACITY * 3),
      3,
    );
    const colorAttr = new THREE.BufferAttribute(
      new Float32Array(TRAIL_CAPACITY * 3),
      3,
    );
    positionAttr.setUsage(THREE.DynamicDrawUsage);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('color', colorAttr);
    geometry.setDrawRange(0, 0);
    const line = new THREE.Line(geometry, lineMaterial);
    line.frustumCulled = false;
    group.add(line);
    entries.push({ trail: new RingTrail(TRAIL_CAPACITY, TRAIL_WINDOW_SECONDS), line, positionAttr, colorAttr });
  }

  // 当前位置标记：小亮点
  const dotGeometry = new THREE.BufferGeometry();
  const dotPositions = new Float32Array(layout.length * 3);
  dotGeometry.setAttribute('position', new THREE.BufferAttribute(dotPositions, 3));
  dotGeometry.setDrawRange(0, layout.length);
  const dotMaterial = new THREE.PointsMaterial({
    color: new THREE.Color().setStyle('#8ff0e4'),
    size: 0.55,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const dots = new THREE.Points(dotGeometry, dotMaterial);
  dots.frustumCulled = false;
  group.add(dots);

  return {
    group,

    sampleAll(simTime, orbit) {
      for (let i = 0; i < layout.length; i++) {
        const spec = layout[i];
        const entry = entries[i];
        if (!spec || !entry) continue;
        const p = orbit(spec.x, spec.y, spec.z, simTime);
        entry.trail.push(p.x, p.y, p.z, simTime); // 存物理坐标
        dotPositions[i * 3] = p.x;
        dotPositions[i * 3 + 1] = p.z; // 场景 y = 物理 z
        dotPositions[i * 3 + 2] = -p.y; // 场景 z = −物理 y
      }
      dotGeometry.getAttribute('position').needsUpdate = true;
    },

    syncGeometry() {
      for (const entry of entries) {
        const n = entry.trail.writePositions(
          entry.positionAttr.array as Float32Array,
        );
        // 旧→新沿拖尾渐亮（加色混合下尾部自然淡出）
        const colors = entry.colorAttr.array as Float32Array;
        for (let i = 0; i < n; i++) {
          const t = n > 1 ? i / (n - 1) : 1;
          const b = 0.06 + 0.94 * t * t;
          colors[i * 3] = TRAIL_TINT.r * b;
          colors[i * 3 + 1] = TRAIL_TINT.g * b;
          colors[i * 3 + 2] = TRAIL_TINT.b * b;
        }
        entry.line.geometry.setDrawRange(0, n);
        entry.positionAttr.needsUpdate = true;
        entry.colorAttr.needsUpdate = true;
      }
    },

    setTrailsVisible(visible) {
      for (const entry of entries) entry.line.visible = visible;
    },

    dispose() {
      for (const entry of entries) entry.line.geometry.dispose();
      lineMaterial.dispose();
      dotGeometry.dispose();
      dotMaterial.dispose();
    },
  };
}
