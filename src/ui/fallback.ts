/**
 * WebGL 可用性探测与降级说明页（UI 模块内部组件）
 * 集成工程师在创建渲染器前调 detectWebGL()，false 时调 showWebGLUnavailablePage()，
 * 保证 WebGL 不可用的机器上不白屏、能看懂原因与自助解法。
 */

export function detectWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    if (gl2) return true;
    const gl1 = canvas.getContext('webgl');
    return Boolean(gl1);
  } catch {
    return false;
  }
}

export function showWebGLUnavailablePage(reason?: string): void {
  if (typeof document === 'undefined') return;

  const title = document.createElement('h1');
  title.className = 'ui-webgl__title';
  title.textContent = '三维海面无法启动';

  const cause = document.createElement('p');
  cause.className = 'ui-webgl__cause';
  cause.textContent = reason
    ? `原因：${reason}`
    : '原因：当前浏览器未开启 WebGL（三维图形）支持，海面视图依赖它运行。';

  const listTitle = document.createElement('p');
  listTitle.className = 'ui-webgl__list-title';
  listTitle.textContent = '可以按顺序尝试：';

  const suggestions = document.createElement('ul');
  suggestions.className = 'ui-webgl__list';
  for (const text of [
    '确认浏览器开启了"硬件加速"设置（Chrome / Edge：设置 → 系统）。',
    '更新显卡驱动，或在有独立显卡的机器上打开本页。',
    '换用较新版本的 Chrome、Edge 或 Firefox。',
    '若在远程桌面 / 虚拟机中运行，尝试在本机直接打开。',
  ]) {
    const li = document.createElement('li');
    li.textContent = text;
    suggestions.appendChild(li);
  }

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'ui-btn ui-btn--primary';
  retry.textContent = '重试';
  retry.addEventListener('click', () => {
    window.location.reload();
  });

  const inner = document.createElement('div');
  inner.className = 'ui-webgl__inner';
  inner.append(title, cause, listTitle, suggestions, retry);

  const page = document.createElement('div');
  page.className = 'ui-webgl-fallback';
  page.setAttribute('role', 'alert');
  page.appendChild(inner);
  document.body.appendChild(page);
}
