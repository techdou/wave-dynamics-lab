/**
 * 实验二 · 双造波机叠加控制器。
 * H₁/H₂、T₁/T₂、θ₁/θ₂、φ₁/φ₂ 全部独立可调（深水色散，物理即双分量叠加）。
 * 只提供『恢复默认』（resetParams），不提供相长/相消/拍/格状的答案预设 ——
 * 解谜过程是任务二~五的教学目标，预设会直接泄露答案。
 */
import type { ExperimentControllerDeps } from './types';
import type { InterferenceExperimentController } from './types';
import { INTERFERENCE_PARAM_SCHEMA, EXPERIMENT_LABELS } from './schema';
import { interferenceScalars } from './interferenceMath';
import { makeSetParam, makeResetParams } from './params';

export function createInterferenceExperiment(
  deps: ExperimentControllerDeps,
): InterferenceExperimentController {
  const { store, waveField, engine } = deps;
  const setParam = makeSetParam('interference', store, engine);
  const resetParams = makeResetParams('interference', store, engine);
  let elapsedSinceActivate = 0;

  return {
    id: 'interference',
    label: EXPERIMENT_LABELS.interference,
    paramSchema: INTERFERENCE_PARAM_SCHEMA,

    activate() {
      elapsedSinceActivate = 0;
      engine.configure('interference', store.getState().params);
    },

    deactivate() {
      // 无逐帧资源需要释放
    },

    setParam,

    update(dt) {
      if (dt > 0) elapsedSinceActivate += dt;
    },

    observables() {
      const p = store.getState().params.interference;
      const sea = waveField.observedSeaState();
      const s = interferenceScalars(p);
      return {
        amplitudeA: p.makerA.amplitude / 2, // 物理振幅 = H/2
        amplitudeB: p.makerB.amplitude / 2,
        phaseDiffDeg: s.phaseDiffDeg,
        angleDiffDeg: s.angleDiffDeg,
        relativePeriodDiff: s.relativePeriodDiff,
        inBeatingBand: s.inBeatingBand,
        beatPeriod: s.beatPeriod,
        maxAmp: s.maxAmp,
        minAmp: s.minAmp,
        whitecapIntensity: waveField.whitecapIntensity(),
        hs: sea.hs,
        tp: sea.tp,
        wavelength: sea.wavelength,
        elapsedSinceActivate,
      };
    },

    resetParams,
  };
}
