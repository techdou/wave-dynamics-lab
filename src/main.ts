/**
 * ============================================================
 * main.ts —— 唯一组装点（docs/SPEC.md §2 / §8，集成工程师 v0.2）
 * ============================================================
 * 装配顺序（依赖方向 main → 全部工厂，运行期模块间零 import）：
 *   store → clock → physics(waveField) → ui 壳对象（构造无副作用，先取槽位）
 *   → render → experiments → charts / instruments → tasks(+taskPanel) → report
 *   → 事件接线 → mount 全部 → renderer.start()（或无渲染时的时钟兜底驱动）
 *
 * 容错：每个模块 initStep try/catch —— 单模块失败 toast + 隐藏对应面板，
 * 其余模块继续挂载，不整页白屏（SPEC §12 / ui/boot.ts 约定）。
 *
 * 时钟：渲染主循环是唯一帧驱动（renderer 每帧 clock.advance）；
 *   WebGL 不可用（渲染层缺席）时由本文件启动一个仅推进时钟的兜底 rAF，
 *   保证 η(t)/仪器/任务等 2D 闭环继续可用（仍无 Second rAF 业务循环，SPEC §7.5）；
 *   暂停/倍速/重置经 PLAYBACK_CHANGED 同步到时钟（UI 注入 clock 后已直作用，
 *   此处订阅幂等兜底，覆盖其他直写 store 的路径）；页面隐藏自动暂停。
 *
 * 预生成素材（SPEC §6.6/§11，AI 导师模块已废弃）：
 *   - boot 加载屏以 hero-lab.png 为氛围底图（ui/loading.ts posterUrl）；
 *   - 就绪后一次性显示开场浮层：intro-ocean.mp4（静音自动播放、可跳过、
 *     加载失败静默回落主界面）；
 *   - 任务卡「语音引导」/「学习资源」浮窗的 knowledge_*.wav 播放由 ui.ts
 *     经 src/ui/media.ts 直接触发，无需本文件接线；
 *   - 底栏「分享卡片」→ 本文件生成 share-card.png 底图 PNG 并触发下载。
 *
 * 跨模块接线点（SPEC §7：main.ts 是唯一合法跨 feature 组装处）：
 *   'wave:reset-request'（playbackBar）→ experiments.reset()
 *   'wave:report-export'（playbackBar）→ report.download()
 *   'wave:share-card'    （playbackBar）→ ui/media.ts 生成分享卡片并下载
 *   'task:mystery-reroll'（store 事件） → experiments.controllers.spectrum.randomSeaState(seed)
 *   测量/参数/实验变更与固定步 → tasks.evaluate()（闭环「任务判定」段）
 */
import './styles/main.css';

import { createSimClock } from './core/clock';
import { DEFAULT_SIM_STATE, STORE_EVENTS } from './core/constants';
import { createStore } from './core/store';
import type { PlaybackState, SimState } from './core/types';
import { createWaveField } from './physics/waveField';
import { createRenderer } from './render/renderer';
import type { Renderer } from './render/renderer';
import { createExperiments } from './experiments/experiments';
import { createCharts } from './charts/charts';
import { createInstruments } from './instruments/instruments';
import { createTasks } from './tasks/tasks';
import { TASK_EVENTS } from './tasks/taskEvents';
import { createTaskPanel } from './tasks/taskPanel';
import type { TaskPanel } from './tasks/taskPanel';
import { createReport } from './data/report';
import { createUI } from './ui/ui';
import { initStep } from './ui/boot';
import { hideBootLoading, setBootStatus, showBootLoading } from './ui/loading';
import { detectWebGL, showWebGLUnavailablePage } from './ui/fallback';
import { showToast } from './ui/toast';
import {
  buildShareCard,
  downloadBlob,
  heroImageSrc,
  playVoice,
  showIntroOverlay,
  taskCaseImageSrc,
  taskVoiceSrc,
} from './ui/media';
import type { ExperimentId } from './core/types';

