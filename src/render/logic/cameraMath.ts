/**
 * 相机 rig 纯逻辑（无 THREE 依赖，供单元测试）。
 * 位姿统一用「场景坐标」（Three.js y-up，映射见 SPEC §5.1：
 * 场景.x = 物理.x、场景.y = 物理.z、场景.z = −物理.y）。
 */
import type { ViewKind } from '../../core/types';
import { clamp01, degToRad, easeInOutCubic, lerp } from './mathUtils';

/** 相机位姿：眼睛位置 + 注视点 + 视场角（deg） */
export interface CameraPose {
  px: number;
  py: number;
  pz: number;
  tx: number;
  ty: number;
  tz: number;
  fov: number;
}

/** 视角切换平滑插值时长（s）——需求 1–1.2 s，取中值 */
export const VIEW_TRANSITION_SECONDS = 1.1;

/** 海面轨道视角的默认轨道参数（方位角/仰角/距离，场景系） */
export interface OrbitState {
  /** 方位角（deg），0 = 从场景 +z 方向看向原点，向右增 */
  azimuthDeg: number;
  /** 仰角（deg），0 = 水平看，向上增 */
  elevationDeg: number;
  /** 到注视点的距离（m） */
  distance: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export const DEFAULT_ORBIT: OrbitState = {
  azimuthDeg: 38,
  elevationDeg: 16,
  distance: 100,
  targetX: 0,
  targetY: -2,
  targetZ: 0,
};

/** 轨道参数 → 位姿（球坐标，y-up：y = dist·sin(el)，水平半径 = dist·cos(el)） */
export function orbitPose(orbit: OrbitState): CameraPose {
  const az = degToRad(orbit.azimuthDeg);
  const el = degToRad(orbit.elevationDeg);
  const r = Math.max(5, orbit.distance);
  const horiz = r * Math.cos(el);
  return {
    px: orbit.targetX + horiz * Math.sin(az),
    py: orbit.targetY + r * Math.sin(el),
    pz: orbit.targetZ + horiz * Math.cos(az),
    tx: orbit.targetX,
    ty: orbit.targetY,
    tz: orbit.targetZ,
    fov: 45,
  };
}

/** 三视角的目标位姿；worldSize 为当前海面世界尺寸（m） */
export function viewTargetPose(view: ViewKind, worldSize: number): CameraPose {
  switch (view) {
    case 'sea-surface': {
      const s = worldSize;
      const orbit: OrbitState = {
        ...DEFAULT_ORBIT,
        distance: clamp01(s / 240) * 60 + 70, // 随海面尺寸拉近拉远
      };
      return orbitPose(orbit);
    }
    case 'side-section':
      // 从场景 +x 侧看向 x=0 剖面平面：平面内 场景z = 物理 y（传播方向）、
      // 场景y = 物理 z（深度）——水下与深度参考线尽收眼底
      return {
        px: worldSize * 0.58,
        py: 10,
        pz: 0,
        tx: 0,
        ty: -6,
        tz: 0,
        fov: 36,
      };
    case 'underwater':
      // 水下斜上方仰视水面
      return {
        px: 0,
        py: -14,
        pz: worldSize * 0.16,
        tx: 0,
        ty: -1,
        tz: 0,
        fov: 58,
      };
  }
}

/** 逐数值线性插值两个位姿（t 需已做过 easing） */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return {
    px: lerp(a.px, b.px, t),
    py: lerp(a.py, b.py, t),
    pz: lerp(a.pz, b.pz, t),
    tx: lerp(a.tx, b.tx, t),
    ty: lerp(a.ty, b.ty, t),
    tz: lerp(a.tz, b.tz, t),
    fov: lerp(a.fov, b.fov, t),
  };
}

/** 带缓动的位姿过渡插值（u ∈ [0,1] 原始进度，内部 easeInOutCubic） */
export function easePoseLerp(
  a: CameraPose,
  b: CameraPose,
  u: number,
): CameraPose {
  return lerpPose(a, b, easeInOutCubic(u));
}

/**
 * 水下判定：相机眼睛高度低于该处波面即视为入水。
 * sampleEta(场景x, 场景z) 返回该点波面高度（场景 y，= 物理 η）。
 */
export function isPoseUnderwater(
  px: number,
  py: number,
  pz: number,
  sampleEta: (sceneX: number, sceneZ: number) => number,
): boolean {
  return py < sampleEta(px, pz);
}
