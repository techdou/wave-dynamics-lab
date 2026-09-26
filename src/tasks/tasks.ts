/**
 * 科研任务系统 —— docs/SPEC.md §7.5 六任务判定 + 完整探究闭环
 * （目标 → 填预测 → 实验操作 → 测量 → 提交结果 → 判定反馈 → 知识总结）。
 *
 * 判定数据来源（不读任何 UI 状态）：
 *  - store.measurements：仪器测量记录（按"目标态参数指纹"过滤陈旧记录——参数一变，旧测量即过期）；
 *  - physics 数据接口：waveField.whitecapIntensity()、observedSeaState()（均恒读目标态）；
 *  - store.params：双造波机参数（configure 的输入=渲染波场的目标态）、风速区间 / mystery 开关。
 *
 * 【相对契约骨架的增量（均为向后兼容的可选扩展，原有签名未动）】
 *  - TasksDeps 新增可选字段 clock?（固定步长仿真时钟，用于观测时长防误触判定；
 *    缺省时按 evaluate() 调用间隔的真实时间近似累计，暂停时不累计）
 *    与 storage?（持久化后端注入，缺省探测 localStorage，失败退化内存）。
 *  - Tasks 新增 setPrediction / submitResult / getTaskDetail / requestMysteryReroll，
 *    承载探究闭环交互；evaluate / reset / getProgress / dispose 签名与语义不变。
 *  - 完成时 emit TASK_EVENTS.COMPLETED（AI 总结与 TTS 的钩子），判定时 emit TASK_EVENTS.JUDGED。
 */
import { STORE_EVENTS } from '../core/constants';
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type {
  MeasurementRecord,
  SimState,
  TaskId,
  TaskProgress,
  WaveMakerParams,
} from '../core/types';
import type { WaveField } from '../physics/waveField';
import {
  GRID_PATTERN_HEURISTIC,
  circularDiffDeg,
  judgeBeating,
  judgeGridPattern,
  judgeMaxAmplitude,
  judgeUnknownSea,
  judgeWhitecap,
  judgeZeroAmplitude,
  relativeDiff,
  type JudgeCheck,
  type TaskJudgment,
} from './judges';
import {
  createTaskPersistence,
  type KeyValueStore,
  type TaskPersistence,
} from './persistence';
import { TASK_EVENTS, type TaskJudgedPayload } from './taskEvents';
import { TASK_META, TASK_ORDER, TASK_THRESHOLDS, type UnknownSeaOutcome } from './taskDefs';

export interface TasksDeps {
  store: Store<SimState>;
  waveField: WaveField;
  /**
   * 可选：固定步长仿真时钟。注入后以仿真时间精确累计"条件稳定保持时长"（防误触）；
   * 缺省时按 evaluate() 调用间隔的真实时间近似累计（暂停不累计，倍速下不精确）。
   */
  clock?: SimClock;
  /** 可选：进度持久化后端（缺省探测 localStorage，隐私模式自动退化内存） */
  storage?: KeyValueStore | null;
}

export interface Tasks {
  /** 评估全部任务完成条件（每个固定仿真步或测量变更后调用），变更时写 store.tasks + emit(TASKS_UPDATED) */
  evaluate(): void;
  /** 手动重置全部任务进度（清空预测、提交与持久化） */
  reset(): void;
  /** 查询指定任务当前进度（供左栏任务卡 / 顶栏进度点渲染） */
  getProgress(taskId: TaskId): { done: boolean; progress: number };
  dispose(): void;

  // ---- 以下为探究闭环增量 API（向后兼容扩展） ----

  /** 记录学生预测（探究闭环第一步；未填预测不允许提交结果） */
  setPrediction(taskId: TaskId, text: string): void;
  /**
   * 提交结果并触发系统判定：同步返回判定明细；
   * 通过时置 done=1 并 emit TASK_EVENTS.COMPLETED（AI 总结 / TTS 钩子）。
   * 任务六需传 { hs, tp } 估计值。
   */
  submitResult(
    taskId: TaskId,
    payload?: { hs: number; tp: number },
  ): SubmitOutcome;
  /** 任务卡详情（目标/预测/实时判定项/反馈/知识总结/任务六真值表），供 UI 渲染 */
  getTaskDetail(taskId: TaskId): TaskDetail;
  /** 请求实验层随机化一个未知海况（emit TASK_EVENTS.MYSTERY_REROLL；实验层可选实现） */
  requestMysteryReroll(): void;
}

