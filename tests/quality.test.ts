/**
 * 画质档位（低配模式）纯逻辑测试：档位切换 / 持久化读写与容错 /
 * 自动降档判定（预热期、只降不升、阈值边界）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPersistedQuality,
  persistQuality,
  toggleQuality,
} from '../src/ui/logic/quality';
import {
  AUTO_DOWNGRADE_FRAME_MS,
  AUTO_DOWNGRADE_WARMUP_S,
  shouldAutoDowngrade,
} from '../src/render/logic/quality';

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const g = globalThis as { localStorage?: Store | undefined };

function installMock(store: Record<string, string> | null): void {
  g.localStorage = store
    ? {
        getItem: (k) => (k in store ? store[k]! : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
      }
    : undefined;
}

afterEach(() => {
  installMock(null);
});

describe('ui/logic/quality：持久化与切换', () => {
  it('toggleQuality 在 high/low 间取反', () => {
    expect(toggleQuality('high')).toBe('low');
    expect(toggleQuality('low')).toBe('high');
  });

  it('persistQuality 写入后 readPersistedQuality 读回', () => {
    installMock({});
    expect(readPersistedQuality()).toBeNull();
    persistQuality('low');
    expect(readPersistedQuality()).toBe('low');
    persistQuality('high');
    expect(readPersistedQuality()).toBe('high');
  });

  it('无 localStorage / 值非法 / 抛异常时读侧静默返回 null', () => {
    installMock(null); // 无 localStorage
    expect(readPersistedQuality()).toBeNull();
    installMock({});
    g.localStorage!.setItem('wave-quality-level', 'ultra'); // 非法值
    expect(readPersistedQuality()).toBeNull();
    const throwing = g.localStorage as unknown as { getItem: () => string };
    throwing.getItem = () => {
      throw new Error('隐私模式');
    };
    expect(readPersistedQuality()).toBeNull();
  });

  it('persistQuality 在存储抛异常时不外溢', () => {
    installMock({});
    const throwing = g.localStorage as unknown as { setItem: () => void };
    throwing.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    expect(() => persistQuality('low')).not.toThrow();
  });
});

describe('render/logic/quality：自动降档判定', () => {
  it('高画质 + 未降过 + 过预热期 + 平均帧时长超阈值 → 降档', () => {
    expect(shouldAutoDowngrade(AUTO_DOWNGRADE_FRAME_MS + 1, 'high', false, AUTO_DOWNGRADE_WARMUP_S + 1)).toBe(true);
  });

  it('阈值边界：等于阈值不降（须严格超过）', () => {
    expect(shouldAutoDowngrade(AUTO_DOWNGRADE_FRAME_MS, 'high', false, 10)).toBe(false);
  });

  it('预热期内不判定', () => {
    expect(shouldAutoDowngrade(AUTO_DOWNGRADE_FRAME_MS + 10, 'high', false, AUTO_DOWNGRADE_WARMUP_S)).toBe(false);
  });

  it('已自动降过不再触发（只降不升，防抖动）', () => {
    expect(shouldAutoDowngrade(60, 'high', true, 10)).toBe(false);
  });

  it('低画质档永不触发', () => {
    expect(shouldAutoDowngrade(60, 'low', false, 10)).toBe(false);
  });
});
