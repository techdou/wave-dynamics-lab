/**
 * createInstruments —— docs/SPEC.md §7.4（归仪器工程师）。
 * 契约签名与骨架阶段一致；实现承载在 src/instruments/runtime.ts（同目录实现层），
 * 本文件仅做薄委托，保持集成调用方式不变。
 * 禁止 import 本模块以外的 feature 模块（core/physics 类型除外）。
 */
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type { InstrumentKind, SimState } from '../core/types';
import type { WaveField } from '../physics/waveField';
import { createInstrumentsRuntime } from './runtime';

export interface InstrumentsDeps {
  /** 仪器面板挂载容器（右栏内，由集成工程师注入） */
  root: HTMLElement;
  store: Store<SimState>;
  waveField: WaveField;
  clock: SimClock;
}

export interface Instruments {
  mount(): void;
  /** 记录一次当前仪器读数：追加 MeasurementRecord + emit(MEASUREMENT_ADDED) */
  record(values: Record<string, number>, note?: string): void;
  /** 切换激活仪器（null = 关闭），写 store.activeInstrument + emit(INSTRUMENT_CHANGED) */
  setActive(kind: InstrumentKind | null): void;
  /** 读取理论海况（对答案显示，mystery 模式下由调用方决定是否隐藏） */
  getTheoreticalSeaState(): { hs: number; tp: number; wavelength: number };
  dispose(): void;
}

export function createInstruments(deps: InstrumentsDeps): Instruments {
  const runtime = createInstrumentsRuntime(deps);
  return {
    mount: () => runtime.mount(),
    record: (values, note) => runtime.record(values, note),
    setActive: (kind) => runtime.setActive(kind),
    getTheoreticalSeaState: () => runtime.getTheoreticalSeaState(),
    dispose: () => runtime.dispose(),
  };
}
