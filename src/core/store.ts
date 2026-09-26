/**
 * 极简 pub/sub store —— docs/SPEC.md §5.2、§8
 * 唯一状态容器：getState / setState / subscribe + 独立事件总线 emit/on。
 * 禁止引入任何状态库；本文件为定稿契约，只允许修 bug，不允许改签名。
 */
import type { Listener, Unsubscribe } from './types';

export interface Store<T extends object> {
  /** 当前状态（只读约定：外部不得修改返回对象） */
  getState(): T;
  /**
   * 浅合并更新并通知全部订阅者（同步调用）。
   * patch 可为部分对象或基于当前 state 的函数；空 patch 不触发通知。
   */
  setState(patch: Partial<T> | ((state: T) => Partial<T>)): T;
  /** 订阅整树变更；返回退订函数 */
  subscribe(listener: Listener<T>): Unsubscribe;
  /** 发送具名事件（事件名常量见 core/constants STORE_EVENTS） */
  emit(eventName: string, payload?: unknown): void;
  /** 监听具名事件；返回退订函数 */
  on(eventName: string, handler: (payload: unknown) => void): Unsubscribe;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = { ...initial };
  const listeners = new Set<Listener<T>>();
  const events = new Map<string, Set<(payload: unknown) => void>>();

  const store: Store<T> = {
    getState: () => state,

    setState(patch) {
      const partial = typeof patch === 'function' ? patch(state) : patch;
      if (Object.keys(partial).length === 0) return state;
      const prev = state;
      state = { ...state, ...partial };
      for (const listener of [...listeners]) listener(state, prev);
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    emit(eventName, payload) {
      const handlers = events.get(eventName);
      if (!handlers) return;
      for (const handler of [...handlers]) handler(payload);
    },

    on(eventName, handler) {
      let handlers = events.get(eventName);
      if (!handlers) {
        handlers = new Set();
        events.set(eventName, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers?.delete(handler);
      };
    },
  };

  return store;
}
