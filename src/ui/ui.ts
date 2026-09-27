/**
 * ============================================================
 * createUI —— 界面壳层实现（docs/SPEC.md §6.8 / §12 / §13）
 * ============================================================
 * 职责：五区面板布局与控件、面板折叠状态机、schema 驱动的参数控件、
 *       任务卡、仪器选择、播放控制、toast、二次确认、快捷键。
 *       加载态 / WebGL 降级 / 初始化容错在同目录
 *       loading.ts / fallback.ts / boot.ts（供集成工程师调用）。
 *
 * 边界铁律：不 import 任何兄弟 feature 模块运行时代码；只读写 store。
 *
 * 跨模块通道（SPEC §8 数据闭环的 UI 段，全部走 STORE_EVENTS 常量）：
 *   参数控件   → setState({params})           + emit(PARAMS_CHANGED)     → experiments 消费
 *   实验切换   → setState({experiment})       + emit(EXPERIMENT_CHANGED) → experiments 消费
 *   视角切换   → setState({view})             + emit(VIEW_CHANGED)       → render 消费
 *   叠加开关   → setState({overlays})         + emit(OVERLAYS_CHANGED)   → render 消费
 *   播放控制   → setState({playback})         + emit(PLAYBACK_CHANGED)   → 时钟同步方消费
 *   仪器选择   → setState({activeInstrument}) + emit(INSTRUMENT_CHANGED) → instruments 消费
 *
 * DOM CustomEvent（在本模块创建的槽位元素上派发、可冒泡；供集成工程师接线）：
 *   'wave:reset-request'（playbackBar）→ 集成工程师调用 experiments.reset()（清测量 + 重 configure）
 *   'wave:report-export'（playbackBar）→ 集成工程师调用 report 生成并下载 Markdown
 *   'wave:share-card'   （playbackBar）→ 集成工程师生成实验分享卡片 PNG 并下载
 *
 * 预生成素材（SPEC §6.6/§11）：AI 导师模块已废弃，教学引导改为验收过的
 * 预生成语音/图片/视频（public/assets/，经本目录 media.ts 接入）——
 * 任务卡「语音引导」播 task_*.wav；右下角「学习资源」浮窗播 knowledge_*.wav
 * 与重看开场短片；任务一/五卡内嵌现象配图。
 *
 * 可选依赖（additive 扩展，向后兼容）：UIDeps.clock ——
 * 注入后底栏显示真实仿真时间（clock.onStep 驱动，不另起 rAF），
 * 暂停 / 倍速 / 重置直接作用于时钟；不注入时时间显示占位符，播放控制仍写 store 并 emit。
 * 该字段是 ui.ts 契约的唯一扩展点，已提请总架构师在 SPEC §6.8 补记。
 *
 * 布局模型（SPEC §12）：3D 视口铺满底层（layout.center 归渲染层，本模块不碰），
 * 五区面板以悬浮半透明层叠加；面板均可折叠，折叠后视口无遮挡。
 */
import { DEFAULT_SIM_STATE, STORE_EVENTS } from '../core/constants';
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type {
  ExperimentId,
  InstrumentKind,
  MeasurementRecord,
  OverlayState,
  PlaybackState,
  SimParams,
  SimState,
  TaskProgress,
  TimeScale,
  ViewKind,
  QualityLevel,
} from '../core/types';
import { computeLayoutMode } from './logic/breakpoints';
import type { LayoutMode } from './logic/breakpoints';
import { formatMetric, formatSimTime } from './logic/format';
import { initialPanelState, reducePanelAction } from './logic/panels';
import type { PanelId, PanelUIState, RightTab } from './logic/panels';
import {
  applyParamPath,
  buildParamSchema,
  clampFieldValue,
  readParamPath,
  stepDecimals,
} from './logic/paramSchema';
import type { ParamField, ParamGroup } from './logic/paramSchema';
import { confirmDialog } from './confirm';
import { showToast } from './toast';
import {
  CASE_GALLERY,
  CASE_VIDEOS,
  guideVoiceSrc,
  knowledgeVoiceSrc,
  playVoice,
  showCaseVideo,
  showGalleryImage,
  showIntroOverlay,
} from './media';
import { toggleQuality } from './logic/quality';

/** 五区布局容器（集成工程师从 index.html 取 DOM 后注入） */
export interface UILayout {
  topbar: HTMLElement;
  left: HTMLElement;
  center: HTMLElement;
  right: HTMLElement;
  bottom: HTMLElement;
}

/** 各功能面板的挂载点：集成工程师把它们分发给 charts/instruments 等工厂 */
export interface UIResourceSlots {
  taskCards: HTMLElement;
  paramPanel: HTMLElement;
  instrumentPanel: HTMLElement;
  dataPanel: HTMLElement;
  /** 学习资源浮窗内容槽（知识点语音按钮已内建，集成方可选挂额外素材入口） */
  mediaPanel: HTMLElement;
  playbackBar: HTMLElement;
}

export interface UIDeps {
  layout: UILayout;
  store: Store<SimState>;
  /**
   * [可选，additive] 仿真时钟。注入后：底栏显示真实仿真时间（clock.onStep 驱动）、
   * 暂停/倍速/重置直接作用于时钟。不注入则时间显示占位符，播放控制仍走 store 事件。
   */
  clock?: SimClock;
}

export interface UI {
  mount(): void;
  /** 返回功能面板挂载点（mount 后调用） */
  getSlots(): UIResourceSlots;
  dispose(): void;
  /** 回写画质档位显示（底栏按钮态；事件接线与自动降档后由集成工程师调用） */
  setQualityLevel(level: QualityLevel): void;
}

