/**
 * 实验报告 —— docs/SPEC.md §7.7、§14。
 * 归属：数据层。自动汇总：参数快照、理论海况、操作时间线、任务完成情况、
 * 预测记录、测量数据与误差、模型简化声明；产出结构化 JSON + Markdown 文本。
 *
 * 【相对契约骨架的增量（均为向后兼容的可选扩展，原有 generate/exportMarkdown 签名未动）】
 *  - ReportDeps 新增可选字段 clock?（时间线打仿真时间戳；缺省时时间线无仿真时间）。
 *  - ReportDocument 新增可选字段 predictions / timeline / unknownSea / modelNotes。
 *  - Report 新增 exportJson / download / copyToClipboard：下载与复制是纯浏览器 API 工具函数，
 *    不渲染任何面板（按钮仍归 UI 层绑定，SPEC §6.7"只产文本"的边界不变）。
 *
 * 数据来源只走合法通道：store 状态与订阅、store 事件（任务系统事件名以镜像常量声明，
 * 与 src/tasks/taskEvents.ts 保持一致，集成测试验证两端）、waveField 数据接口。
 */
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type {
  MeasurementRecord,
  SimParams,
  SimState,
  TaskId,
  TaskProgress,
} from '../core/types';
import type { WaveField } from '../physics/waveField';

export interface ReportDeps {
  store: Store<SimState>;
  waveField: WaveField;
  /** 可选：仿真时钟，用于时间线/报告的仿真时间戳 */
  clock?: SimClock;
}

/** 学生预测记录（探究闭环第一步的留痕） */
export interface ReportPrediction {
  taskId: TaskId;
  prediction: string;
  simTime: number | null;
  wallClock: number;
}

export type ReportTimelineKind =
  | 'experiment'
  | 'params'
  | 'measurement'
  | 'prediction'
  | 'judged'
  | 'completed';

/** 操作时间线条目 */
export interface ReportTimelineEntry {
  kind: ReportTimelineKind;
  label: string;
  simTime: number | null;
  wallClock: number;
}

/** 任务六真值/估值/误差汇总 */
export interface ReportUnknownSea {
  truthHs: number;
  truthTp: number;
  estimateHs: number;
  estimateTp: number;
  hsErrorPct: number;
  tpErrorPct: number;
  passed: boolean;
}

export interface ReportDocument {
  /** 报告生成时刻的仿真时间（s） */
  generatedAtSimTime: number;
  experiment: SimState['experiment'];
  params: SimParams;
  seaState: { hs: number; tp: number; peakFrequency: number; wavelength: number };
  measurements: readonly MeasurementRecord[];
  tasks: readonly TaskProgress[];
  // ---- v0.2 增量可选字段（向后兼容） ----
  /** 学生预测记录 */
  predictions?: readonly ReportPrediction[];
  /** 操作时间线（实验切换/参数调整/测量/预测/判定/完成） */
  timeline?: readonly ReportTimelineEntry[];
  /** 任务六真值/估值/误差（未提交过则为 null） */
  unknownSea?: ReportUnknownSea | null;
  /** 教学简化模型声明（docs/SPEC.md §13 学生可见声明列） */
  modelNotes?: readonly { model: string; statement: string }[];
}

export interface Report {
  /** 汇总当前 store + waveField 生成报告数据 */
  generate(): ReportDocument;
  /** 导出 Markdown 文本（下载/复制由 UI 层处理，本模块只产文本） */
  exportMarkdown(doc?: ReportDocument): string;
  /** 导出结构化 JSON 文本（增量 API） */
  exportJson(doc?: ReportDocument): string;
  /** 触发浏览器下载 .md 文件；非浏览器环境返回 { ok:false }（增量 API） */
  download(doc?: ReportDocument): Promise<{ ok: boolean; reason?: string }>;
  /** 复制 Markdown 到剪贴板；不可用时返回 { ok:false }（增量 API） */
  copyToClipboard(doc?: ReportDocument): Promise<{ ok: boolean; reason?: string }>;
  /** 取消全部 store 订阅（增量 API） */
  dispose(): void;
}

// ---- 任务系统事件名镜像（跨 feature 禁止 import，见 taskEvents.ts；测试验证一致） ----
const TASK_EVT = {
  PREDICTION_SET: 'task:prediction-set',
  JUDGED: 'task:judged',
  COMPLETED: 'task:completed',
} as const;