/** DOM 事件名（ui.ts 派发，见其文件头说明；常量未导出，此处按文档镜像） */
const UI_EVENT_RESET = 'wave:reset-request';
const UI_EVENT_REPORT = 'wave:report-export';
const UI_EVENT_SHARE = 'wave:share-card';

const EXPERIMENT_NAMES: Record<ExperimentId, string> = {
  wind: '实验一 · 风浪生成机制',
  interference: '实验二 · 双造波机叠加',
  spectrum: '实验三 · 不规则随机海况',
};

function requireElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少挂载节点 #${id}`);
  return node;
}

function main(): void {
  showBootLoading('正在初始化实验环境…', heroImageSrc());

  // ---------- 第 0 层 core：状态 / 时钟（失败即无法继续，硬中止） ----------
  setBootStatus('正在准备状态容器与仿真时钟…');
  const store = initStep('状态容器', () =>
    createStore<SimState>(structuredClone(DEFAULT_SIM_STATE)),
  );
  if (!store) {
    hideBootLoading();
    return;
  }
  const clock = initStep('仿真时钟', () => createSimClock());
  if (!clock) {
    hideBootLoading();
    return;
  }

  // ---------- L1 物理：波场数据接口 ----------
  setBootStatus('正在构建波场物理模型…');
  const waveField = initStep('物理波场', () => createWaveField());
  if (!waveField) {
    hideBootLoading();
    return;
  }

  // ---------- 壳层：UI 工厂构造（无副作用，槽位构造期即可用） ----------
  // 说明：charts/instruments/taskPanel 的挂载点来自 ui.getSlots()，故先构造 UI
  // 对象取槽位，再按依赖顺序装配其余模块；ui.mount() 仍在全部面板创建后调用。
  const ui = initStep('界面壳层', () =>
    createUI({
      layout: {
        topbar: requireElement('topbar'),
        left: requireElement('left-panel'),
        center: requireElement('viewport'),
        right: requireElement('right-panel'),
        bottom: requireElement('bottom-bar'),
      },
      store,
      clock,
    }),
  );
  if (!ui) {
    hideBootLoading();
    return; // 壳层失败 = 无面板可挂载，其余模块挂了也无处呈现
  }
  const slots = ui.getSlots();

  // ---------- L2 渲染（WebGL 不可用时降级说明页 + 时钟兜底驱动，不白屏） ----------
  setBootStatus('正在初始化三维渲染…');
  let renderer: Renderer | null = null;
  if (!detectWebGL()) {
    showWebGLUnavailablePage();
    showToast('三维渲染不可用，已显示原因与自助解法；其余功能继续可用', 'warn', 6000);
  } else {
    renderer = initStep('三维渲染', () =>
      createRenderer({ container: requireElement('viewport'), store, waveField, clock }),
    );
  }

  // ---------- L3 实验层（唯一 waveField.configure 调用方） ----------
  setBootStatus('正在装配实验流程…');
  const experiments = initStep('实验层', () => createExperiments({ store, waveField, clock }));
  if (!experiments) {
    // 无实验层 ⇒ 物理未被 configure，图表/仪器只能看到平静海面；给出明确提示
    showToast('实验层不可用：参数拖动不会驱动海面，请刷新重试', 'warn', 6000);
  }

  // ---------- L4 可视化：图表 + 虚拟仪器（均由 clock.onStep 驱动） ----------
  setBootStatus('正在挂载科学图表与虚拟仪器…');
  const charts = initStep('科学图表', () =>
    createCharts({ root: slots.dataPanel, store, waveField, clock }),
  );
  if (!charts) slots.dataPanel.style.display = 'none';

  const instruments = initStep('虚拟仪器', () =>
    createInstruments({ root: slots.instrumentPanel, store, waveField, clock }),
  );
  if (!instruments) slots.instrumentPanel.style.display = 'none';

  // ---------- 任务系统 + 交互面板（面板挂在左栏「科研任务」面板内，不再另设标题） ----------
  setBootStatus('正在装载科研任务…');
  const tasks = initStep('任务系统', () => createTasks({ store, waveField, clock }));
  let taskPanel: TaskPanel | null = null;
  let taskLoopBox: HTMLElement | null = null;
  if (tasks) {
    taskLoopBox = document.createElement('section');
    taskLoopBox.className = 'ui-task-loop';
    taskLoopBox.setAttribute('aria-label', '任务闭环（预测 / 实时判定项 / 提交结果）');
    const panelRoot = document.createElement('div');
    taskLoopBox.appendChild(panelRoot);
    taskPanel = initStep('任务面板', () =>
      createTaskPanel({
        root: panelRoot,
        store,
        tasks,
        // 预生成素材入口在装配期注入（跨 feature 引用只发生在 main.ts，SPEC §7.1）
        media: { caseImageSrc: taskCaseImageSrc, voiceSrc: taskVoiceSrc, play: playVoice },
      }),
    );
    if (!taskPanel) taskLoopBox.style.display = 'none';
  } else {
    showToast('任务系统不可用：任务进度与判定停用', 'warn', 5000);
  }

  // ---------- L6 数据层：实验报告（导出交互在 UI 底栏，事件接线见下） ----------
  setBootStatus('正在准备实验报告…');
  const report = initStep('实验报告', () => createReport({ store, waveField, clock }));

  // ---------- 跨模块事件接线（main.ts 是唯一合法跨 feature 组装处） ----------
  // 应用生命周期 = 页面生命周期，订阅无需退订。

  // 时钟 ⇄ 播放状态：PLAYBACK_CHANGED → 时钟同步（UI 注入 clock 已直作用，此处幂等兜底）
  store.on(STORE_EVENTS.PLAYBACK_CHANGED, (payload) => {
    const playback = (payload as PlaybackState | undefined) ?? store.getState().playback;
    if (playback.paused) clock.pause();
    else clock.resume();
    clock.setScale(playback.scale);
  });

  // 页面隐藏自动暂停（只暂停不自动恢复，回到页面由用户决定是否继续）
  const onVisibilityChange = (): void => {
    if (!document.hidden) return;
    if (!clock.isPaused()) {
      clock.pause();
      const playback = { ...store.getState().playback, paused: true };
      store.setState({ playback });
      store.emit(STORE_EVENTS.PLAYBACK_CHANGED, playback);
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  // 底栏：重置 → 实验层（时钟归零 + 清测量 + 重新 configure）
  slots.playbackBar.addEventListener(UI_EVENT_RESET, () => {
    experiments?.reset();
  });

  // 底栏：报告导出 → 数据层生成并下载
  slots.playbackBar.addEventListener(UI_EVENT_REPORT, () => {
    if (!report) {
      showToast('报告模块不可用，无法导出', 'warn');
      return;
    }
    void report.download().then((result) => {
      if (result.ok) showToast('实验报告已生成并开始下载', 'success');
      else showToast(`报告导出失败：${result.reason ?? '未知原因'}`, 'warn');
    });
  });

  // 底栏：分享卡片 → 预生成底图 + 当前读数合成 PNG 下载（素材缺失时静默提示）
  slots.playbackBar.addEventListener(UI_EVENT_SHARE, () => {
    const state = store.getState();
    const sea = waveField.observedSeaState();
    void buildShareCard({
      experimentLabel: EXPERIMENT_NAMES[state.experiment],
      hs: sea.hs,
      tp: sea.tp,
      tasksDone: state.tasks.filter((task) => task.done).length,
      tasksTotal: state.tasks.length,
      simTime: clock.time(),
    }).then((blob) => {
      if (!blob) {
        showToast('分享卡片生成失败（底图素材缺失或浏览器不支持）', 'warn');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `wave-lab-share-card-${stamp}.png`);
      showToast('分享卡片已生成并开始下载', 'success');
    });
  });

  // 任务六「换一个海况」→ 实验层按种子重摆随机海况
  store.on(TASK_EVENTS.MYSTERY_REROLL, (payload) => {
    const seed = (payload as { seed?: unknown } | null)?.seed;
    if (typeof seed === 'number' && Number.isFinite(seed)) {
      experiments?.controllers.spectrum.randomSeaState(seed);
    }
  });

  // 实验切换闭环（SPEC §8）：UI 段只写 store + emit(EXPERIMENT_CHANGED)，
  // 实验层在此承接 → selectExperiment（deactivate → setState/emit → activate/configure）。
  // payload 兼容两种历史形状：UI 的裸 id 字符串与 engine 的 { experiment }；
  // selectExperiment 对同 id 幂等返回，故 engine.select 再发的事件不会造成循环。
  store.on(STORE_EVENTS.EXPERIMENT_CHANGED, (payload) => {
    if (!experiments) return;
    const id =
      typeof payload === 'string'
        ? payload
        : (payload as { experiment?: unknown } | null)?.experiment;
    const next =
      typeof id === 'string' && id ? id : store.getState().experiment;
    experiments.selectExperiment(next as ExperimentId);
  });

  // 数据闭环「任务判定」段：固定步 + 测量/参数/实验变更后评估（模块内有指纹去重）
  if (tasks) {
    clock.onStep(() => tasks.evaluate());
    store.on(STORE_EVENTS.MEASUREMENT_ADDED, () => tasks.evaluate());
    store.on(STORE_EVENTS.PARAMS_CHANGED, () => tasks.evaluate());
    store.on(STORE_EVENTS.EXPERIMENT_CHANGED, () => tasks.evaluate());
  }

  // ---------- 挂载（壳层 → 各面板 → 启动帧驱动） ----------
  setBootStatus('正在挂载界面…');
  ui.mount();
  // 交互任务面板挂在「科研任务」面板内部（slots.taskCards 宿主），不再
  // 追加到 layout.left 末尾——原静态摘要卡已移除，此处是唯一任务卡实现。
  if (taskLoopBox) slots.taskCards.appendChild(taskLoopBox);
  charts?.mount();
  instruments?.mount();
  taskPanel?.mount();

  if (renderer) {
    renderer.setView(store.getState().view);
    renderer.start();
  } else {
    // 渲染层缺席（WebGL 不可用 / 初始化失败）时的时钟兜底驱动：
    // 仅推进仿真时钟，维持 η(t)/仪器/任务的 2D 闭环，不承载任何渲染业务。
    let lastTick = performance.now();
    let rafId = 0;
    const tickClock = (now: number): void => {
      rafId = requestAnimationFrame(tickClock);
      clock.advance((now - lastTick) / 1000);
      lastTick = now;
    };
    rafId = requestAnimationFrame(tickClock);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        lastTick = performance.now(); // 回到页面丢弃隐藏期间积压，防大步追赶
      }
    });
    void rafId;
  }

  // 初始播放态同步一次（默认未暂停 1x，与时钟默认一致；幂等）
  const initialPlayback = store.getState().playback;
  if (initialPlayback.paused) clock.pause();
  else clock.resume();
  clock.setScale(initialPlayback.scale);

  hideBootLoading();

  // 开场短片（hero-lab 氛围底 + intro-ocean.mp4，静音自动播放、可跳过、失败静默）
  try {
    showIntroOverlay();
  } catch {
    /* 开场素材永不阻塞主流程 */
  }

  console.info(
    '[wave-lab] 装配完成：',
    [
      renderer ? 'render' : 'render✗',
      experiments ? 'experiments' : 'experiments✗',
      charts ? 'charts' : 'charts✗',
      instruments ? 'instruments' : 'instruments✗',
      tasks ? 'tasks' : 'tasks✗',
      report ? 'report' : 'report✗',
      'media(预生成素材)',
    ].join(' / '),
  );
}

main();
