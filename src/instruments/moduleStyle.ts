/**
 * instruments 本地样式注入工具 —— 与 src/viz/moduleStyle.ts 同语义的本地副本
 * （架构铁律：跨 feature 运行时零 import；两模块都不改 src/styles/main.css）。
 */

export function injectModuleStyleOnce(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

export function removeModuleStyle(id: string): void {
  document.getElementById(id)?.remove();
}
