/**
 * 实验引擎：参数落库 + store 事件 + 物理生效的唯一通道。
 * 实现 SPEC §6.2 / §8 参数变更流（顺序强制）：
 *   store.setState({params}) → emit(PARAMS_CHANGED) → waveField.configure
 * 并承接外部直写 store 的路径（UI 按 §8 闭环 emit PARAMS_CHANGED 时，
 * 由 handleParamsChanged 完成 clamp 校验与 configure —— 写物理入口仍唯一）。
 * 约束遵守：事件回调内不再重发同名事件（无同帧事件环）；
 * configure 幂等（签名去重），同参数不重复重建分量。
 */
import { STORE_EVENTS } from '../core/constants';
import type { Store } from '../core/store';
import type { ExperimentId, SimParams, SimState } from '../core/types';
import type { WaveField } from '../physics/waveField';
import { applyPatch, paramsEqual } from './params';
import type { ExperimentEngine } from './types';

export interface ExperimentEngineDeps {
  store: Store<SimState>;
  waveField: WaveField;
}

export interface ExperimentEngineRuntime extends ExperimentEngine {
  /** 退订事件（dispose 用） */
  dispose(): void;
}

export function createExperimentEngine(
  deps: ExperimentEngineDeps,
): ExperimentEngineRuntime {
  const { store, waveField } = deps;

  let lastSignature = '';
  const signature = (experiment: ExperimentId, params: SimParams): string =>
    `${experiment}|${JSON.stringify(params)}`;

  /** 幂等 configure：实验 + 参数签名未变则跳过重复重建 */
  const configure = (experiment: ExperimentId, params: SimParams): void => {
    const sig = signature(experiment, params);
    if (sig === lastSignature) return;
    lastSignature = sig;
    waveField.configure(experiment, params);
  };

  const commit = (experiment: ExperimentId, params: SimParams): void => {
    store.setState({ params });
    store.emit(STORE_EVENTS.PARAMS_CHANGED, { experiment, params });
    configure(experiment, params);
  };

  const reconfigure = (experiment: ExperimentId, params: SimParams): void => {
    lastSignature = signature(experiment, params);
    waveField.configure(experiment, params);
  };

  const select = (experiment: ExperimentId): void => {
    store.setState({ experiment });
    store.emit(STORE_EVENTS.EXPERIMENT_CHANGED, { experiment });
  };

  /**
   * 外部直写路径：任何人按 §8 闭环 setState({params}) + emit(PARAMS_CHANGED) 后，
   * 在此完成 clamp 校验（越界时静默修正 store，不重发事件）并 configure。
   */
  const handleParamsChanged = (): void => {
    const { experiment, params } = store.getState();
    const next = applyPatch(params, params);
    if (!paramsEqual(next, params)) {
      store.setState({ params: next });
    }
    configure(experiment, next);
  };

  const offParamsChanged = store.on(STORE_EVENTS.PARAMS_CHANGED, () =>
    handleParamsChanged(),
  );

  return {
    commit,
    configure,
    reconfigure,
    select,
    dispose: offParamsChanged,
  };
}