export interface SubmitOutcome {
  taskId: TaskId;
  passed: boolean;
  /** 已通过后再提交：不重复判定，直接返回通过结论 */
  alreadyCompleted: boolean;
  feedback: string;
  checks: JudgeCheck[];
  metrics: Record<string, number>;
}

export type TaskStatus = 'idle' | 'ready' | 'passed';

export interface TaskDetail {
  taskId: TaskId;
  title: string;
  status: TaskStatus;
  progress: number;
  goal: string;
  predictionPrompt: string;
  prediction: string;
  /** 实时判定项（提交前也可见，作为过程引导） */
  checks: JudgeCheck[];
  metrics: Record<string, number>;
  observedSeconds: number;
  requiredObservedSeconds: number;
  submitCount: number;
  lastFeedback: string | null;
  /** 仅通过后展示的知识总结 */
  knowledge: string | null;
  /** 启发式判定说明（仅任务五非空，UI 必须向学生注明） */
  heuristicNote: string | null;
  /** 任务六真值/估值/误差表数据；仅通过后含真值，未通过前为 null */
  unknownSeaOutcome: UnknownSeaOutcome | null;
  /** 任务六为 true：提交时需携带 { hs, tp } 估计值 */
  needsEstimatePayload: boolean;
}

interface TaskSession {
  prediction: string;
  submitCount: number;
  completed: boolean;
  completedAtSimTime: number | null;
  lastFeedback: string | null;
  unknownSeaOutcome: UnknownSeaOutcome | null;
}

function freshSession(): TaskSession {
  return {
    prediction: '',
    submitCount: 0,
    completed: false,
    completedAtSimTime: null,
    lastFeedback: null,
    unknownSeaOutcome: null,
  };
}

/** 显示用进度：5% 粒度（进度条/任务点仅按整数百分比呈现），避免高频刷 store */
function roundedProgress(p: number): number {
  return Math.round(p * 20) / 20;
}

