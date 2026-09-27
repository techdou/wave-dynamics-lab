/**
 * 画质档位（低配模式）纯逻辑——持久化与切换。
 * 低配档只削减视觉开销（像素比、后处理 pass、泡沫更新频率），
 * 波形几何、物理量与仪器读数不受任何影响。
 * 类型 QualityLevel 定义于 core/types（渲染层与 UI 层共用）。
 */
import type { QualityLevel } from '../../core/types';

const STORAGE_KEY = 'wave-quality-level';

/** 从 localStorage 读持久化档位；无记录/值非法/存储不可用返回 null */
export function readPersistedQuality(): QualityLevel | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'high' || raw === 'low') return raw;
    return null;
  } catch {
    return null; // 隐私模式/禁用存储：静默降级为不持久化
  }
}

/** 持久化档位；存储不可用时静默忽略 */
export function persistQuality(level: QualityLevel): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // 同上
  }
}

/** 档位取反 */
export function toggleQuality(level: QualityLevel): QualityLevel {
  return level === 'high' ? 'low' : 'high';
}
