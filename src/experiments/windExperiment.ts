/**
 * 实验一 · 风浪生成机制控制器。
 * 参数（风速 / 风时 / 风向）经 engine.commit 写入 store 与 physics，
 * 一帧内生效；发展状态分类接 SPEC §9.1 形态连续谱，供 UI 与任务判定。
 *
 * update(dt)：维护"激活后累计仿真时间"（真实计时，用于观测面板）；
 * 风时随仿真时间自动累积的模式按 SPEC §9.1 约定待规格补充后另行实现，
 * 当前风时为滑块直读语义（30 min 达成熟，与 physics 成长模型一致）。
 */
import type { ExperimentControllerDeps } from './types';
import type { WindExperimentController } from './types';
import { WIND_PARAM_SCHEMA, EXPERIMENT_LABELS } from './schema';
import { classifyWindDevelopment, WIND_DEVELOPMENT_LABELS } from './windState';
import { makeSetParam, makeResetParams } from './params';

export function createWindExperiment(
  deps: ExperimentControllerDeps,
): WindExperimentController {
  const { store, waveField, engine } = deps;
  const setParam = makeSetParam('wind', store, engine);
  const resetParams = makeResetParams('wind', store, engine);
  let elapsedSinceActivate = 0;

  return {
    id: 'wind',
    label: EXPERIMENT_LABELS.wind,
    paramSchema: WIND_PARAM_SCHEMA,

    activate() {
      elapsedSinceActivate = 0;
      engine.configure('wind', store.getState().params);
    },

    deactivate() {
      // 无逐帧资源需要释放；实验切换编排由 createExperiments 统一负责
    },

    setParam,

    update(dt) {
      if (dt > 0) elapsedSinceActivate += dt;
    },

    observables() {
      const wind = store.getState().params.wind;
      const sea = waveField.observedSeaState();
      const state = classifyWindDevelopment(wind);
      return {
        developmentState: state,
        developmentLabel: WIND_DEVELOPMENT_LABELS[state],
        whitecapIntensity: waveField.whitecapIntensity(),
        hs: sea.hs,
        tp: sea.tp,
        peakFrequency: sea.peakFrequency,
        wavelength: sea.wavelength,
        elapsedSinceActivate,
      };
    },

    resetParams,
  };
}
