/**
 * 二次确认模态框（UI 模块内部组件）
 * Promise 风格：await confirmDialog(...) 得到布尔；Esc / 点遮罩 = 取消。
 * 模态属于浮层，允许使用 --shadow-float（SPEC §12 阴影克制条款）。
 */

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险动作（如重置）用琥珀色确认按钮 */
  danger?: boolean;
}

/** 当前打开中的对话框；存在时新请求直接取消（防叠加重入，如焦点移出遮罩后再触发） */
let activeDialog: (() => void) | null = null;

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(false);
      return;
    }
    if (activeDialog) {
      activeDialog();
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      activeDialog = null;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      resolve(result);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ui-btn ui-btn--ghost';
    cancelBtn.textContent = options.cancelText ?? '取消';
    cancelBtn.addEventListener('click', () => finish(false));

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = options.danger ? 'ui-btn ui-btn--danger' : 'ui-btn ui-btn--primary';
    confirmBtn.textContent = options.confirmText ?? '确认';
    confirmBtn.addEventListener('click', () => finish(true));

    const titleEl = document.createElement('h3');
    titleEl.className = 'ui-modal__title';
    titleEl.textContent = options.title;

    const msgEl = document.createElement('p');
    msgEl.className = 'ui-modal__message';
    msgEl.textContent = options.message;

    const actions = document.createElement('div');
    actions.className = 'ui-modal__actions';
    actions.append(cancelBtn, confirmBtn);

    const card = document.createElement('div');
    card.className = 'ui-modal';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', options.title);
    card.append(titleEl, msgEl, actions);

    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay';
    overlay.appendChild(card);
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(false);
    });

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      }
    };

    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);
    activeDialog = () => finish(false);
    confirmBtn.focus();
  });
}
