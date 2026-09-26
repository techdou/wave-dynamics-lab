/**
 * 模块样式注入 —— viz / instruments 均不改 src/styles/main.css（归属 UI 工程师），
 * 组件样式由各自模块在 mount 时以唯一 id 的 <style> 注入 document.head。
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