// ========== 常量（展示层文案与顺序） ==========

/** 本模块定义的 DOM CustomEvent 名（供集成工程师接线，见文件头说明） */
const UI_EVENT_RESET = 'wave:reset-request';
/** 底栏画质开关（低配模式）：detail { level: QualityLevel }，集成工程师调 renderer.setQuality */
const UI_EVENT_QUALITY = 'wave:quality-change';
const UI_EVENT_REPORT = 'wave:report-export';
const UI_EVENT_SHARE = 'wave:share-card';

const EXPERIMENT_ORDER: readonly ExperimentId[] = ['wind', 'interference', 'spectrum'];
const EXPERIMENT_SHORT: Record<ExperimentId, string> = {
  wind: '实验一',
  interference: '实验二',
  spectrum: '实验三',
};
const EXPERIMENT_DESC: Record<ExperimentId, string> = {
  wind: '风浪生成机制',
  interference: '双造波机叠加',
  spectrum: '不规则随机海况',
};
const EXPERIMENT_LABELS: Record<ExperimentId, string> = {
  wind: '实验一 · 风浪生成机制',
  interference: '实验二 · 双造波机叠加',
  spectrum: '实验三 · 不规则随机海况',
};

const VIEW_ORDER: readonly ViewKind[] = ['sea-surface', 'side-section', 'underwater'];
const VIEW_SHORT: Record<ViewKind, string> = {
  'sea-surface': '海面',
  'side-section': '剖面',
  underwater: '水下',
};
const VIEW_FULL: Record<ViewKind, string> = {
  'sea-surface': '海面视角',
  'side-section': '侧视剖面',
  underwater: '水下视角',
};

const RIGHT_TABS: readonly (readonly [RightTab, string])[] = [
  ['params', '参数'],
  ['instruments', '仪器'],
  ['data', '数据'],
];
const RIGHT_TAB_LABELS: Record<RightTab, string> = {
  params: '参数',
  instruments: '仪器',
  data: '数据',
};

// 仪器切换按钮由仪器模块面板统一渲染（runtime.ts buildPanel），
// 此处不再重复渲染一组（曾导致同屏 6 个切换按钮）；仅保留工具名标签。
const INSTRUMENT_LABELS: Record<InstrumentKind, string> = {
  'wave-ruler': '波高尺',
  stopwatch: '秒表',
  'drifter-buoy': '随浪浮标',
};

/** 测量记录键名 → 中文标签（键名约定见 SPEC §10；未知键名原样展示） */
const MEASUREMENT_KEY_LABELS: Record<string, string> = {
  eta: 'η',
  waveHeight: '波高',
  period: '周期',
  beatingPeriod: '拍周期',
};

/** 模型说明表（SPEC §13 v0.2 升级后清单，文案与 src/physics/MODELS.md §1 同步） */
const MODEL_NOTE_ROWS: readonly (readonly [string, string, string])[] = [
  ['波形叠加', '实验一/三线性 Airy；实验二 Gerstner 一阶陡度修饰（q·k·a ≤ 0.3）', '小振幅波理论（线性波）+ 规则波陡度修饰'],
  ['色散关系', '全水深 ω² = g·k·tanh(kh)（数值反解 k）', '线性波色散（深水→浅水连续过渡）'],
  ['风浪成长', 'SPM/JONSWAP 幂律：风时/风区限制取小 + 充分发展封顶', '教学经验成长公式（SPM/JONSWAP 简化）'],
  ['谱模型', 'PM 标准；JONSWAP 教学版（省略归一化系数项）', 'JONSWAP 教学版（风区决定谱峰位置）'],
  ['谱离散', '48 分量：0.5fp–4fp 频箱 + cos² 方向分布（固定种子）', '有限频带离散 + 窄方向分布'],
  ['白帽强度', '局部陡度 + 风速门控加权的教学指标', '经验强度指标 0–1（非实测覆盖率）'],
  ['质点轨迹', '深水圆 / 有限水深椭圆（一阶）', '一阶（线性）轨迹'],
  ['理论海况', '成长公式解析值 / 波分量离散求和', '数值离散估计'],
];

// ========== 小工具 ==========

