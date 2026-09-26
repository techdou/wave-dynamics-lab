/**
 * 面板折叠状态机（纯逻辑，可单测）
 * 左栏 / 右栏 / 学习资源浮窗三个面板的折叠态 + 右栏 tab 选中，
 * 全部收敛为一个不可变状态对象，ui.ts 只做 reduce + 应用到 DOM class。
 *
 * 约定：断点模式切换（set-mode）时，折叠态整体回到该模式的默认值——
 * 这是确定性规则，避免"用户在某断点手动收起、跨断点后被卡在奇怪组合"。
 */
import type { LayoutMode } from './breakpoints';

export type PanelId = 'left' | 'right' | 'media';

/** 右栏三个 tab */
export type RightTab = 'params' | 'instruments' | 'data';

export interface PanelUIState {
  /** true = 折叠（隐藏面板主体） */
  collapsed: Record<PanelId, boolean>;
  rightTab: RightTab;
}

/** 各断点模式的折叠默认值：medium 右栏折叠为图标；compact 全部抽屉化收起 */
const MODE_DEFAULTS: Record<LayoutMode, Record<PanelId, boolean>> = {
  wide: { left: false, right: false, media: true },
  medium: { left: false, right: true, media: true },
  compact: { left: true, right: true, media: true },
};

export function initialPanelState(mode: LayoutMode): PanelUIState {
  return { collapsed: { ...MODE_DEFAULTS[mode] }, rightTab: 'params' };
}

export type PanelAction =
  | { type: 'set-mode'; mode: LayoutMode }
  | { type: 'toggle-panel'; panel: PanelId }
  | { type: 'open-panel'; panel: PanelId }
  | { type: 'select-tab'; tab: RightTab }
  | { type: 'open-media' };

export function reducePanelAction(state: PanelUIState, action: PanelAction): PanelUIState {
  switch (action.type) {
    case 'set-mode':
      return { ...state, collapsed: { ...MODE_DEFAULTS[action.mode] } };
    case 'toggle-panel':
      return {
        ...state,
        collapsed: { ...state.collapsed, [action.panel]: !state.collapsed[action.panel] },
      };
    case 'open-panel':
      return { ...state, collapsed: { ...state.collapsed, [action.panel]: false } };
    case 'select-tab':
      return state.rightTab === action.tab ? state : { ...state, rightTab: action.tab };
    case 'open-media':
      return state.collapsed.media
        ? { ...state, collapsed: { ...state.collapsed, media: false } }
        : state;
  }
}
