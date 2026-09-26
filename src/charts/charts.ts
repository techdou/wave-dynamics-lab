/**
 * createCharts —— docs/SPEC.md §7.3（归可视化工程师）。
 * 契约签名与骨架阶段一致；实现承载在 src/viz/（同属可视化工程师的图表实现层），
 * 本文件仅做薄委托，保持 SPEC §3 的目录归属与集成调用方式不变。
 * 禁止 import 本模块以外的 feature 模块（core/physics 类型除外）。
 */
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type { SimState } from '../core/types';
import type { WaveField } from '../physics/waveField';
import { createChartsRuntime } from '../viz/chartsImpl';

export interface ChartsDeps {
  /** 图表挂载容器（由集成工程师从 ui.getSlots() 取得后注入） */
  root: HTMLElement;
  store: Store<SimState>;
  waveField: WaveField;
  clock: SimClock;
  /** η(t) 采样的历史窗口长度（仿真秒），默认 60 */
  timeWindowSeconds?: number;
}

export interface Charts {
  /** 在 root 内创建两张图：η(t) 时间序列 + S(f) 能谱（实验一/二隐藏谱图） */
  mount(): void;
  /** 刷新两图（常规刷新由 clock.onStep 以 20Hz 驱动；本方法供手动强制刷新） */
  update(): void;
  dispose(): void;
}

export function createCharts(deps: ChartsDeps): Charts {
  return createChartsRuntime(deps);
}
