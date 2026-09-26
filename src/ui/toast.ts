/**
 * 轻量 toast（UI 模块内部组件，供壳层与其他 ui/* 辅助文件使用）
 * 堆叠上限 4 条，自动消退；三种语气：info（青绿描边）/ warn（琥珀）/ success（青绿底）。
 */

export type ToastKind = 'info' | 'warn' | 'success';

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container && container.isConnected) return container;
  container = document.createElement('div');
  container.className = 'ui-toast-stack';
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);
  return container;
}

export function showToast(message: string, kind: ToastKind = 'info', durationMs = 3200): void {
  if (typeof document === 'undefined') return;
  const box = ensureContainer();
  const item = document.createElement('div');
  item.className = `ui-toast ui-toast--${kind}`;
  item.setAttribute('role', 'status');
  item.textContent = message;
  box.appendChild(item);
  // 超出上限移除最旧的一条
  while (box.children.length > 4) {
    box.firstElementChild?.remove();
  }
  window.setTimeout(() => {
    item.classList.add('is-leaving');
    window.setTimeout(() => {
      item.remove();
    }, 240);
  }, durationMs);
}

/** dispose 时清空所有 toast（测试/卸载辅助） */
export function clearToasts(): void {
  container?.replaceChildren();
}