interface ElInit {
  className?: string;
  text?: string;
  title?: string;
  ariaLabel?: string;
  dataset?: Readonly<Record<string, string>>;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  init: ElInit = {},
  ...children: Array<Node | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (init.className) node.className = init.className;
  if (init.text !== undefined) node.textContent = init.text;
  if (init.title !== undefined) node.title = init.title;
  if (init.ariaLabel !== undefined) node.setAttribute('aria-label', init.ariaLabel);
  if (init.dataset) {
    for (const [key, value] of Object.entries(init.dataset)) node.dataset[key] = value;
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function dispatchUiEvent(target: EventTarget, eventName: string, detail: unknown): void {
  target.dispatchEvent(new CustomEvent(eventName, { detail, bubbles: true, composed: true }));
}

function checkRow(label: string, hint?: string): { row: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'ui-check';
  const row = document.createElement('label');
  row.className = 'ui-field ui-field--checkbox';
  row.append(
    el(
      'span',
      { className: 'ui-field__row' },
      el('span', { className: 'ui-field__label', text: label }),
      el('span', { className: 'ui-spacer' }),
      input,
    ),
  );
  if (hint) row.appendChild(el('span', { className: 'ui-hint', text: hint }));
  return { row, input };
}

function buildModelNote(): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'ui-model-note';
  const summary = document.createElement('summary');
  summary.textContent = '模型说明（教学简化声明）';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const heading of ['模型', '教学简化', '学生可见声明']) {
    headRow.appendChild(el('th', { text: heading }));
  }
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  for (const [model, simplified, statement] of MODEL_NOTE_ROWS) {
    const tr = document.createElement('tr');
    for (const cell of [model, simplified, statement]) tr.appendChild(el('td', { text: cell }));
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  details.append(summary, table);
  return details;
}

// ========== 主工厂 ==========

export function createUI(deps: UIDeps): UI {
  const { layout, store } = deps;
  const clock = deps.clock ?? null;

  // 槽位元素：构造期即创建（getSlots 任何时刻可用），mount 时挂入各区
  // 任务交互面板宿主：集成工程师（main.ts）把任务闭环面板挂进来。
  // 壳层不再渲染静态摘要任务卡（曾与交互面板重复展示同一进度）。
  const taskCards = el('div', { className: 'ui-task-loop-host' });
  const paramPanel = el('div', { className: 'ui-params' });
  const instrumentPanel = el('div', {
    className: 'ui-slot ui-slot--instrument',
    ariaLabel: '仪器面板挂载点',
  });
  const dataPanel = el('div', { className: 'ui-slot ui-slot--data', ariaLabel: '图表挂载点' });
  const mediaPanel = el('div', { className: 'ui-media__body ui-slot', ariaLabel: '学习资源挂载点' });
  const playbackBar = el('div', { className: 'ui-playback' });

  let mounted = false;
  let disposed = false;

  let mode: LayoutMode = computeLayoutMode(window.innerWidth);
  let panelState: PanelUIState = initialPanelState(mode);

  let unsubscribeStore: (() => void) | null = null;
  let unsubscribeClock: (() => void) | null = null;
  let onResize: (() => void) | null = null;
  let onKeydown: ((event: KeyboardEvent) => void) | null = null;
  let mediaRoot: HTMLElement | null = null;
  let railLeft: HTMLElement | null = null;
  let railRight: HTMLElement | null = null;

  function applyPanelChrome(): void {
    document.body.dataset.uiMode = mode;
    layout.left.classList.toggle('is-collapsed', panelState.collapsed.left);
    layout.right.classList.toggle('is-collapsed', panelState.collapsed.right);
    mediaRoot?.classList.toggle('is-collapsed', panelState.collapsed.media);
    if (railLeft) railLeft.hidden = !panelState.collapsed.left;
    if (railRight) railRight.hidden = !panelState.collapsed.right;
  }

  function togglePanel(panel: PanelId): void {
    panelState = reducePanelAction(panelState, { type: 'toggle-panel', panel });
    applyPanelChrome();
  }

  function openPanel(panel: PanelId): void {
    panelState = reducePanelAction(panelState, { type: 'open-panel', panel });
    applyPanelChrome();
  }

  function mount(): void {
    if (mounted || disposed) return;
    mounted = true;

    // ---------- 顶栏：标题 / 实验 tab / 任务进度点 / 视角切换 ----------
    if (!layout.topbar.querySelector('.app-title')) {
      const title = el('h1', { className: 'app-title', text: '海水运动的基本方程' });
      title.appendChild(el('span', { text: '海浪动力学虚拟探索实验' }));
      layout.topbar.appendChild(title);
    }

    let tabsNav = layout.topbar.querySelector<HTMLElement>('#experiment-tabs');
    if (!tabsNav) {
      tabsNav = el('nav', { ariaLabel: '实验切换' });
      tabsNav.id = 'experiment-tabs';
      layout.topbar.appendChild(tabsNav);
    }
    tabsNav.replaceChildren();
    const expTabButtons = new Map<ExperimentId, HTMLButtonElement>();
    for (const id of EXPERIMENT_ORDER) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-tab-exp';
      btn.title = EXPERIMENT_LABELS[id];
      btn.appendChild(document.createTextNode(EXPERIMENT_SHORT[id]));
      btn.appendChild(el('span', { className: 'ui-tab-desc', text: EXPERIMENT_DESC[id] }));
      btn.addEventListener('click', () => setExperiment(id));
      expTabButtons.set(id, btn);
      tabsNav.appendChild(btn);
    }

    let dotsCandidate = layout.topbar.querySelector<HTMLElement>('#task-progress');
    if (!dotsCandidate) {
      dotsCandidate = el('div', { ariaLabel: '任务进度' });
      dotsCandidate.id = 'task-progress';
      layout.topbar.appendChild(dotsCandidate);
    }
    // 绑定为 const：renderProgressDots 闭包内保持非空收窄
    const dotsBox: HTMLElement = dotsCandidate;
    dotsBox.replaceChildren();

    let viewBox = layout.topbar.querySelector<HTMLElement>('#view-switch');
    if (!viewBox) {
      viewBox = el('div', { ariaLabel: '视角切换' });
      viewBox.id = 'view-switch';
      layout.topbar.appendChild(viewBox);
    }
    viewBox.replaceChildren();
    const viewButtons = new Map<ViewKind, HTMLButtonElement>();
    for (const view of VIEW_ORDER) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-btn-view';
      btn.textContent = VIEW_SHORT[view];
      btn.title = VIEW_FULL[view];
      btn.addEventListener('click', () => setView(view));
      viewButtons.set(view, btn);
      viewBox.appendChild(btn);
    }

    // ---------- 左栏：科研任务 ----------
    layout.left.replaceChildren();
    const taskCount = el('span', { className: 'ui-badge ui-badge--count', text: '0/6' });
    const collapseLeft = document.createElement('button');
    collapseLeft.type = 'button';
    collapseLeft.className = 'ui-btn-collapse';
    collapseLeft.textContent = '‹';
    collapseLeft.title = '收起任务栏';
    collapseLeft.addEventListener('click', () => togglePanel('left'));
    layout.left.append(
      el(
        'div',
        { className: 'ui-panelbar' },
        el('span', { className: 'ui-panelbar__title', text: '科研任务' }),
        el('span', { className: 'ui-spacer' }),
        taskCount,
        collapseLeft,
      ),
      taskCards,
    );

