/**
 * 实验三 · 不规则随机海况控制器（PM / JONSWAP 谱驱动）。
 *
 * 物理驱动参数 = 风速 U + 风区 F（SPEC §9.3 与 SimParams.spectrum 契约字段），
 * Hs / Tp 作为观测量（observables）实时从 waveField 读取 —— 学生在
 * 未知海况模式下用仪器测量它们并与理论值对比（任务六）。
 *
 * randomSeaState(seed)：任务六配套，按种子重摆随机海况；同种子 ⇒ 同一海况
 * （physics rngFactory 确定性保证），可复现、可评分。
 * mystery（真值隐藏开关）状态存放于 store.params.spectrum.mystery，
 * UI / 仪器据此隐藏理论海况面板，物理计算不受影响。
 */
import type { ExperimentControllerDeps } from './types';
import type { SpectrumExperimentController } from './types';
import { SPECTRUM_PARAM_SCHEMA, EXPERIMENT_LABELS } from './schema';
import { makeSetParam, makeResetParams } from './params';

export function createSpectrumExperiment(
  deps: ExperimentControllerDeps,
): SpectrumExperimentController {
  const { store, waveField, engine } = deps;
  const setParam = makeSetParam('spectrum', store, engine);
  const resetParams = makeResetParams('spectrum', store, engine);
  let elapsedSinceActivate = 0;

  return {
    id: 'spectrum',
    label: EXPERIMENT_LABELS.spectrum,
    paramSchema: SPECTRUM_PARAM_SCHEMA,

    activate() {
      elapsedSinceActivate = 0;
      engine.configure('spectrum', store.getState().params);
    },

    deactivate() {
      // 无逐帧资源需要释放
    },

    setParam,

    update(dt) {
      if (dt > 0) elapsedSinceActivate += dt;
    },

    observables() {
      const p = store.getState().params.spectrum;
      const sea = waveField.observedSeaState();
      return {
        kind: p.kind,
        mystery: p.mystery,
        hs: sea.hs,
        tp: sea.tp,
        peakFrequency: sea.peakFrequency,
        wavelength: sea.wavelength,
        whitecapIntensity: waveField.whitecapIntensity(),
        elapsedSinceActivate,
      };
    },

    resetParams,

    randomSeaState(seed: number) {
      if (!Number.isFinite(seed)) return;
      setParam('randomSeed', Math.max(0, Math.round(seed)));
    },
  };
}
