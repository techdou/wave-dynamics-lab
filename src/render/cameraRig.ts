/**
 * 三视角相机 rig（THREE 层）。
 * 视角切换：位置 + 注视点 + fov 在 VIEW_TRANSITION_SECONDS 内 easeInOutCubic 插值；
 * 海面视角支持轻量轨道交互（拖拽改方位/仰角、滚轮改距离），
 * 插值进行中忽略轨道输入；每帧输出当前是否水下（供雾/色调切换）。
 */
import * as THREE from 'three';
import type { ViewKind } from '../core/types';
import {
  DEFAULT_ORBIT,
  VIEW_TRANSITION_SECONDS,
  easePoseLerp,
  isPoseUnderwater,
  orbitPose,
  viewTargetPose,
} from './logic/cameraMath';
import type { CameraPose, OrbitState } from './logic/cameraMath';
import { clamp, lerp } from './logic/mathUtils';

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  setView(view: ViewKind, worldSize: number): void;
  /** 轨道输入增量（仅海面视角、非过渡期间生效） */
  applyOrbitDelta(dAzDeg: number, dElDeg: number, dZoomFactor: number): void;
  /** 每帧推进；sampleEta(场景x, 场景z) 返回该处波面高度 */
  update(
    dt: number,
    worldSize: number,
    sampleEta: (sceneX: number, sceneZ: number) => number,
  ): void;
  isTransitioning(): boolean;
  currentView(): ViewKind;
  isUnderwater(): boolean;
  dispose(): void;
}

export function createCameraRig(
  container: HTMLElement,
  aspect: number,
): CameraRig {
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 6000);

  let view: ViewKind = 'sea-surface';
  let orbit: OrbitState = { ...DEFAULT_ORBIT };
  let worldSizeCache = 240;
  let underwater = false;
  let transition: { from: CameraPose; to: CameraPose; u: number } | null = null;

  const currentPose: CameraPose = orbitPose(orbit);

  function applyPose(p: CameraPose): void {
    camera.position.set(p.px, p.py, p.pz);
    camera.lookAt(p.tx, p.ty, p.tz);
    if (Math.abs(camera.fov - p.fov) > 1e-4) {
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
    }
  }
  applyPose(currentPose);

  // ---- 轻量轨道交互（仅海面视角）----
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onPointerDown = (e: PointerEvent): void => {
    if (view !== 'sea-surface' || transition) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging || view !== 'sea-surface' || transition) return;
    const dAz = (e.clientX - lastX) * 0.25;
    const dEl = (e.clientY - lastY) * 0.18;
    lastX = e.clientX;
    lastY = e.clientY;
    orbit.azimuthDeg -= dAz;
    orbit.elevationDeg = clamp(orbit.elevationDeg + dEl, 3, 78);
  };
  const onPointerUp = (): void => {
    dragging = false;
  };
  const onWheel = (e: WheelEvent): void => {
    if (view !== 'sea-surface' || transition) return;
    e.preventDefault();
    orbit.distance = clamp(
      orbit.distance * (e.deltaY > 0 ? 1.1 : 0.9),
      18,
      worldSizeCache * 0.8,
    );
  };
  container.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  container.addEventListener('wheel', onWheel, { passive: false });

  return {
    camera,

    setView(next, worldSize) {
      if (next === view && !transition) {
        worldSizeCache = worldSize;
        return;
      }
      const from: CameraPose = transition
        ? easePoseLerp(transition.from, transition.to, transition.u)
        : { ...currentPose };
      worldSizeCache = worldSize;
      transition = { from, to: viewTargetPose(next, worldSize), u: 0 };
      view = next;
    },

    applyOrbitDelta(dAzDeg, dElDeg, dZoomFactor) {
      if (view !== 'sea-surface' || transition) return;
      orbit.azimuthDeg -= dAzDeg;
      orbit.elevationDeg = clamp(orbit.elevationDeg + dElDeg, 3, 78);
      orbit.distance = clamp(
        orbit.distance * dZoomFactor,
        18,
        worldSizeCache * 0.8,
      );
    },

    update(dt, worldSize, sampleEta) {
      worldSizeCache = worldSize;
      if (transition) {
        transition.u = Math.min(1, transition.u + dt / VIEW_TRANSITION_SECONDS);
        const pose = easePoseLerp(transition.from, transition.to, transition.u);
        currentPose.px = pose.px;
        currentPose.py = pose.py;
        currentPose.pz = pose.pz;
        currentPose.tx = pose.tx;
        currentPose.ty = pose.ty;
        currentPose.tz = pose.tz;
        currentPose.fov = pose.fov;
        applyPose(pose);
        if (transition.u >= 1) transition = null;
      } else {
        const target =
          view === 'sea-surface'
            ? orbitPose(orbit)
            : viewTargetPose(view, worldSize);
        // 非过渡期做小步平滑（ worldSize 变化时不跳变）
        const k = 1 - Math.exp(-6 * Math.max(dt, 1e-4));
        currentPose.px = lerp(currentPose.px, target.px, k);
        currentPose.py = lerp(currentPose.py, target.py, k);
        currentPose.pz = lerp(currentPose.pz, target.pz, k);
        currentPose.tx = lerp(currentPose.tx, target.tx, k);
        currentPose.ty = lerp(currentPose.ty, target.ty, k);
        currentPose.tz = lerp(currentPose.tz, target.tz, k);
        currentPose.fov = lerp(currentPose.fov, target.fov, k);
        applyPose(currentPose);
      }
      underwater = isPoseUnderwater(
        camera.position.x,
        camera.position.y,
        camera.position.z,
        sampleEta,
      );
    },

    isTransitioning: () => transition !== null,
    currentView: () => view,
    isUnderwater: () => underwater,

    dispose() {
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('wheel', onWheel);
    },
  };
}