    // ---------- 右栏：参数 / 仪器 / 数据 三 tab ----------
    layout.right.replaceChildren();
    const rightTabButtons = new Map<RightTab, HTMLButtonElement>();
    const tabBar = el('div', { className: 'ui-panelbar ui-tabs' });
    tabBar.setAttribute('role', 'tablist');
    for (const [tab, label] of RIGHT_TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-tab';
      btn.textContent = label;
      btn.setAttribute('role', 'tab');
      btn.addEventListener('click', () => selectTab(tab));
      rightTabButtons.set(tab, btn);
      tabBar.appendChild(btn);
    }
    const collapseRight = document.createElement('button');
    collapseRight.type = 'button';
    collapseRight.className = 'ui-btn-collapse';
    collapseRight.textContent = '›';
    collapseRight.title = '收起面板';
    collapseRight.addEventListener('click', () => togglePanel('right'));
    tabBar.append(el('span', { className: 'ui-spacer' }), collapseRight);

    const rightPages: Record<RightTab, HTMLElement> = {
      params: el('div', { className: 'ui-tabpage', dataset: { tab: 'params' } }),
      instruments: el('div', { className: 'ui-tabpage', dataset: { tab: 'instruments' } }),
      data: el('div', { className: 'ui-tabpage', dataset: { tab: 'data' } }),
    };
    rightPages.params.append(paramPanel);

    const mysteryNote = el('p', {
      className: 'ui-mystery-note',
      text: '未知海况模式已开启：理论海况值已隐藏，请用仪器实测。',
    });
    mysteryNote.hidden = true;
    // 仪器切换按钮在 instrumentPanel 内部（仪器模块渲染），本 tab 页不再重复一组
    rightPages.instruments.append(
      mysteryNote,
      el('p', { className: 'ui-hint', text: '读数与记录由仪器模块渲染在下方；再次点击按钮取消激活。' }),
      instrumentPanel,
    );

    const probeValue = el('span', { className: 'ui-mono' });
    const probeLine = el('div', { className: 'ui-probe' });
    probeLine.append(document.createTextNode('探针位置　'), probeValue);
    const ulMeasures = document.createElement('ul');
    ulMeasures.className = 'ui-measures';
    rightPages.data.append(
      probeLine,
      dataPanel,
      el('div', { className: 'ui-group-title', text: '测量记录' }),
      ulMeasures,
      buildModelNote(),
    );

    layout.right.append(tabBar, rightPages.params, rightPages.instruments, rightPages.data);

    function selectTab(tab: RightTab): void {
      panelState = reducePanelAction(panelState, { type: 'select-tab', tab });
      for (const [key, btn] of rightTabButtons) {
        const active = key === panelState.rightTab;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      }
      for (const key of Object.keys(rightPages) as RightTab[]) {
        rightPages[key].classList.toggle('is-active', key === panelState.rightTab);
      }
      if (railRight) railRight.textContent = RIGHT_TAB_LABELS[panelState.rightTab];
    }

    // ---------- 底栏：播放控制 ----------
    layout.bottom.replaceChildren();
    const btnPause = document.createElement('button');
    btnPause.type = 'button';
    btnPause.className = 'ui-btn-pause';
    btnPause.addEventListener('click', () => togglePause());

    const btnScale1 = document.createElement('button');
    btnScale1.type = 'button';
    btnScale1.className = 'ui-btn-scale';
    btnScale1.textContent = '1x';
    btnScale1.title = '1 倍速';
    btnScale1.addEventListener('click', () => setScale(1));

    const btnScale2 = document.createElement('button');
    btnScale2.type = 'button';
    btnScale2.className = 'ui-btn-scale';
    btnScale2.textContent = '2x';
    btnScale2.title = '2 倍速';
    btnScale2.addEventListener('click', () => setScale(2));

    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'ui-btn-reset';
    btnReset.textContent = '重置';
    btnReset.addEventListener('click', () => {
      void onResetClicked();
    });

    const timeValue = el('span', { className: 'ui-mono', text: '00:00' });
    const timeBox = el('span', { className: 'ui-sim-time', title: '实验时间（仿真时钟）' });
    timeBox.append(document.createTextNode('实验时间 '), timeValue);

    const btnReport = document.createElement('button');
    btnReport.type = 'button';
    btnReport.className = 'ui-btn-report';
    btnReport.textContent = '导出报告';
    btnReport.title = '生成 Markdown 实验报告（由数据层导出）';
    btnReport.addEventListener('click', () => {
      dispatchUiEvent(playbackBar, UI_EVENT_REPORT, { experiment: store.getState().experiment });
      showToast('已请求导出实验报告（由数据层生成）', 'info');
    });

    const btnShare = document.createElement('button');
    btnShare.type = 'button';
    btnShare.className = 'ui-btn-report';
    btnShare.textContent = '分享卡片';
    btnShare.title = '生成实验分享卡片图片（PNG，share-card 底图 + 当前读数）';
    btnShare.addEventListener('click', () => {
      dispatchUiEvent(playbackBar, UI_EVENT_SHARE, { experiment: store.getState().experiment });
    });

