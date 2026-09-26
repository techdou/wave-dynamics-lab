/**
 * 启动加载态（UI 模块内部组件）
 * 集成工程师在 main.ts 组装各模块前 showBootLoading()，全部就绪后 hideBootLoading()；
 * 中途可用 setBootStatus() 汇报"正在初始化 XX 模块"。
 * 可选 posterUrl：首屏氛围底图（hero-lab.png，预生成素材接入点之一）。
 */

let overlay: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;

export function showBootLoading(statusText?: string, posterUrl?: string): void {
  if (typeof document === 'undefined' || overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'ui-boot';
  if (posterUrl) {
    // 氛围图 + 深色渐变压暗，保证加载文字可读（素材加载失败仅无背景，不报错）
    overlay.style.backgroundImage = `linear-gradient(rgba(4, 31, 34, 0.78), rgba(4, 31, 34, 0.94)), url("${posterUrl}")`;
    overlay.style.backgroundSize = 'cover';
    overlay.style.backgroundPosition = 'center';
  }

  const spinner = document.createElement('div');
  spinner.className = 'ui-boot__spinner';

  const title = document.createElement('h1');
  title.className = 'ui-boot__title';
  title.textContent = '海水运动的基本方程';

  const subtitle = document.createElement('p');
  subtitle.className = 'ui-boot__subtitle';
  subtitle.textContent = '海浪动力学虚拟探索实验 · 正在准备实验环境';

  statusEl = document.createElement('p');
  statusEl.className = 'ui-boot__status';
  statusEl.textContent = statusText ?? '正在初始化…';

  const inner = document.createElement('div');
  inner.className = 'ui-boot__inner';
  inner.append(spinner, title, subtitle, statusEl);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
}

export function setBootStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

export function hideBootLoading(): void {
  overlay?.remove();
  overlay = null;
  statusEl = null;
}
