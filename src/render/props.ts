/**
 * 场景道具（THREE 层）：
 *  - 实验二双造波机推板：活塞位移 = a·sin(φ − ωt)，相位/振幅/周期全部来自
 *    store.params.interference 的真实波形参数（经 logic/props.ts 计算）；
 *  - 随浪浮标：水平位置挂 store.probe，竖直挂 physics.evalSurface 的 η，
 *    并随该处波面法线摇摆；
 *  - 侧视剖面辅助：深度参考线（0/−5/−10/−20 m）与 x=0 剖面波形曲线。
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import {
  buoyScenePosition,
  buoyTiltFromNormal,
  paddleDisplacement,
  paddleHinge,
  propagationSceneDir,
} from './logic/props';

/** 单台造波机的渲染参数（renderer 从 store.params.interference 提取） */
export interface WaveMakerVisual {
  angleDeg: number;
  /** 物理振幅（= 波高 H/2，m） */
  amp: number;
  phaseDeg: number;
  period: number;
}

export interface SceneProps {
  group: THREE.Group;
  setWaveMakers(makers: readonly WaveMakerVisual[] | null, worldSize: number): void;
  /** 每帧推板动画（waveTime：冻结波形时停在冻结时刻） */
  updateWaveMakers(waveTime: number): void;
  updateBuoy(probeX: number, probeY: number, eta: number, normal: Vec3): void;
  /** worldSize 变化时重建参考线长度与标签位置 */
  setReferenceExtent(worldSize: number): void;
  /** 每帧重建 x=0 剖面波形曲线；sample(物理y) → η */
  updateProfileLine(worldSize: number, sample: (physicalY: number) => number): void;
  dispose(): void;
}

const PROFILE_POINTS = 240;
const REFERENCE_DEPTHS = [0, -5, -10, -20] as const;
const REFERENCE_LABELS = ['静水面 0 m', '−5 m', '−10 m', '−20 m'] as const;

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(10, 30, 36, 0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '44px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillStyle = '#c8e6e2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(7, 2.2, 1);
  sprite.renderOrder = 20;
  return sprite;
}