    const btnQuality = document.createElement('button');
    btnQuality.type = 'button';
    btnQuality.className = 'ui-btn-quality';
    btnQuality.textContent = '流畅模式';
    btnQuality.title = '切换到流畅模式（降低画质提升帧率，物理与读数不变）';
    btnQuality.setAttribute('aria-pressed', 'false');
    btnQuality.addEventListener('click', () => {
      const next = toggleQuality(qualityLevel);
      dispatchUiEvent(playbackBar, UI_EVENT_QUALITY, { level: next });
    });

    playbackBar.append(btnPause, btnScale1, btnScale2, btnReset, timeBox, btnQuality, btnReport, btnShare);
    layout.bottom.append(playbackBar);

    // ---------- 学习资源浮窗（右下角呼出：知识点语音 + 开场短片重看） ----------
    // AI 导师模块废弃后改为预生成素材入口（SPEC §6.6/§11）；按钮直接播
    // public/assets 的 knowledge_*.wav，不依赖任何在线服务。
    mediaRoot = el('div', { className: 'ui-media' });
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'ui-media__launcher';
    launcher.textContent = '学习资源';
    launcher.title = '知识点语音与开场短片';
    launcher.addEventListener('click', () => openPanel('media'));
    const mediaCollapse = document.createElement('button');
    mediaCollapse.type = 'button';
    mediaCollapse.className = 'ui-btn-collapse';
    mediaCollapse.textContent = '—';
    mediaCollapse.title = '收起学习资源';
    mediaCollapse.addEventListener('click', () => togglePanel('media'));

    // 分组按钮构造器：每组一个小标题 + 纵排语音按钮
    const group = (label: string): { box: HTMLDivElement; list: HTMLDivElement } => {
      const box = el('div', { className: 'ui-media__group' });
      box.appendChild(el('p', { className: 'ui-media__group-title', text: label }));
      const list = el('div', { className: 'ui-media__list' });
      box.appendChild(list);
      return { box, list };
    };
    const voiceBtn = (text: string, title: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-btn-voice';
      btn.textContent = text;
      btn.title = title;
      btn.addEventListener('click', onClick);
      return btn;
    };

    const knowledgeGroup = group('知识点语音');
    for (const id of EXPERIMENT_ORDER) {
      knowledgeGroup.list.appendChild(
        voiceBtn(
          `${EXPERIMENT_SHORT[id]}知识点 · ${EXPERIMENT_DESC[id]}`,
          '播放本实验知识点语音讲解（预生成素材）',
          () => playVoice(knowledgeVoiceSrc(id)),
        ),
      );
    }

    const guideGroup = group('仪器教程与操作指南');
    guideGroup.list.appendChild(
      voiceBtn('波高尺怎么用', '播放波高尺使用教程', () => playVoice(guideVoiceSrc('ruler'))),
    );
    guideGroup.list.appendChild(
      voiceBtn('秒表怎么用', '播放秒表使用教程', () => playVoice(guideVoiceSrc('stopwatch'))),
    );
    guideGroup.list.appendChild(
      voiceBtn('浮标怎么用', '播放虚拟浮标使用教程', () => playVoice(guideVoiceSrc('buoy'))),
    );
    guideGroup.list.appendChild(
      voiceBtn('三个视角怎么看', '播放三视角介绍', () => playVoice(guideVoiceSrc('views'))),
    );
    guideGroup.list.appendChild(
      voiceBtn('示踪粒子与冻结波形', '播放示踪粒子教学', () => playVoice(guideVoiceSrc('tracer'))),
    );
    guideGroup.list.appendChild(
      voiceBtn('实验报告与分享', '播放报告导出说明', () => playVoice(guideVoiceSrc('report'))),
    );

    const videoGroup = group('真实海况实拍（含环境声）');
    for (const item of Object.values(CASE_VIDEOS)) {
      videoGroup.list.appendChild(
        voiceBtn(item.title, '播放实拍案例视频', () => showCaseVideo(item.title, item.src)),
      );
    }

    const galleryGroup = group('海况图鉴');
    for (const item of Object.values(CASE_GALLERY)) {
      galleryGroup.list.appendChild(
        voiceBtn(item.title, '查看大图', () => showGalleryImage(item.title, item.src)),
      );
    }

    const replayIntro = document.createElement('button');
    replayIntro.type = 'button';
    replayIntro.className = 'ui-btn-voice';
    replayIntro.textContent = '重看开场短片';
    replayIntro.title = '重新播放开场短片（可随时跳过）';
    replayIntro.addEventListener('click', () => showIntroOverlay());

    mediaPanel.replaceChildren(
      el('p', {
        className: 'ui-hint',
        text: '预生成教学素材：语音讲解、真实海况实拍与图鉴，点击即用，无需联网。',
      }),
      knowledgeGroup.box,
      guideGroup.box,
      videoGroup.box,
      galleryGroup.box,
      replayIntro,
    );

    const mediaWin = el(
      'div',
      { className: 'ui-media__win' },
      el(
        'div',
        { className: 'ui-panelbar' },
        el('span', { className: 'ui-panelbar__title', text: '学习资源' }),
        el('span', { className: 'ui-spacer' }),
        mediaCollapse,
      ),
      mediaPanel,
    );
    mediaRoot.append(mediaWin, launcher);
    document.body.appendChild(mediaRoot);

    // ---------- 折叠后的边缘唤起钮（rail） ----------
    const railLeftBtn = document.createElement('button');
    railLeftBtn.type = 'button';
    railLeftBtn.className = 'ui-rail ui-rail--left';
    railLeftBtn.textContent = '科研任务';
    railLeftBtn.title = '展开任务栏';
    railLeftBtn.hidden = true;
    railLeftBtn.addEventListener('click', () => openPanel('left'));
    railLeft = railLeftBtn;

