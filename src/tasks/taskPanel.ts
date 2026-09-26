/**
 * 任务交互面板（可选挂载组件）—— src/tasks 模块私有。
 * 承载六个任务的探究闭环 UI：目标说明 → 预测输入 → 实时判定项 → 提交结果 → 判定反馈 → 知识总结。
 * 由集成工程师把 UI 的某个挂载点（如左栏任务卡容器）注入 deps.root 后 mount()；
 * 不与 UI 工程师的静态任务卡冲突：本面板是可替换的完整交互实现。
 *
 * 视觉：深海科研风——青绿主色 #7FD4C1 / 琥珀警示 #F2B662 / 面板 rgba(6,42,46,.85)，
 * 1px 描边、无渐变、无阴影堆砌、无 emoji；样式经 <style> 注入并全部使用 wlab-tk- 前缀，
 * 不读写 styles/main.css（该文件归 UI 工程师）。
 */
import type { Store } from '../core/store';
import type { SimState, TaskId } from '../core/types';
import { TASK_EVENTS } from './taskEvents';
import { TASK_ORDER } from './taskDefs';
import type { Tasks, TaskDetail } from './tasks';

/** 任务素材访问器（由集成工程师在装配期注入，本模块不直接依赖 ui/media） */
export interface TaskPanelMedia {
  /** 任务现象配图（任务一/五有，其余返回 null） */
  caseImageSrc(taskId: TaskId): string | null;
  /** 任务语音引导素材地址 */
  voiceSrc(taskId: TaskId): string;
  /** 播放一段音频 */
  play(src: string): void;
}

export interface TaskPanelDeps {
  /** 面板挂载容器（由集成工程师注入 UI 槽位） */
  root: HTMLElement;
  store: Store<SimState>;
  tasks: Tasks;
  /** 预生成素材入口（可选；未注入则不渲染配图与语音按钮） */
  media?: TaskPanelMedia;
}

export interface TaskPanel {
  mount(): void;
  /** 立即按当前任务状态重绘（一般无需手动调用） */
  refresh(): void;
  dispose(): void;
}

const STYLE_ID = 'wlab-tk-panel-style';

const STYLE_TEXT = `
.wlab-tk-root { display:flex; flex-direction:column; gap:10px; color:#E8F5F1; font-size:12px; line-height:1.5; }
.wlab-tk-card { border:1px solid rgba(127,212,193,.18); background:rgba(6,42,46,.85); border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:8px; }
.wlab-tk-card[data-status="passed"] { border-color:rgba(127,212,193,.45); }
.wlab-tk-head { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.wlab-tk-title { margin:0; font-size:13px; font-weight:600; color:#7FD4C1; }
.wlab-tk-badge { flex:none; font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid rgba(127,212,193,.35); color:#9DC3BC; }
.wlab-tk-badge.ready { color:#F2B662; border-color:rgba(242,182,98,.45); }
.wlab-tk-badge.passed { color:#041F22; background:#7FD4C1; border-color:#7FD4C1; }
.wlab-tk-bar { height:3px; border-radius:2px; overflow:hidden; background:rgba(127,212,193,.15); }
.wlab-tk-bar > span { display:block; height:100%; background:#7FD4C1; }
.wlab-tk-goal { color:#9DC3BC; }
.wlab-tk-case { width:100%; border-radius:6px; border:1px solid rgba(127,212,193,.18); display:block; }
.wlab-tk-voice { align-self:flex-start; font:inherit; font-size:12px; padding:4px 12px; border-radius:6px; border:1px solid rgba(127,212,193,.35); background:transparent; color:#7FD4C1; cursor:pointer; }
.wlab-tk-voice:hover { background:rgba(127,212,193,.12); }
.wlab-tk-pred { display:flex; flex-direction:column; gap:3px; color:#9DC3BC; }
.wlab-tk-pred textarea { width:100%; box-sizing:border-box; min-height:44px; resize:vertical; padding:6px; border-radius:6px; border:1px solid rgba(127,212,193,.18); background:rgba(4,31,34,.8); color:#E8F5F1; font:inherit; }
.wlab-tk-pred textarea:disabled { opacity:.6; }
.wlab-tk-checks { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:3px; }
.wlab-tk-checks li { display:flex; gap:6px; align-items:baseline; color:#9DC3BC; }
.wlab-tk-checks li::before { content:''; flex:none; width:6px; height:6px; border-radius:50%; background:#54706b; }
.wlab-tk-checks li.ok::before { background:#7FD4C1; }
.wlab-tk-checks li.bad::before { background:#F2B662; }
.wlab-tk-checks .lbl { color:#E8F5F1; }
.wlab-tk-est { display:flex; gap:8px; }
.wlab-tk-est label { flex:1; display:flex; flex-direction:column; gap:2px; color:#9DC3BC; }
.wlab-tk-est input { padding:4px 6px; border-radius:6px; border:1px solid rgba(127,212,193,.18); background:rgba(4,31,34,.8); color:#E8F5F1; font:inherit; }
.wlab-tk-submit { align-self:flex-start; padding:5px 14px; border:none; border-radius:6px; background:#7FD4C1; color:#041F22; font:inherit; font-weight:600; cursor:pointer; }
.wlab-tk-submit:disabled { opacity:.4; cursor:default; }
.wlab-tk-feedback { color:#F2B662; }
.wlab-tk-feedback.ok { color:#7FD4C1; }
.wlab-tk-knowledge { padding-left:8px; border-left:2px solid rgba(127,212,193,.4); color:#9DC3BC; }
.wlab-tk-note { color:#F2B662; font-size:11px; }
.wlab-tk-table { width:100%; border-collapse:collapse; font-family:Consolas,monospace; font-size:11px; }
.wlab-tk-table th, .wlab-tk-table td { border:1px solid rgba(127,212,193,.18); padding:3px 6px; text-align:right; color:#E8F5F1; }
.wlab-tk-table th:first-child, .wlab-tk-table td:first-child { text-align:left; color:#9DC3BC; }
`.trim();

