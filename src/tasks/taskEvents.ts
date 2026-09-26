/**
 * 任务模块自有 store 事件契约 —— src/tasks 模块私有。
 * core/constants STORE_EVENTS 是全项目定稿事件名，本文件只登记任务系统新增事件，
 * 供 data（报告时间线）、ui / experiments（任务交互）监听。
 * 事件名一律引用本文件常量，禁止在业务代码里写裸字符串。
 *
 * 注意：跨 feature 模块（如 data/report）不得 import 本文件（SPEC §8 通信规则），
 * 需要监听这些事件的模块以「镜像常量」方式声明同名事件名，集成测试保证两端一致。
 * v0.2：AI 导师模块已废弃，COMPLETED 的 AI 总结 / TTS 钩子不再接线
 * （summary 文本由任务面板展示，语音引导走预生成素材，见 SPEC §6.6）。
 */
import type { TaskId } from '../core/types';
import type { UnknownSeaOutcome } from './taskDefs';

export const TASK_EVENTS = {
  /** 学生提交预测：payload TaskPredictionPayload */
  PREDICTION_SET: 'task:prediction-set',
  /** 提交结果并完成判定（无论通过与否都会发）：payload TaskJudgedPayload */
  JUDGED: 'task:judged',
  /** 任务首次判定通过：AI 总结与 TTS 的钩子，payload TaskCompletedPayload（含口播文本） */
  COMPLETED: 'task:completed',
  /** 请求实验层随机化一个未知海况（任务六"换一个海况"按钮）：payload TaskMysteryRerollPayload；实验层可选实现 */
  MYSTERY_REROLL: 'task:mystery-reroll',
} as const;

export interface TaskPredictionPayload {
  taskId: TaskId;
  prediction: string;
  /** 仿真时间（s）；无时钟注入时为 null */
  simTime: number | null;
}

export interface TaskJudgedPayload {
  taskId: TaskId;
  passed: boolean;
  feedback: string;
  /** 第几次提交（从 1 开始） */
  submitCount: number;
  simTime: number | null;
  metrics: Record<string, number>;
  /** 仅任务六携带：真值/估值/误差记录 */
  unknownSea?: UnknownSeaOutcome;
}

export interface TaskCompletedPayload {
  taskId: TaskId;
  title: string;
  /** 知识总结文本（AI 总结钩子的素材） */
  summary: string;
  /** 口播文本（TTS 钩子直接朗读这段） */
  speech: string;
  simTime: number | null;
}

export interface TaskMysteryRerollPayload {
  /** 建议实验层写入 params.spectrum.randomSeed 的随机种子 */
  seed: number;
}