    const railRightBtn = document.createElement('button');
    railRightBtn.type = 'button';
    railRightBtn.className = 'ui-rail ui-rail--right';
    railRightBtn.textContent = RIGHT_TAB_LABELS[panelState.rightTab];
    railRightBtn.title = '展开参数 / 仪器 / 数据面板';
    railRightBtn.hidden = true;
    railRightBtn.addEventListener('click', () => openPanel('right'));
    railRight = railRightBtn;
    document.body.append(railLeftBtn, railRightBtn);

    // ---------- 参数控件渲染（schema 驱动） ----------
    interface ControlBundle {
      field: ParamField;
      range?: HTMLInputElement;
      num?: HTMLInputElement;
      select?: HTMLSelectElement;
      check?: HTMLInputElement;
    }
    const controlsByPath = new Map<string, ControlBundle>();
    let trailCheck: HTMLInputElement | null = null;
    let freezeCheck: HTMLInputElement | null = null;

    function labelWithUnit(field: ParamField): string {
      return field.unit ? `${field.label}（${field.unit}）` : field.label;
    }

    function commitParam(field: ParamField, raw: string | boolean): void {
      if (field.kind === 'checkbox') {
        writeParam(field.path, Boolean(raw));
        return;
      }
      if (field.kind === 'select') {
        writeParam(field.path, String(raw));
        return;
      }
      writeParam(field.path, clampFieldValue(field, Number(raw)));
    }

    function buildFieldRow(field: ParamField): HTMLElement {
      if (field.kind === 'checkbox') {
        const { row, input } = checkRow(field.label, field.hint);
        input.addEventListener('change', () => commitParam(field, input.checked));
        controlsByPath.set(field.path, { field, check: input });
        return row;
      }

      const row = el('div', { className: `ui-field ui-field--${field.kind}` });
      const top = el(
        'div',
        { className: 'ui-field__row' },
        el('span', { className: 'ui-field__label', text: labelWithUnit(field) }),
      );

      if (field.kind === 'select') {
        const select = document.createElement('select');
        select.className = 'ui-select';
        for (const option of field.options ?? []) {
          const opt = document.createElement('option');
          opt.value = option.value;
          opt.textContent = option.label;
          select.appendChild(opt);
        }
        select.addEventListener('change', () => commitParam(field, select.value));
        top.appendChild(select);
        controlsByPath.set(field.path, { field, select });
        row.append(top);
      } else {
        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'ui-num';
        if (field.min !== undefined) num.min = String(field.min);
        if (field.max !== undefined) num.max = String(field.max);
        if (field.step !== undefined) num.step = String(field.step);
        num.addEventListener('change', () => commitParam(field, num.value));
        top.appendChild(num);

        const bundle: ControlBundle = { field, num };
        if (field.kind === 'slider') {
          const range = document.createElement('input');
          range.type = 'range';
          range.className = 'ui-range';
          if (field.min !== undefined) range.min = String(field.min);
          if (field.max !== undefined) range.max = String(field.max);
          if (field.step !== undefined) range.step = String(field.step);
          range.addEventListener('input', () => commitParam(field, range.value));
          bundle.range = range;
          row.append(top, range);
        } else {
          row.append(top);
        }
        controlsByPath.set(field.path, bundle);
      }

      if (field.hint) row.appendChild(el('span', { className: 'ui-hint', text: field.hint }));
      return row;
    }

    function buildOverlaySection(): HTMLElement {
      const box = el('div', {});
      box.appendChild(el('div', { className: 'ui-group-title', text: '显示叠加' }));
      const trail = checkRow('示踪轨迹（水质点运动）');
      trail.input.addEventListener('change', () => setOverlay('showTrails', trail.input.checked));
      const freeze = checkRow('冻结波形（形态定格、时间继续）');
      freeze.input.addEventListener('change', () =>
        setOverlay('freezeWaveform', freeze.input.checked),
      );
      trailCheck = trail.input;
      freezeCheck = freeze.input;
      box.append(trail.row, freeze.row);
      return box;
    }

    function renderParamPanel(state: SimState): void {
      controlsByPath.clear();
      paramPanel.replaceChildren();
      const groups: readonly ParamGroup[] = buildParamSchema(state.experiment);
      for (const group of groups) {
        paramPanel.appendChild(el('div', { className: 'ui-group-title', text: group.title }));
        for (const field of group.fields) paramPanel.appendChild(buildFieldRow(field));
      }
      paramPanel.appendChild(buildOverlaySection());
      syncParamControls(state.params);
    }

    function syncParamControls(params: SimParams): void {
      for (const bundle of controlsByPath.values()) {
        let value: number | string | boolean;
        try {
          value = readParamPath(params, bundle.field.path);
        } catch {
          continue;
        }
        if (bundle.field.kind === 'checkbox') {
          if (bundle.check) bundle.check.checked = value === true;
          continue;
        }
        if (typeof value === 'boolean') continue;
        if (bundle.field.kind === 'select') {
          if (bundle.select) bundle.select.value = String(value);
          continue;
        }
        if (typeof value !== 'number') continue;
        if (bundle.range) bundle.range.value = String(value);
        if (bundle.num && document.activeElement !== bundle.num) {
          bundle.num.value = bundle.field.integer
            ? String(Math.round(value))
            : value.toFixed(stepDecimals(bundle.field.step));
        }
      }
    }

    // ---------- store 写入 + 事件（数据闭环 UI 段） ----------
    function writeParam(path: string, value: number | string | boolean): void {
      const state = store.getState();
      const nextParams = applyParamPath(state.params, path, value);
      store.setState({ params: nextParams });
      store.emit(STORE_EVENTS.PARAMS_CHANGED, { path, value });
    }