const STATUS_TEXT: Record<TaskDetail['status'], string> = {
  idle: '未开始',
  ready: '进行中',
  passed: '已通过',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export function createTaskPanel(deps: TaskPanelDeps): TaskPanel {
  const { root, store, tasks, media } = deps;
  const unsubscribes: Array<() => void> = [];
  let mounted = false;

  function renderTaskCard(detail: TaskDetail): HTMLElement {
    const card = el('section', 'wlab-tk-card');
    card.dataset.status = detail.status;

    const head = el('header', 'wlab-tk-head');
    head.appendChild(el('h4', 'wlab-tk-title', detail.title));
    head.appendChild(el('span', `wlab-tk-badge ${detail.status}`, STATUS_TEXT[detail.status]));
    card.appendChild(head);

    const bar = el('div', 'wlab-tk-bar');
    const fill = el('span');
    fill.style.width = `${Math.round(detail.progress * 100)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);

    card.appendChild(el('div', 'wlab-tk-goal', detail.goal));

    // 预生成素材：现象配图 + 语音引导（装配期注入，替代原 UI 静态卡的素材入口）
    if (media) {
      const caseSrc = media.caseImageSrc(detail.taskId);
      if (caseSrc) {
        const img = document.createElement('img');
        img.className = 'wlab-tk-case';
        img.src = caseSrc;
        img.alt = `${detail.title}现象示例图`;
        img.loading = 'lazy';
        img.addEventListener('error', () => img.remove(), { once: true });
        card.appendChild(img);
      }
      const voiceBtn = el('button', 'wlab-tk-voice', '语音引导');
      voiceBtn.type = 'button';
      voiceBtn.title = '播放本任务语音引导（预生成素材）';
      voiceBtn.addEventListener('click', () => media.play(media.voiceSrc(detail.taskId)));
      card.appendChild(voiceBtn);
    }

    // 探究闭环第一步：预测
    const pred = el('label', 'wlab-tk-pred');
    pred.appendChild(el('span', undefined, '我的预测（提交前必填）'));
    const textarea = el('textarea');
    textarea.dataset.wlabRole = 'prediction';
    textarea.dataset.taskId = detail.taskId;
    textarea.placeholder = detail.predictionPrompt;
    textarea.value = detail.prediction;
    textarea.disabled = detail.status === 'passed';
    pred.appendChild(textarea);
    card.appendChild(pred);

    // 实时判定项
    const checks = el('ul', 'wlab-tk-checks');
    for (const check of detail.checks) {
      const li = el('li', check.ok ? 'ok' : 'bad');
      li.appendChild(el('span', 'lbl', check.label));
      li.appendChild(el('span', undefined, `（${check.detail}）`));
      checks.appendChild(li);
    }
    card.appendChild(checks);

    // 任务六：估计值输入 + 「换一个海况」（requestMysteryReroll 的 UI 入口，SPEC §6.5）
    if (detail.needsEstimatePayload && detail.status !== 'passed') {
      const est = el('div', 'wlab-tk-est');
      const hsLabel = el('label');
      hsLabel.appendChild(el('span', undefined, '估计 Hs（m）'));
      const hsInput = el('input');
      hsInput.type = 'number';
      hsInput.min = '0';
      hsInput.step = '0.01';
      hsInput.dataset.wlabRole = 'estimate-hs';
      hsInput.dataset.taskId = detail.taskId;
      hsLabel.appendChild(hsInput);
      const tpLabel = el('label');
      tpLabel.appendChild(el('span', undefined, '估计 Tp（s）'));
      const tpInput = el('input');
      tpInput.type = 'number';
      tpInput.min = '0';
      tpInput.step = '0.1';
      tpInput.dataset.wlabRole = 'estimate-tp';
      tpInput.dataset.taskId = detail.taskId;
      tpLabel.appendChild(tpInput);
      est.appendChild(hsLabel);
      est.appendChild(tpLabel);
      card.appendChild(est);
      if (store.getState().params.spectrum.mystery) {
        const reroll = el('button', 'wlab-tk-submit', '换一个海况');
        reroll.dataset.wlabRole = 'reroll';
        reroll.dataset.taskId = detail.taskId;
        card.appendChild(reroll);
      }
    }

    // 提交按钮
    const submit = el('button', 'wlab-tk-submit', detail.status === 'passed' ? '已完成' : '提交结果');
    submit.dataset.wlabRole = 'submit';
    submit.dataset.taskId = detail.taskId;
    submit.disabled = detail.status === 'passed';
    card.appendChild(submit);

    // 判定反馈
    if (detail.lastFeedback) {
      card.appendChild(
        el('div', `wlab-tk-feedback${detail.status === 'passed' ? ' ok' : ''}`, detail.lastFeedback),
      );
    }

    // 启发式判定注明（任务五，规格要求）
    if (detail.heuristicNote) card.appendChild(el('div', 'wlab-tk-note', detail.heuristicNote));

    // 知识总结（通过后）
    if (detail.knowledge) {
      card.appendChild(el('div', 'wlab-tk-knowledge', `知识总结：${detail.knowledge}`));
    }

    // 任务六真值/估值/误差三列表（通过后展示真值；未通过前只显示误差）
    if (detail.needsEstimatePayload) {
      const outcome = detail.unknownSeaOutcome;
      if (outcome && detail.status === 'passed') {
        card.appendChild(el('div', 'wlab-tk-note', '本海况还原结果（真值 / 估计值 / 误差）：'));
        card.appendChild(buildOutcomeTable(outcome.truthHs, outcome.truthTp, outcome.estimateHs, outcome.estimateTp, outcome.hsErrorPct, outcome.tpErrorPct));
      } else if (outcome) {
        card.appendChild(
          el(
            'div',
            'wlab-tk-note',
            `最近一次估计：Hs 误差 ${fmt(outcome.hsErrorPct, 1)}%、Tp 误差 ${fmt(outcome.tpErrorPct, 1)}%（真值将在通过后展示）`,
          ),
        );
      }
    }

    return card;
  }

  function buildOutcomeTable(
    truthHs: number,
    truthTp: number,
    estHs: number,
    estTp: number,
    hsErrPct: number,
    tpErrPct: number,
  ): HTMLTableElement {
    const table = el('table', 'wlab-tk-table');
    const head = el('tr');
    head.appendChild(el('th', undefined, '物理量'));
    head.appendChild(el('th', undefined, '真值'));
    head.appendChild(el('th', undefined, '估计值'));
    head.appendChild(el('th', undefined, '误差'));
    table.appendChild(head);
    const row = (name: string, truth: number, est: number, err: number, unit: string) => {
      const tr = el('tr');
      tr.appendChild(el('td', undefined, `${name}（${unit}）`));
      tr.appendChild(el('td', undefined, fmt(truth)));
      tr.appendChild(el('td', undefined, fmt(est)));
      tr.appendChild(el('td', undefined, `${fmt(err, 1)}%`));
      table.appendChild(tr);
    };
    row('有效波高 Hs', truthHs, estHs, hsErrPct, 'm');
    row('谱峰周期 Tp', truthTp, estTp, tpErrPct, 's');
    return table;
  }

  function refresh(): void {
    if (!mounted) return;
    // 高频重绘下保持输入焦点：观测条件活跃时任务进度会周期性变化并触发重建，
    // 先记录焦点元素（预测 textarea / 任务六估计输入）与光标位置，重建后恢复。
    const active = document.activeElement;
    let focusKey: { role: string; taskId: string; start: number; end: number } | null = null;
    if (
      root.contains(active) &&
      (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
    ) {
      let start = active.value.length;
      let end = active.value.length;
      try {
        // type=number 等非文本输入读取 selectionStart 会抛 InvalidStateError（无光标概念）
        start = active.selectionStart ?? start;
        end = active.selectionEnd ?? end;
      } catch {
        /* 无光标输入类型：只恢复焦点，不恢复光标位置 */
      }
      focusKey = {
        role: active.dataset.wlabRole ?? '',
        taskId: active.dataset.taskId ?? '',
        start,
        end,
      };
    }
    root.textContent = '';
    const list = el('div', 'wlab-tk-root');
    for (const id of TASK_ORDER) {
      list.appendChild(renderTaskCard(tasks.getTaskDetail(id)));
    }
    root.appendChild(list);
    if (focusKey && focusKey.role) {
      const restored = findCardInput(focusKey.taskId, focusKey.role);
      if (restored) {
        restored.focus();
        try {
          restored.setSelectionRange(focusKey.start, focusKey.end);
        } catch {
          /* 个别 input 类型不支持 setSelectionRange，忽略即可 */
        }
      }
    }
  }

  function findCardInput(
    taskId: string,
    role: string,
  ): HTMLInputElement | HTMLTextAreaElement | null {
    return root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-wlab-role="${role}"][data-task-id="${taskId}"]`,
    );
  }

  function onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // 任务六「换一个海况」：emit MYSTERY_REROLL → 集成侧接 experiments.randomSeaState
    if (target.dataset.wlabRole === 'reroll') {
      tasks.requestMysteryReroll();
      return;
    }
    if (target.dataset.wlabRole !== 'submit') return;
    const taskId = target.dataset.taskId as TaskId | undefined;
    if (!taskId) return;
    const detail = tasks.getTaskDetail(taskId);
    if (detail.needsEstimatePayload) {
      const hs = Number(findCardInput(taskId, 'estimate-hs')?.value ?? Number.NaN);
      const tp = Number(findCardInput(taskId, 'estimate-tp')?.value ?? Number.NaN);
      if (!Number.isFinite(hs) || !Number.isFinite(tp) || hs <= 0 || tp <= 0) {
        // 无 alert()：直接给出一次失败判定反馈，提示补齐估计值
        tasks.submitResult(taskId, { hs: Number.NaN, tp: Number.NaN });
        refresh();
        return;
      }
      tasks.submitResult(taskId, { hs, tp });
      refresh();
      return;
    }
    tasks.submitResult(taskId);
    refresh();
  }

  // input 而非 change：change 只在失焦时触发，观测活跃期面板重建会把
  // 尚未失焦的输入回滚成旧值（丢字）；input 实时入库规避该问题。
  function onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (target.dataset.wlabRole !== 'prediction') return;
    const taskId = target.dataset.taskId as TaskId | undefined;
    if (!taskId) return;
    tasks.setPrediction(taskId, target.value);
  }

  function mount(): void {
    if (mounted) return;
    mounted = true;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
    }
    refresh();
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    // 判定/任务状态变化即重绘；无自起 rAF，遵循"store 订阅驱动"通信规则。
    // 仅在任务数组或测量记录变化时重绘：观测条件活跃期间进度值周期性变化，
    // 若对任意 store 变更全量重建会高频打断输入（焦点反复丢失，见 refresh 的焦点保护）。
    unsubscribes.push(
      store.subscribe((state, prev) => {
        if (state.tasks !== prev.tasks || state.measurements !== prev.measurements) refresh();
      }),
    );
    unsubscribes.push(store.on(TASK_EVENTS.JUDGED, () => refresh()));
    unsubscribes.push(store.on(TASK_EVENTS.COMPLETED, () => refresh()));
  }

  function dispose(): void {
    if (!mounted) return;
    mounted = false;
    for (const off of unsubscribes) off();
    unsubscribes.length = 0;
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.textContent = '';
  }

  return { mount, refresh, dispose };
}