export function createSceneProps(): SceneProps {
  const group = new THREE.Group();

  // ---- 造波机推板（构建一次，参数每帧/每变更更新）----
  const paddleMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setStyle('#3a6b72'),
    roughness: 0.55,
    metalness: 0.35,
  });
  const paddleGeometry = new THREE.BoxGeometry(1, 1, 1);
  const paddles: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.Mesh(paddleGeometry, paddleMaterial);
    mesh.visible = false;
    group.add(mesh);
    paddles.push(mesh);
  }
  let makersCache: readonly WaveMakerVisual[] | null = null;
  let worldSizeCache = 240;

  function layoutPaddles(): void {
    if (!makersCache) return;
    for (let i = 0; i < paddles.length; i++) {
      const mesh = paddles[i];
      const maker = makersCache[i];
      if (!mesh || !maker) continue;
      const hinge = paddleHinge(maker.angleDeg, worldSizeCache, i);
      const sceneDir = propagationSceneDir(maker.angleDeg);
      const dir = new THREE.Vector3(sceneDir.dx, 0, sceneDir.dz).normalize();
      mesh.scale.set(worldSizeCache * 0.82, 7, 0.5);
      mesh.position.set(hinge.x, -1.6, hinge.z);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      mesh.visible = true;
    }
  }

  // ---- 随浪浮标 ----
  const buoy = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 20, 14),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color().setStyle('#d2622f'),
      roughness: 0.6,
      metalness: 0.15,
    }),
  );
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 1.6, 8),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color().setStyle('#b8c8c6'),
      roughness: 0.4,
      metalness: 0.5,
    }),
  );
  mast.position.y = 1.1;
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 10, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color().setStyle('#ffd27a') }),
  );
  lamp.position.y = 1.95;
  buoy.add(hull, mast, lamp);
  group.add(buoy);

  // ---- 深度参考线 + 标签 ----
  const refGeometry = new THREE.BufferGeometry();
  const refPositions = new Float32Array(REFERENCE_DEPTHS.length * 2 * 3);
  refGeometry.setAttribute('position', new THREE.BufferAttribute(refPositions, 3));
  const refMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color().setStyle('#4f7d7d'),
    transparent: true,
    opacity: 0.7,
  });
  const refLines = new THREE.LineSegments(refGeometry, refMaterial);
  refLines.frustumCulled = false;
  group.add(refLines);
  const refLabels: THREE.Sprite[] = [];
  for (const text of REFERENCE_LABELS) {
    const sprite = makeLabelSprite(text);
    group.add(sprite);
    refLabels.push(sprite);
  }

  // ---- x=0 剖面波形曲线 ----
  const profileGeometry = new THREE.BufferGeometry();
  const profilePositions = new Float32Array(PROFILE_POINTS * 3);
  profileGeometry.setAttribute('position', new THREE.BufferAttribute(profilePositions, 3));
  profileGeometry.setDrawRange(0, PROFILE_POINTS);
  const profileMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color().setStyle('#8ff0e4'),
    transparent: true,
    opacity: 0.9,
  });
  const profileLine = new THREE.Line(profileGeometry, profileMaterial);
  profileLine.frustumCulled = false;
  group.add(profileLine);

  return {
    group,

    setWaveMakers(makers, worldSize) {
      makersCache = makers;
      worldSizeCache = worldSize;
      if (!makers) {
        for (const mesh of paddles) mesh.visible = false;
        return;
      }
      layoutPaddles();
    },

    updateWaveMakers(waveTime) {
      if (!makersCache) return;
      for (let i = 0; i < paddles.length; i++) {
        const mesh = paddles[i];
        const maker = makersCache[i];
        if (!mesh || !maker || !mesh.visible) continue;
        const disp = paddleDisplacement(maker.amp, maker.phaseDeg, maker.period, waveTime);
        const hinge = paddleHinge(maker.angleDeg, worldSizeCache, i);
        const dir = propagationSceneDir(maker.angleDeg);
        mesh.position.set(hinge.x + dir.dx * disp, -1.6, hinge.z + dir.dz * disp);
      }
    },

    updateBuoy(probeX, probeY, eta, normal) {
      const pos = buoyScenePosition(probeX, probeY, eta);
      buoy.position.set(pos.x, pos.y, pos.z);
      const tilt = buoyTiltFromNormal(normal);
      if (tilt.angle > 1e-4) {
        buoy.quaternion.setFromAxisAngle(
          new THREE.Vector3(tilt.axisX, tilt.axisY, tilt.axisZ),
          tilt.angle,
        );
      } else {
        buoy.quaternion.identity();
      }
    },

    setReferenceExtent(worldSize) {
      const half = worldSize / 2;
      for (let i = 0; i < REFERENCE_DEPTHS.length; i++) {
        const depth = REFERENCE_DEPTHS[i] ?? 0;
        refPositions[i * 6] = 0;
        refPositions[i * 6 + 1] = depth;
        refPositions[i * 6 + 2] = -half;
        refPositions[i * 6 + 3] = 0;
        refPositions[i * 6 + 4] = depth;
        refPositions[i * 6 + 5] = half;
        const label = refLabels[i];
        if (label) label.position.set(0, depth + 0.8, half);
      }
      refGeometry.getAttribute('position').needsUpdate = true;
      worldSizeCache = worldSize;
    },

    updateProfileLine(worldSize, sample) {
      const half = worldSize / 2;
      for (let i = 0; i < PROFILE_POINTS; i++) {
        const py = -half + (worldSize * i) / (PROFILE_POINTS - 1); // 物理 y
        const eta = sample(py);
        profilePositions[i * 3] = 0; // 场景 x = 物理 x = 0
        profilePositions[i * 3 + 1] = eta; // 场景 y = η
        profilePositions[i * 3 + 2] = -py; // 场景 z = −物理 y
      }
      profileGeometry.getAttribute('position').needsUpdate = true;
    },

    dispose() {
      paddleGeometry.dispose();
      paddleMaterial.dispose();
      hull.geometry.dispose();
      (hull.material as THREE.Material).dispose();
      mast.geometry.dispose();
      (mast.material as THREE.Material).dispose();
      lamp.geometry.dispose();
      (lamp.material as THREE.Material).dispose();
      refGeometry.dispose();
      refMaterial.dispose();
      for (const sprite of refLabels) {
        const m = sprite.material as THREE.SpriteMaterial;
        m.map?.dispose();
        m.dispose();
      }
      profileGeometry.dispose();
      profileMaterial.dispose();
    },
  };
}