    function setExperiment(id: ExperimentId): void {
      if (store.getState().experiment === id) return;
      store.setState({ experiment: id });
      // payload 形状与 experiments/engine.ts 的 emit 保持一致（{ experiment }）
      store.emit(STORE_EVENTS.EXPERIMENT_CHANGED, { experiment: id });
    }

    function setView(view: ViewKind): void {
      if (store.getState().view === view) return;
      store.setState({ view });
      store.emit(STORE_EVENTS.VIEW_CHANGED, view);
    }

    function setOverlay(key: keyof OverlayState, value: boolean): void {
      const current = store.getState().overlays;
      const next = { ...current, [key]: value } as OverlayState;
      store.setState({ overlays: next });
      store.emit(STORE_EVENTS.OVERLAYS_CHANGED, next);
    }

    function applyPlayback(next: PlaybackState): void {
      store.setState({ playback: next });
      store.emit(STORE_EVENTS.PLAYBACK_CHANGED, next);
      // clock 为可选注入：注入时直接作用（与集成侧的事件同步幂等）
      if (clock) {
        if (next.paused) clock.pause();
        else clock.resume();
        clock.setScale(next.scale);
      }
    }

    function togglePause(): void {
      const current = store.getState().playback;
      applyPlayback({ paused: !current.paused, scale: current.scale });
    }

    function setScale(scale: TimeScale): void {
      const current = store.getState().playback;
      applyPlayback({ paused: current.paused, scale });
    }

    async function onResetClicked(): Promise<void> {
      const ok = await confirmDialog({
        title: '重置当前实验',
        message:
          '将恢复默认参数、仿真时间归零；测量记录由实验层在重置流程中清空。确认重置？',
        confirmText: '确认重置',
        cancelText: '取消',
        danger: true,
      });
      if (!ok) return;
      const defaults = JSON.parse(JSON.stringify(DEFAULT_SIM_STATE.params)) as SimParams;
      store.setState({ params: defaults, playback: { paused: false, scale: 1 } });
      store.emit(STORE_EVENTS.PARAMS_CHANGED, { reason: 'reset' });
      store.emit(STORE_EVENTS.PLAYBACK_CHANGED, { paused: false, scale: 1 });
      clock?.reset();
      dispatchUiEvent(playbackBar, UI_EVENT_RESET, { experiment: store.getState().experiment });
      showToast('已恢复默认参数，仿真时间归零', 'success');
    }

    // ---------- 各区域同步渲染 ----------
    function syncExperimentTabs(experiment: ExperimentId): void {
      for (const [id, btn] of expTabButtons) {
        const active = id === experiment;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      }
    }

    function syncViewButtons(view: ViewKind): void {
      for (const [id, btn] of viewButtons) {
        const active = id === view;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      }
    }

    function syncPlayback(state: SimState): void {
      btnPause.textContent = state.playback.paused ? '继续' : '暂停';
      btnPause.setAttribute('aria-pressed', String(!state.playback.paused));
      btnPause.title = state.playback.paused ? '继续仿真（空格）' : '暂停仿真（空格）';
      btnScale1.classList.toggle('is-active', state.playback.scale === 1);
      btnScale1.setAttribute('aria-pressed', String(state.playback.scale === 1));
      btnScale2.classList.toggle('is-active', state.playback.scale === 2);
      btnScale2.setAttribute('aria-pressed', String(state.playback.scale === 2));
    }

    function syncOverlays(overlays: OverlayState): void {
      if (trailCheck) trailCheck.checked = overlays.showTrails;
      if (freezeCheck) freezeCheck.checked = overlays.freezeWaveform;
    }

    function syncProbe(probe: { x: number; y: number }): void {
      probeValue.textContent = `x = ${formatMetric(probe.x, 1)} m　y = ${formatMetric(probe.y, 1)} m`;
    }

    function syncMysteryNotice(state: SimState): void {
      mysteryNote.hidden = !(state.experiment === 'spectrum' && state.params.spectrum.mystery);
    }

    function renderProgressDots(tasks: readonly TaskProgress[]): void {
      const doneCount = tasks.filter((task) => task.done).length;
      taskCount.textContent = `${doneCount}/${tasks.length}`;
      dotsBox.replaceChildren();
      const current = tasks.find((task) => !task.done);
      for (const task of tasks) {
        const classes = ['ui-dot'];
        if (task.done) classes.push('is-done');
        if (task === current) classes.push('is-current');
        dotsBox.appendChild(
          el('span', {
            className: classes.join(' '),
            title: `${task.title}：${task.done ? '已完成' : `进度 ${Math.round(task.progress * 100)}%`}`,
          }),
        );
      }
    }

    function renderMeasurements(records: readonly MeasurementRecord[]): void {
      ulMeasures.replaceChildren();
      if (records.length === 0) {
        ulMeasures.appendChild(
          el('li', {
            className: 'ui-empty',
            text: '暂无测量记录——激活仪器并记录读数后显示在这里',
          }),
        );
        return;
      }
      for (const record of records.slice(-8).reverse()) {
        const head = el('div', { className: 'ui-measure__head' });
        head.append(
          el('span', { className: 'ui-mono', text: formatSimTime(record.simTime) }),
          el('span', { className: 'ui-measure__tool', text: INSTRUMENT_LABELS[record.tool] }),
        );
        const values = Object.entries(record.values)
          .map(([key, value]) => `${MEASUREMENT_KEY_LABELS[key] ?? key} ${formatMetric(value)}`)
          .join('　');
        ulMeasures.appendChild(
          el('li', { className: 'ui-measure' }, head, el('div', { className: 'ui-measure__values', text: values })),
        );
      }
    }

