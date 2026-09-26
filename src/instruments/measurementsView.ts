/**
 * 测量记录列表视图 —— 右栏『数据』面板内容组件（SPEC §6.4/§6.8）。
 * 只读消费 store.measurements（写入权归 instruments），UI 壳负责容器与 tab 切换。
 * 既可被 instruments runtime 内嵌，也可由集成工程师单独挂到 dataPanel slot。
 */
import { STORE_EVENTS } from '../core/constants';
import type { Store } from '../core/store';
import type { MeasurementRecord, SimState } from '../core/types';
import { instrumentLabel, summarizeRecord } from './measurements';
import { injectModuleStyleOnce, removeModuleStyle } from './moduleStyle';

const STYLE_ID = 'inst-measurements-styles';

const STYLE_CSS = `
.inst-measure{display:flex;flex-direction:column;gap:6px;color:#9DC3BC;font-size:11px}
.inst-measure-title{color:#E8F5F1;font-size:12px;letter-spacing:.5px;display:flex;justify-content:space-between;align-items:baseline}
.inst-measure-title small{color:#9DC3BC;font-size:10px;font-family:Consolas,monospace}
.inst-measure-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto}
.inst-measure-list li{border:1px solid rgba(127,212,193,.18);border-radius:6px;padding:4px 8px;background:rgba(4,31,34,.5);font-family:Consolas,monospace;font-size:10.5px;line-height:1.5;cursor:default}
.inst-measure-empty{color:#9DC3BC;font-size:11px;padding:6px 2px}
`;

export interface MeasurementsViewDeps {
  root: HTMLElement;
  store: Store<SimState>;
  /** 最多渲染的最近记录条数，默认 20 */
  maxRows?: number;
}

export interface MeasurementsView {
  mount(): void;
  dispose(): void;
}

export function createMeasurementsView(deps: MeasurementsViewDeps): MeasurementsView {
  const { root, store } = deps;
  const maxRows = deps.maxRows ?? 20;
  const unsubscribes: Array<() => void> = [];
  let listEl: HTMLUListElement | null = null;
  let countEl: HTMLElement | null = null;

  function renderRow(rec: MeasurementRecord): HTMLLIElement {
    const li = document.createElement('li');
    const summary = summarizeRecord(rec.tool, rec.values, rec.simTime);
    li.textContent = `[${instrumentLabel(rec.tool)}] ${summary}`;
    if (rec.note) li.title = rec.note;
    return li;
  }

  function refresh(): void {
    if (!listEl || !countEl) return;
    const all = store.getState().measurements;
    countEl.textContent = `共 ${all.length} 条`;
    listEl.innerHTML = '';
    const recent = all.slice(-maxRows).reverse();
    if (recent.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'inst-measure-empty';
      empty.textContent = '暂无测量记录——激活一台仪器开始测量。';
      listEl.appendChild(empty);
      return;
    }
    for (const rec of recent) listEl.appendChild(renderRow(rec));
  }

  return {
    mount(): void {
      injectModuleStyleOnce(STYLE_ID, STYLE_CSS);
      root.classList.add('inst-measure');
      root.innerHTML = '';

      const title = document.createElement('header');
      title.className = 'inst-measure-title';
      title.innerHTML = '测量记录';
      countEl = document.createElement('small');
      title.appendChild(countEl);
      root.appendChild(title);

      listEl = document.createElement('ul');
      listEl.className = 'inst-measure-list';
      root.appendChild(listEl);

      refresh();
      unsubscribes.push(
        store.subscribe((state, prev) => {
          if (state.measurements !== prev.measurements) refresh();
        }),
      );
      unsubscribes.push(store.on(STORE_EVENTS.MEASUREMENT_ADDED, () => refresh()));
    },

    dispose(): void {
      for (const off of unsubscribes.splice(0)) off();
      listEl = null;
      countEl = null;
      root.innerHTML = '';
      removeModuleStyle(STYLE_ID);
    },
  };
}
