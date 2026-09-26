/**
 * 任务进度持久化 —— src/tasks 模块私有。
 * 目标存储为浏览器 localStorage；隐私模式 / 配额满 / 非浏览器环境一律 try/catch
 * 静默降级到内存实现（功能可用但不跨会话），绝不抛错打断玩法。
 * 存储后端可注入（KeyValueStore），便于测试与宿主环境替换。
 */
import type { TaskId } from '../core/types';
import type { UnknownSeaOutcome } from './taskDefs';

/** 最小键值存储接口（localStorage 的结构子集，可注入替身） */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 单个任务的持久化状态 */
export interface PersistedTaskState {
  done: boolean;
  prediction: string;
  submitCount: number;
  completedAtSimTime: number | null;
  lastFeedback: string | null;
  /** 任务六：最近一次提交的真值/估值/误差（真值仅在 done 后由 UI 展示） */
  unknownSeaOutcome?: UnknownSeaOutcome | null;
}

export interface PersistedTasks {
  version: 1;
  savedAtWallClock: number;
  tasks: Partial<Record<TaskId, PersistedTaskState>>;
}

export interface TaskPersistence {
  load(): PersistedTasks | null;
  save(data: PersistedTasks): void;
  clear(): void;
}

/** 内存实现（降级兜底 / 测试替身） */
export function createMemoryStorage(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 探测浏览器 localStorage；不可读写（隐私模式等）返回 null */
export function resolveBrowserLocalStorage(): KeyValueStore | null {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    if (!ls) return null;
    const probe = '__wave_lab_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/**
 * 创建任务持久化器。storage 缺省时自动探测 localStorage，
 * 探测失败退化为内存实现；所有读写均 try/catch，绝不抛错。
 */
export function createTaskPersistence(
  storage?: KeyValueStore | null,
  storageKey = 'wave-lab:tasks:v1',
): TaskPersistence {
  const backend: KeyValueStore = storage ?? resolveBrowserLocalStorage() ?? createMemoryStorage();
  return {
    load() {
      try {
        const raw = backend.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedTasks;
        if (!parsed || parsed.version !== 1 || typeof parsed.tasks !== 'object') return null;
        return parsed;
      } catch {
        return null;
      }
    },
    save(data) {
      try {
        backend.setItem(storageKey, JSON.stringify(data));
      } catch {
        // 写入失败（隐私模式 / 配额满）：静默降级，不影响任务判定
      }
    },
    clear() {
      try {
        backend.removeItem(storageKey);
      } catch {
        // 同上
      }
    },
  };
}