    // ---------- store 订阅（diff 驱动局部刷新） ----------
    interface UiSnapshot {
      experiment: ExperimentId;
      params: SimParams;
      paused: boolean;
      scale: TimeScale;
      view: ViewKind;
      showTrails: boolean;
      freezeWaveform: boolean;
      activeInstrument: InstrumentKind | null;
      tasks: readonly TaskProgress[];
      measurements: readonly MeasurementRecord[];
      probe: { x: number; y: number };
      mystery: boolean;
    }

    function takeSnapshot(state: SimState): UiSnapshot {
      return {
        experiment: state.experiment,
        params: state.params,
        paused: state.playback.paused,
        scale: state.playback.scale,
        view: state.view,
        showTrails: state.overlays.showTrails,
        freezeWaveform: state.overlays.freezeWaveform,
        activeInstrument: state.activeInstrument,
        tasks: state.tasks,
        measurements: state.measurements,
        probe: state.probe,
        mystery: state.params.spectrum.mystery,
      };
    }

    let lastSnapshot: UiSnapshot | null = null;

    function syncFromStore(state: SimState): void {
      const prev = lastSnapshot;
      const snap = takeSnapshot(state);
      lastSnapshot = snap;
      if (!prev) return;
      if (prev.experiment !== snap.experiment) {
        renderParamPanel(state);
        syncExperimentTabs(state.experiment);
      }
      if (prev.params !== snap.params) syncParamControls(state.params);
      if (prev.paused !== snap.paused || prev.scale !== snap.scale) syncPlayback(state);
      if (prev.view !== snap.view) syncViewButtons(state.view);
      if (prev.showTrails !== snap.showTrails || prev.freezeWaveform !== snap.freezeWaveform) {
        syncOverlays(state.overlays);
      }
      if (prev.tasks !== snap.tasks) {
        renderProgressDots(state.tasks);
      }
      if (prev.measurements !== snap.measurements) renderMeasurements(state.measurements);
      if (prev.probe !== snap.probe) syncProbe(state.probe);
      syncMysteryNotice(state);
    }

    // ---------- 快捷键 / 断点 / 仿真时间 ----------
    onKeydown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        togglePause();
        return;
      }
      if (event.key === 'Escape' && mode === 'compact') {
        if (!panelState.collapsed.left || !panelState.collapsed.right) {
          panelState = reducePanelAction(panelState, { type: 'set-mode', mode });
          applyPanelChrome();
          selectTab(panelState.rightTab);
        }
      }
    };
    document.addEventListener('keydown', onKeydown);

    onResize = (): void => {
      const nextMode = computeLayoutMode(window.innerWidth);
      if (nextMode === mode) return;
      mode = nextMode;
      panelState = reducePanelAction(panelState, { type: 'set-mode', mode });
      applyPanelChrome();
      selectTab(panelState.rightTab);
    };
    window.addEventListener('resize', onResize);

    if (clock) {
      let lastWritten = Number.NaN;
      unsubscribeClock = clock.onStep((simTime) => {
        if (Number.isNaN(lastWritten) || Math.abs(simTime - lastWritten) >= 0.2) {
          lastWritten = simTime;
          timeValue.textContent = formatSimTime(simTime);
        }
      });
    } else {
      timeValue.textContent = '—';
      timeValue.title = '集成注入 clock 后显示真实仿真时间';
    }

    // ---------- 首次渲染 + 订阅 ----------
    applyPanelChrome();
    selectTab(panelState.rightTab);
    const initial = store.getState();
    renderParamPanel(initial);
    renderProgressDots(initial.tasks);
    renderMeasurements(initial.measurements);
    syncPlayback(initial);
    syncViewButtons(initial.view);
    syncExperimentTabs(initial.experiment);
    syncOverlays(initial.overlays);
    syncProbe(initial.probe);
    syncMysteryNotice(initial);

    lastSnapshot = takeSnapshot(initial);
    unsubscribeStore = store.subscribe((state) => syncFromStore(state));
  }

  function getSlots(): UIResourceSlots {
    return {
      taskCards,
      paramPanel,
      instrumentPanel,
      dataPanel,
      mediaPanel,
      playbackBar,
    };
  }

  function dispose(): void {
    if (!mounted || disposed) return;
    disposed = true;
    unsubscribeStore?.();
    unsubscribeClock?.();
    if (onResize) window.removeEventListener('resize', onResize);
    if (onKeydown) document.removeEventListener('keydown', onKeydown);
    for (const container of [layout.topbar, layout.left, layout.right, layout.bottom]) {
      container.replaceChildren();
    }
    mediaRoot?.remove();
    railLeft?.remove();
    railRight?.remove();
    document.body.removeAttribute('data-ui-mode');
  }

  // ---------- 画质档位（低配模式）----------
  let qualityLevel: QualityLevel = 'high';
  /** 回写画质档位显示（底栏按钮态）。按钮在 mount 时创建，mount 后调用有效；
   *  自动降档与事件接线后由集成工程师调用，保证按钮态单一来源。 */
  function setQualityLevel(level: QualityLevel): void {
    qualityLevel = level;
    const btn = playbackBar.querySelector<HTMLButtonElement>('.ui-btn-quality');
    if (!btn) return;
    // 按钮显示"可切换到的目标档"
    btn.textContent = level === 'high' ? '流畅模式' : '高画质';
    btn.title = level === 'high'
      ? '切换到流畅模式（降低画质提升帧率，物理与读数不变）'
      : '切换到高画质模式';
    btn.setAttribute('aria-pressed', String(level === 'low'));
  }

  return { mount, getSlots, dispose, setQualityLevel };
}