/** 教学简化模型声明（SPEC §13 表格"学生可见声明"列，报告附此表） */
const SIMPLIFIED_MODELS: readonly { model: string; statement: string }[] = [
  { model: '波形叠加', statement: '小振幅波理论（线性波）' },
  { model: '色散关系', statement: '深水近似（水深>半波长）' },
  { model: '风浪成长', statement: '教学经验公式' },
  { model: '谱模型', statement: 'JONSWAP 教学版' },
  { model: '谱离散', statement: '有限频带离散' },
  { model: '白帽', statement: '经验强度指标 0–1' },
  { model: '质点轨迹', statement: '一阶（线性）轨迹' },
  { model: '理论海况', statement: '数值离散估计' },
];

const TIMELINE_CAP = 500;

interface TaskJudgedPayloadView {
  taskId?: unknown;
  passed?: unknown;
  feedback?: unknown;
  submitCount?: unknown;
  metrics?: Record<string, number>;
  unknownSea?: Partial<ReportUnknownSea>;
}

interface TaskPredictionPayloadView {
  taskId?: unknown;
  prediction?: unknown;
}

export function createReport(deps: ReportDeps): Report {
  const { store, waveField } = deps;
  const clock = deps.clock ?? null;

  // ---------- 会话内日志（事件溯源：监听 store 事件维护，页刷新后从当前状态重建测量/任务） ----------
  const timeline: ReportTimelineEntry[] = [];
  const predictions = new Map<TaskId, ReportPrediction>();
  let unknownSea: ReportUnknownSea | null = null;
  const unsubscribes: Array<() => void> = [];

  function nowSimTime(): number | null {
    return clock ? clock.time() : null;
  }

  function pushTimeline(kind: ReportTimelineKind, label: string): void {
    timeline.push({ kind, label, simTime: nowSimTime(), wallClock: Date.now() });
    if (timeline.length > TIMELINE_CAP) timeline.splice(0, timeline.length - TIMELINE_CAP);
  }

  // store 状态差分 → 实验切换 / 参数调整 / 测量时间线
  unsubscribes.push(
    store.subscribe((state, prev) => {
      if (state.experiment !== prev.experiment) {
        pushTimeline('experiment', `切换实验 → ${state.experiment}`);
      }
      if (state.params !== prev.params) {
        const branches = (Object.keys(state.params) as Array<keyof SimParams>).filter(
          (key) => state.params[key] !== prev.params[key],
        );
        pushTimeline('params', `参数调整（${branches.join('、') || 'params'}）`);
      }
      if (state.measurements !== prev.measurements && state.measurements.length > prev.measurements.length) {
        for (let i = prev.measurements.length; i < state.measurements.length; i++) {
          const rec = state.measurements[i];
          if (rec) pushTimeline('measurement', `测量（${rec.tool}）：${formatValues(rec)}`);
        }
      }
    }),
  );

  // 任务系统事件 → 预测 / 判定 / 完成时间线
  unsubscribes.push(
    store.on(TASK_EVT.PREDICTION_SET, (payload) => {
      const view = (payload ?? {}) as TaskPredictionPayloadView;
      if (typeof view.taskId !== 'string') return;
      const text = typeof view.prediction === 'string' ? view.prediction : '';
      predictions.set(view.taskId as TaskId, {
        taskId: view.taskId as TaskId,
        prediction: text,
        simTime: nowSimTime(),
        wallClock: Date.now(),
      });
      pushTimeline('prediction', `预测（${view.taskId}）：${text || '（空）'}`);
    }),
  );

  unsubscribes.push(
    store.on(TASK_EVT.JUDGED, (payload) => {
      const view = (payload ?? {}) as TaskJudgedPayloadView;
      if (typeof view.taskId !== 'string') return;
      const passed = view.passed === true;
      const count = typeof view.submitCount === 'number' ? `第 ${view.submitCount} 次` : '';
      pushTimeline(
        'judged',
        `提交判定（${view.taskId}）${count}：${passed ? '通过' : '未通过'}`,
      );
      const outcome = view.unknownSea;
      // 防泄漏：报告只在任务六判定通过后记录真值三列
      // （失败尝试的估值+误差可反推真值，不落入可导出的报告）
      if (view.taskId === 'unknown-sea' && outcome && outcome.passed === true) {
        unknownSea = {
          truthHs: numOr(outcome.truthHs, Number.NaN),
          truthTp: numOr(outcome.truthTp, Number.NaN),
          estimateHs: numOr(outcome.estimateHs, Number.NaN),
          estimateTp: numOr(outcome.estimateTp, Number.NaN),
          hsErrorPct: numOr(outcome.hsErrorPct, Number.NaN),
          tpErrorPct: numOr(outcome.tpErrorPct, Number.NaN),
          passed: true,
        };
      }
    }),
  );

  unsubscribes.push(
    store.on(TASK_EVT.COMPLETED, (payload) => {
      const view = (payload ?? {}) as { taskId?: unknown };
      if (typeof view.taskId === 'string') {
        pushTimeline('completed', `任务完成：${view.taskId}`);
      }
    }),
  );

  function numOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function formatValues(rec: MeasurementRecord): string {
    return Object.entries(rec.values)
      .map(([key, value]) => `${key}=${fmtNum(value)}`)
      .join(' ');
  }

  function fmtNum(value: number, digits = 2): string {
    return Number.isFinite(value) ? value.toFixed(digits) : '—';
  }

  function fmtClock(ms: number): string {
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function fmtSim(seconds: number): string {
    return `${seconds.toFixed(1)}s`;
  }

  // ---------- 报告生成 ----------

  function deepCopyParams(params: SimParams): SimParams {
    return JSON.parse(JSON.stringify(params)) as SimParams;
  }

  function generate(): ReportDocument {
    const state = store.getState();
    const sea = waveField.observedSeaState();
    return {
      generatedAtSimTime: clock ? clock.time() : 0,
      experiment: state.experiment,
      params: deepCopyParams(state.params),
      seaState: { ...sea },
      measurements: state.measurements.map((m) => ({ ...m, values: { ...m.values } })),
      tasks: state.tasks.map((t) => ({ ...t })),
      predictions: [...predictions.values()],
      timeline: [...timeline],
      unknownSea: unknownSea ? { ...unknownSea } : null,
      modelNotes: SIMPLIFIED_MODELS,
    };
  }

  // ---------- Markdown ----------

  function exportMarkdown(doc?: ReportDocument): string {
    const d = doc ?? generate();
    const lines: string[] = [];
    const experimentNames: Record<SimState['experiment'], string> = {
      wind: '实验一 · 风浪生成机制',
      interference: '实验二 · 双造波机叠加',
      spectrum: '实验三 · 不规则随机海况',
    };

    lines.push('# 海浪动力学虚拟探索实验报告');
    lines.push('');
    lines.push(
      `- 生成时刻：${fmtClock(Date.now())}（仿真时间 ${fmtSim(d.generatedAtSimTime)}）`,
    );
    lines.push(`- 当前实验：${experimentNames[d.experiment]}`);
    lines.push('');

    // 一、参数快照
    lines.push('## 一、参数快照');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(d.params, null, 2));
    lines.push('```');
    lines.push('');

    // 二、理论海况
    lines.push('## 二、理论海况（waveField 观测值）');
    lines.push('');
    lines.push(
      `| Hs (m) | Tp (s) | fp (Hz) | λ (m) |`,
    );
    lines.push('| --- | --- | --- | --- |');
    lines.push(
      `| ${fmtNum(d.seaState.hs)} | ${fmtNum(d.seaState.tp)} | ${fmtNum(d.seaState.peakFrequency, 3)} | ${fmtNum(d.seaState.wavelength, 1)} |`,
    );
    lines.push('');

    // 三、任务完成情况
    lines.push('## 三、任务完成情况');
    lines.push('');
    lines.push('| 任务 | 状态 | 进度 |');
    lines.push('| --- | --- | --- |');
    for (const task of d.tasks) {
      lines.push(
        `| ${task.title} | ${task.done ? '已完成' : '未完成'} | ${Math.round(task.progress * 100)}% |`,
      );
    }
    lines.push('');

    // 四、预测记录
    lines.push('## 四、预测记录');
    lines.push('');
    const preds = d.predictions ?? [];
    if (preds.length === 0) {
      lines.push('（无预测记录）');
    } else {
      for (const p of preds) {
        lines.push(`- **${p.taskId}**：${p.prediction || '（空）'}`);
      }
    }
    lines.push('');

    // 五、操作时间线
    lines.push('## 五、操作时间线');
    lines.push('');
    const timeline = d.timeline ?? [];
    if (timeline.length === 0) {
      lines.push('（本会话暂无操作记录）');
    } else {
      for (const entry of timeline) {
        const sim = entry.simTime !== null ? `仿真 ${fmtSim(entry.simTime)}` : '仿真 —';
        lines.push(`- [${fmtClock(entry.wallClock)} · ${sim}] ${entry.label}`);
      }
    }
    lines.push('');

    // 六、测量数据
    lines.push('## 六、测量数据');
    lines.push('');
    if (d.measurements.length === 0) {
      lines.push('（无测量记录）');
    } else {
      lines.push('| # | 仿真时间 (s) | 仪器 | 读数 | 备注 |');
      lines.push('| --- | --- | --- | --- | --- |');
      d.measurements.forEach((m, index) => {
        lines.push(
          `| ${index + 1} | ${m.simTime.toFixed(1)} | ${m.tool} | ${formatValues(m) || '—'} | ${m.note ?? '—'} |`,
        );
      });
    }
    lines.push('');

    // 七、任务六真值/估值/误差
    lines.push('## 七、未知海况还原（任务六）');
    lines.push('');
    const us = d.unknownSea;
    if (!us) {
      lines.push('（任务六未通过，真值不予展示；失败尝试仅记入操作时间线）');
    } else {
      lines.push('| 物理量 | 真值 | 估计值 | 误差 |');
      lines.push('| --- | --- | --- | --- |');
      lines.push(
        `| 有效波高 Hs (m) | ${fmtNum(us.truthHs)} | ${fmtNum(us.estimateHs)} | ${fmtNum(us.hsErrorPct, 1)}% |`,
      );
      lines.push(
        `| 谱峰周期 Tp (s) | ${fmtNum(us.truthTp)} | ${fmtNum(us.estimateTp)} | ${fmtNum(us.tpErrorPct, 1)}% |`,
      );
      lines.push('');
      lines.push(`判定结果：${us.passed ? '通过（Hs ≤15% 且 Tp ≤20%）' : '未通过'}。`);
    }
    lines.push('');

    // 八、模型简化声明
    lines.push('## 八、教学简化模型声明');
    lines.push('');
    lines.push('| 模型 | 学生可见声明 |');
    lines.push('| --- | --- |');
    for (const note of d.modelNotes ?? SIMPLIFIED_MODELS) {
      lines.push(`| ${note.model} | ${note.statement} |`);
    }
    lines.push('');
    lines.push('> 本实验为教学简化模型，结论用于概念理解，不能直接替代工程计算。');
    lines.push('');

    return lines.join('\n');
  }

  // ---------- JSON 与导出工具 ----------

  function exportJson(doc?: ReportDocument): string {
    const d = doc ?? generate();
    return JSON.stringify({ kind: 'wave-lab-report', version: 1, ...d }, null, 2);
  }

  async function download(doc?: ReportDocument): Promise<{ ok: boolean; reason?: string }> {
    try {
      const BlobCtor = (globalThis as { Blob?: typeof Blob }).Blob;
      const urlCreator = (globalThis as { URL?: typeof URL }).URL;
      if (
        !BlobCtor ||
        !urlCreator ||
        typeof urlCreator.createObjectURL !== 'function' ||
        typeof document === 'undefined'
      ) {
        return { ok: false, reason: '当前环境不支持 Blob 下载（需要在浏览器中运行）' };
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const blob = new BlobCtor([exportMarkdown(doc)], { type: 'text/markdown;charset=utf-8' });
      const url = urlCreator.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `wave-lab-report-${stamp}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      globalThis.setTimeout(() => urlCreator.revokeObjectURL(url), 1000);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }

  async function copyToClipboard(doc?: ReportDocument): Promise<{ ok: boolean; reason?: string }> {
    const text = exportMarkdown(doc);
    const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })
      .navigator;
    if (nav?.clipboard?.writeText) {
      try {
        await nav.clipboard.writeText(text);
        return { ok: true };
      } catch {
        // 权限拒绝等：尝试 execCommand 兜底
      }
    }
    try {
      if (typeof document !== 'undefined' && document.execCommand) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok ? { ok: true } : { ok: false, reason: '剪贴板写入被拒绝' };
      }
    } catch {
      // 继续返回失败
    }
    return { ok: false, reason: '当前环境不支持剪贴板写入（需要在浏览器中运行）' };
  }

  function dispose(): void {
    for (const off of unsubscribes) off();
    unsubscribes.length = 0;
  }

  return { generate, exportMarkdown, exportJson, download, copyToClipboard, dispose };
}