export function createTasks(deps: TasksDeps): Tasks {
  const { store, waveField } = deps;
  const clock = deps.clock ?? null;
  const persistence: TaskPersistence = createTaskPersistence(deps.storage);

  const sessions: Record<TaskId, TaskSession> = Object.fromEntries(
    TASK_ORDER.map((id) => [id, freshSession()]),
  ) as Record<TaskId, TaskSession>;
  /** 各任务"条件稳定保持"的仿真秒数（防误触观测时长） */
  const trackers: Record<TaskId, number> = Object.fromEntries(
    TASK_ORDER.map((id) => [id, 0]),
  ) as Record<TaskId, number>;

  /** 当前波场分量指纹：参数（分量）一变即更换，用于测量新鲜度与观测累计重置 */
  let cachedFingerprint = '';
  /** 测量记录 id → 记录产生时的波场指纹 */
  const stamps = new Map<string, string>();
  let lastSimTime: number | null = null;
  let lastWallTime: number | null = null;
  const unsubscribes: Array<() => void> = [];

  // ---------- 波场指纹与双波参数（目标态） ----------

  /**
   * 波场指纹：以 store 参数为目标态依据。
   * physics 层 configure 的目标完全由 (experiment, params) 决定；且 components()
   * 带 ≤7 s 平滑过渡（显示分量渐变，src/physics/MODELS.md §2），不能作为稳定性依据；
   * 理论读数（whitecapIntensity/observedSeaState）恒为目标态。
   */
  function fieldFingerprint(): string {
    const state = store.getState();
    const w = state.params.wind;
    const it = state.params.interference;
    const sp = state.params.spectrum;
    return [
      state.experiment,
      w.windSpeed,
      w.windDuration,
      w.windDirection,
      it.makerA.amplitude,
      it.makerA.period,
      it.makerA.angle,
      it.makerA.phase,
      it.makerB.amplitude,
      it.makerB.period,
      it.makerB.angle,
      it.makerB.phase,
      sp.kind,
      sp.windSpeed,
      sp.fetch,
      sp.randomSeed,
      sp.peakEnhancement,
      sp.mystery,
    ].join('|');
  }

  /**
   * 双造波机参数（目标态）：读取 store 参数——它是 waveField.configure 的输入，
   * 即渲染波场的最终目标；过渡期间 components() 的显示振幅不可用。
   */
  function makersFromParams(): { A: WaveMakerParams; B: WaveMakerParams } | null {
    const state = store.getState();
    if (state.experiment !== 'interference') return null;
    return { A: state.params.interference.makerA, B: state.params.interference.makerB };
  }

  // ---------- 观测条件（防误触：条件成立才累计时长） ----------

  function conditionActive(id: TaskId): boolean {
    const state = store.getState();
    switch (id) {
      case 'whitecap': {
        if (state.experiment !== 'wind') return false;
        const u = state.params.wind.windSpeed;
        return (
          u >= TASK_THRESHOLDS.whitecap.minWindSpeed &&
          u <= TASK_THRESHOLDS.whitecap.maxWindSpeed &&
          waveField.whitecapIntensity() >= TASK_THRESHOLDS.whitecap.minIntensity
        );
      }
      case 'max-amplitude':
      case 'zero-amplitude':
      case 'beating':
      case 'grid-pattern': {
        const makers = makersFromParams();
        if (!makers) return false;
        const { A, B } = makers;
        switch (id) {
          case 'max-amplitude':
            return (
              relativeDiff(A.period, B.period) <= TASK_THRESHOLDS["max-amplitude"].periodRelTol &&
              circularDiffDeg(A.angle, B.angle) <= TASK_THRESHOLDS["max-amplitude"].angleTolDeg
            );
          case 'zero-amplitude': {
            const maxAmp = Math.max(A.amplitude, B.amplitude);
            return (
              relativeDiff(A.period, B.period) <= TASK_THRESHOLDS["zero-amplitude"].periodRelTol &&
              maxAmp > 0 &&
              Math.abs(A.amplitude - B.amplitude) / maxAmp <=
                TASK_THRESHOLDS["zero-amplitude"].amplitudeRelTol &&
              Math.abs(circularDiffDeg(A.phase, B.phase) - 180) <=
                TASK_THRESHOLDS["zero-amplitude"].phaseTolDeg
            );
          }
          case 'beating': {
            const detune = relativeDiff(A.period, B.period);
            const aA = A.amplitude / 2;
            const aB = B.amplitude / 2;
            const contrast =
              Math.abs(aA - aB) > 0 ? (aA + aB) / Math.abs(aA - aB) : Number.POSITIVE_INFINITY;
            return (
              detune >= TASK_THRESHOLDS.beating.detuneMin &&
              detune <= TASK_THRESHOLDS.beating.detuneMax &&
              contrast >= TASK_THRESHOLDS.beating.envelopeContrastMin
            );
          }
          case 'grid-pattern': {
            const angleDiff = circularDiffDeg(A.angle, B.angle);
            const maxAmp = Math.max(A.amplitude, B.amplitude);
            const minAmp = Math.min(A.amplitude, B.amplitude);
            return (
              angleDiff >= TASK_THRESHOLDS["grid-pattern"].angleMinDeg &&
              angleDiff <= TASK_THRESHOLDS["grid-pattern"].angleMaxDeg &&
              maxAmp > 0 &&
              minAmp / maxAmp >= TASK_THRESHOLDS["grid-pattern"].visibilityRatio
            );
          }
          default:
            return false;
        }
      }
      case 'unknown-sea':
        return state.experiment === 'spectrum' && state.params.spectrum.mystery;
      default:
        return false;
    }
  }

  function resetTrackers(): void {
    for (const id of TASK_ORDER) trackers[id] = 0;
  }

  function stepTrackers(dtSeconds: number): void {
    for (const id of TASK_ORDER) {
      trackers[id] = conditionActive(id) ? trackers[id] + dtSeconds : 0;
    }
  }

  // ---------- 测量新鲜度：新记录按当前波场指纹打戳 ----------

  unsubscribes.push(
    store.subscribe((state, prev) => {
      if (state.measurements === prev.measurements) return;
      if (state.measurements.length < prev.measurements.length) {
        // 记录被清空/收缩（实验重置）：丢弃失效戳
        const alive = new Set(state.measurements.map((r) => r.id));
        for (const id of [...stamps.keys()]) {
          if (!alive.has(id)) stamps.delete(id);
        }
        return;
      }
      for (let i = prev.measurements.length; i < state.measurements.length; i++) {
        const rec = state.measurements[i];
        if (rec) stamps.set(rec.id, cachedFingerprint);
      }
    }),
  );

  function freshRecords(tool?: SimState['measurements'][number]['tool']): MeasurementRecord[] {
    return store
      .getState()
      .measurements.filter((r) => stamps.get(r.id) === cachedFingerprint && (!tool || r.tool === tool));
  }

  // ---------- 时钟接线：仿真步驱动观测累计 ----------

  if (clock) {
    unsubscribes.push(
      clock.onStep((simTime) => {
        const dt = lastSimTime === null ? clock.stepSeconds : simTime - lastSimTime;
        lastSimTime = simTime;
        if (dt <= 0) {
          resetTrackers(); // 时钟被重置：本轮观测作废
          return;
        }
        stepTrackers(dt);
      }),
    );
  }

  // ---------- 判定入口 ----------

  function coreJudge(id: TaskId, payload?: { hs: number; tp: number }): TaskJudgment {
    switch (id) {
      case 'whitecap': {
        const state = store.getState();
        return judgeWhitecap({
          experiment: state.experiment,
          windSpeed: state.params.wind.windSpeed,
          whitecapIntensity: waveField.whitecapIntensity(),
          sustainedSeconds: trackers.whitecap,
          freshRulerCount: freshRecords('wave-ruler').length,
        });
      }
      case 'max-amplitude':
      case 'zero-amplitude': {
        const makers = makersFromParams();
        if (!makers) {
          return {
            passed: false,
            checks: [
              {
                id: 'field',
                label: '需要实验二的双造波机波场',
                ok: false,
                detail: '当前波场不是双波叠加，请切换到实验二',
              },
            ],
            metrics: {},
          };
        }
        const base = {
          makerA: makers.A,
          makerB: makers.B,
          sustainedSeconds: trackers[id],
          rulerRecords: freshRecords('wave-ruler'),
        };
        return id === 'max-amplitude' ? judgeMaxAmplitude(base) : judgeZeroAmplitude(base);
      }
      case 'beating': {
        const makers = makersFromParams();
        if (!makers) {
          return {
            passed: false,
            checks: [
              {
                id: 'field',
                label: '需要实验二的双造波机波场',
                ok: false,
                detail: '当前波场不是双波叠加，请切换到实验二',
              },
            ],
            metrics: {},
          };
        }
        return judgeBeating({
          makerA: makers.A,
          makerB: makers.B,
          sustainedSeconds: trackers.beating,
          stopwatchRecords: freshRecords('stopwatch'),
        });
      }
      case 'grid-pattern': {
        const makers = makersFromParams();
        if (!makers) {
          return {
            passed: false,
            checks: [
              {
                id: 'field',
                label: '需要实验二的双造波机波场',
                ok: false,
                detail: '当前波场不是双波叠加，请切换到实验二',
              },
            ],
            metrics: {},
          };
        }
        return judgeGridPattern({
          makerA: makers.A,
          makerB: makers.B,
          sustainedSeconds: trackers['grid-pattern'],
        });
      }
      case 'unknown-sea': {
        const state = store.getState();
        const truth = waveField.observedSeaState();
        const estimate =
          payload &&
          Number.isFinite(payload.hs) &&
          Number.isFinite(payload.tp) &&
          payload.hs > 0 &&
          payload.tp > 0
            ? { hs: payload.hs, tp: payload.tp }
            : null;
        return judgeUnknownSea({
          mysteryActive: state.experiment === 'spectrum' && state.params.spectrum.mystery,
          truthHs: truth.hs,
          truthTp: truth.tp,
          estimate,
          freshRulerCount: freshRecords('wave-ruler').length,
          freshStopwatchCount: freshRecords('stopwatch').length,
        });
      }
      default:
        return { passed: false, checks: [], metrics: {} };
    }
  }

  function judgeWithPredictionGuard(
    id: TaskId,
    payload?: { hs: number; tp: number },
  ): TaskJudgment {
    const predictionOk = sessions[id].prediction.length > 0;
    const predictionCheck: JudgeCheck = {
      id: 'prediction',
      label: '已填写预测',
      ok: predictionOk,
      detail: predictionOk ? '预测已记录' : '请先在任务卡填写预测，再提交结果',
    };
    const core = coreJudge(id, payload);
    return {
      passed: predictionOk && core.passed,
      checks: [predictionCheck, ...core.checks],
      metrics: core.metrics,
    };
  }

  // ---------- store.tasks 同步（tasks 字段唯此模块可写） ----------

  function liveChecks(id: TaskId): TaskJudgment {
    return judgeWithPredictionGuard(id, undefined);
  }

  function liveProgress(id: TaskId): number {
    if (!sessions[id]) return 0;
    if (sessions[id].completed) return 1;
    const observed = trackers[id];
    switch (id) {
      case 'whitecap':
      case 'max-amplitude':
      case 'zero-amplitude':
      case 'beating':
      case 'grid-pattern': {
        const required = TASK_THRESHOLDS[id].sustainedSeconds;
        const evidenceReady =
          id === 'grid-pattern'
            ? false
            : id === 'whitecap'
              ? freshRecords('wave-ruler').length > 0
              : id === 'beating'
                ? freshRecords('stopwatch').length > 0
                : freshRecords('wave-ruler').length > 0;
        const p = Math.max((observed / required) * 0.7, evidenceReady ? 0.4 : 0);
        return roundedProgress(Math.min(p, 0.95));
      }
      case 'unknown-sea': {
        const state = store.getState();
        const active = state.experiment === 'spectrum' && state.params.spectrum.mystery;
        const hasEvidence =
          freshRecords('wave-ruler').length > 0 && freshRecords('stopwatch').length > 0;
        return roundedProgress(Math.min((active ? 0.2 : 0) + (hasEvidence ? 0.3 : 0), 0.95));
      }
      default:
        return 0;
    }
  }

  function buildTaskProgress(current: readonly TaskProgress[]): TaskProgress[] {
    return current.map((t) => {
      const session = sessions[t.taskId];
      if (!session) return t;
      const done = session.completed;
      const progress = done ? 1 : liveProgress(t.taskId);
      if (t.done === done && t.progress === progress) return t;
      return { ...t, done, progress };
    });
  }

  function flushTasksToStore(force: boolean): void {
    const state = store.getState();
    const next = buildTaskProgress(state.tasks);
    const changed = next.some((t, i) => t !== state.tasks[i]);
    if (!changed && !force) return;
    store.setState({ tasks: next });
    store.emit(STORE_EVENTS.TASKS_UPDATED, next);
  }

  // ---------- 持久化 ----------

  function persistAll(): void {
    const tasks: Partial<Record<TaskId, ReturnType<typeof serializeSession>>> = {};
    for (const id of TASK_ORDER) tasks[id] = serializeSession(id);
    persistence.save({ version: 1, savedAtWallClock: Date.now(), tasks });
  }

  // 持久化节流：input 事件逐击键触发 setPrediction，localStorage 同步写
  // 不宜每键一次；合并为 250ms 一次，页面存活期间文本始终在内存中。
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistSoon(): void {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistAll();
    }, 250);
  }

  function serializeSession(id: TaskId) {
    const s = sessions[id];
    return {
      done: s.completed,
      prediction: s.prediction,
      submitCount: s.submitCount,
      completedAtSimTime: s.completedAtSimTime,
      lastFeedback: s.lastFeedback,
      unknownSeaOutcome: s.unknownSeaOutcome,
    };
  }

  function restoreFromPersistence(): void {
    const saved = persistence.load();
    if (!saved) return;
    for (const id of TASK_ORDER) {
      const savedState = saved.tasks[id];
      if (!savedState) continue;
      const session = sessions[id];
      session.prediction = typeof savedState.prediction === 'string' ? savedState.prediction : '';
      session.completed = savedState.done === true;
      session.submitCount = typeof savedState.submitCount === 'number' ? savedState.submitCount : 0;
      session.completedAtSimTime =
        typeof savedState.completedAtSimTime === 'number' ? savedState.completedAtSimTime : null;
      session.lastFeedback =
        typeof savedState.lastFeedback === 'string' ? savedState.lastFeedback : null;
      session.unknownSeaOutcome = savedState.unknownSeaOutcome ?? null;
    }
  }

  // ---------- 探究闭环 API ----------

  function setPrediction(taskId: TaskId, text: string): void {
    const session = sessions[taskId];
    if (!session || session.completed) return;
    session.prediction = text.trim();
    persistSoon();
    store.emit(TASK_EVENTS.PREDICTION_SET, {
      taskId,
      prediction: session.prediction,
      simTime: clock ? clock.time() : null,
    });
    flushTasksToStore(false);
  }

  function submitResult(
    taskId: TaskId,
    payload?: { hs: number; tp: number },
  ): SubmitOutcome {
    const session = sessions[taskId];
    if (!session) {
      return {
        taskId,
        passed: false,
        alreadyCompleted: false,
        feedback: '未知任务',
        checks: [],
        metrics: {},
      };
    }
    const simTime = clock ? clock.time() : null;
    if (session.completed) {
      const live = liveChecks(taskId);
      return {
        taskId,
        passed: true,
        alreadyCompleted: true,
        feedback: session.lastFeedback ?? '任务已完成',
        checks: live.checks,
        metrics: live.metrics,
      };
    }

    const judgment = judgeWithPredictionGuard(taskId, payload);
    session.submitCount += 1;

    // 任务六：任何一次有效提交都记录真值/估值/误差（真值仅在通过后对外展示）
    if (taskId === 'unknown-sea' && judgment.metrics.hsErrorPct !== undefined) {
      const truth = waveField.observedSeaState();
      session.unknownSeaOutcome = {
        truthHs: truth.hs,
        truthTp: truth.tp,
        estimateHs: payload?.hs ?? Number.NaN,
        estimateTp: payload?.tp ?? Number.NaN,
        hsErrorPct: judgment.metrics.hsErrorPct ?? -1,
        tpErrorPct: judgment.metrics.tpErrorPct ?? -1,
        passed: judgment.passed,
      };
    }

    const meta = TASK_META[taskId];
    const judgedPayload: TaskJudgedPayload = {
      taskId,
      passed: judgment.passed,
      feedback: '',
      submitCount: session.submitCount,
      simTime,
      metrics: judgment.metrics,
      ...(taskId === 'unknown-sea' && session.unknownSeaOutcome
        ? { unknownSea: session.unknownSeaOutcome }
        : {}),
    };
    let feedback: string;
    if (judgment.passed) {
      session.completed = true;
      session.completedAtSimTime = simTime;
      feedback = '判定通过。';
      judgedPayload.feedback = feedback;
      store.emit(TASK_EVENTS.JUDGED, judgedPayload);
      store.emit(TASK_EVENTS.COMPLETED, {
        taskId,
        title: titleOf(taskId),
        summary: meta.knowledge,
        speech: `${titleOf(taskId)}，判定通过。${meta.knowledge}`,
        simTime,
      });
    } else {
      const failed = judgment.checks.filter((c) => !c.ok).map((c) => c.label).join('；');
      feedback = `未通过——${failed}`;
      judgedPayload.feedback = feedback;
      store.emit(TASK_EVENTS.JUDGED, judgedPayload);
    }
    session.lastFeedback = feedback;
    persistAll();
    flushTasksToStore(false);
    return {
      taskId,
      passed: judgment.passed,
      alreadyCompleted: false,
      feedback,
      checks: judgment.checks,
      metrics: judgment.metrics,
    };
  }

  function titleOf(taskId: TaskId): string {
    return store.getState().tasks.find((t) => t.taskId === taskId)?.title ?? taskId;
  }

  function getTaskDetail(taskId: TaskId): TaskDetail {
    const session = sessions[taskId];
    const meta = TASK_META[taskId];
    // 防御：类型上 taskId 不可能非法，但 DOM 篡改/动态调用可传入未知 id，
    // sessions[taskId] 为 undefined 时解引用会抛 TypeError。
    if (!session || !meta) {
      return {
        taskId,
        title: titleOf(taskId),
        status: 'idle',
        progress: 0,
        goal: '',
        predictionPrompt: '',
        prediction: '',
        checks: [],
        metrics: {},
        observedSeconds: 0,
        requiredObservedSeconds: 0,
        submitCount: 0,
        lastFeedback: null,
        knowledge: null,
        heuristicNote: null,
        unknownSeaOutcome: null,
        needsEstimatePayload: taskId === 'unknown-sea',
      };
    }
    const live = liveChecks(taskId);
    const status: TaskStatus = session.completed ? 'passed' : session.prediction ? 'ready' : 'idle';
    const state = store.getState();
    const progress =
      state.tasks.find((t) => t.taskId === taskId)?.progress ?? liveProgress(taskId);
    return {
      taskId,
      title: titleOf(taskId),
      status,
      progress,
      goal: meta.goal,
      predictionPrompt: meta.predictionPrompt,
      prediction: session.prediction,
      checks: live.checks,
      metrics: live.metrics,
      observedSeconds: trackers[taskId],
      requiredObservedSeconds:
        taskId === 'unknown-sea' ? 0 : TASK_THRESHOLDS[taskId].sustainedSeconds,
      submitCount: session.submitCount,
      lastFeedback: session.lastFeedback,
      knowledge: session.completed ? meta.knowledge : null,
      heuristicNote:
        taskId === 'grid-pattern' && GRID_PATTERN_HEURISTIC
          ? (meta.heuristicNote ?? null)
          : null,
      unknownSeaOutcome: session.completed ? session.unknownSeaOutcome : null,
      needsEstimatePayload: taskId === 'unknown-sea',
    };
  }

  function requestMysteryReroll(): void {
    store.emit(TASK_EVENTS.MYSTERY_REROLL, { seed: Math.floor(Math.random() * 2 ** 31) });
  }

  // ---------- 契约 API ----------

  function evaluate(): void {
    const fingerprint = fieldFingerprint();
    if (fingerprint !== cachedFingerprint) {
      cachedFingerprint = fingerprint;
      resetTrackers(); // 波场变了：旧配置下的观测时长作废
    }
    if (!clock) {
      // 无时钟降级：按 evaluate() 调用间隔的真实时间近似累计（暂停时不累计）
      const now = Date.now() / 1000;
      const paused = store.getState().playback.paused;
      if (lastWallTime !== null && !paused) {
        const dt = Math.min(Math.max(now - lastWallTime, 0), 0.5);
        if (dt > 0) stepTrackers(dt);
      }
      lastWallTime = now;
    }
    flushTasksToStore(false);
  }

  function reset(): void {
    for (const id of TASK_ORDER) sessions[id] = freshSession();
    resetTrackers();
    stamps.clear();
    persistence.clear();
    store.setState({ tasks: store.getState().tasks.map((t) => ({ ...t, done: false, progress: 0 })) });
    store.emit(STORE_EVENTS.TASKS_UPDATED, store.getState().tasks);
  }

  function getProgress(taskId: TaskId): { done: boolean; progress: number } {
    const t = store.getState().tasks.find((x) => x.taskId === taskId);
    return { done: t?.done ?? false, progress: t?.progress ?? 0 };
  }

  function dispose(): void {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
      persistAll();
    }
    for (const off of unsubscribes) off();
    unsubscribes.length = 0;
    stamps.clear();
  }

  // ---------- 构造期收尾：恢复持久化进度并同步 store ----------

  restoreFromPersistence();
  cachedFingerprint = fieldFingerprint();
  flushTasksToStore(true);

  return {
    evaluate,
    reset,
    getProgress,
    dispose,
    setPrediction,
    submitResult,
    getTaskDetail,
    requestMysteryReroll,
  };
}
