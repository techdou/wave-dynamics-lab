/**
 * 断点计算（纯逻辑，可单测）—— 响应式规格：
 * ≥1440 全布局；1024–1439 右栏默认折叠为图标；<1024 面板变抽屉、底栏紧凑。
 * 断点切换由 ui.ts 监听 resize 后调用，模式作为 data-ui-mode 写到 body 上驱动 CSS。
 */
export type LayoutMode = 'wide' | 'medium' | 'compact';

/** 断点阈值（px，含下边界）：≥1440 wide；≥1024 且 <1440 medium；<1024 compact */
export const LAYOUT_BREAKPOINTS = { wideMin: 1440, mediumMin: 1024 } as const;

export function computeLayoutMode(viewportWidth: number): LayoutMode {
  if (viewportWidth >= LAYOUT_BREAKPOINTS.wideMin) return 'wide';
  if (viewportWidth >= LAYOUT_BREAKPOINTS.mediumMin) return 'medium';
  return 'compact';
}
