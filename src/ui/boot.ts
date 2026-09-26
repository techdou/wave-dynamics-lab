/**
 * 初始化容错步进器（供集成工程师在 main.ts 逐模块 try/catch 用）
 * 用法：
 *   const experiments = initStep('实验层', () => createExperiments({ store, waveField, clock }));
 *   if (experiments) experiments.selectExperiment('wind');
 * 单模块失败只弹一条警告 toast + console.error，返回 null，其余模块继续挂载——
 * 落实"单模块失败不白屏"的要求。
 */
import { showToast } from './toast';

export function initStep<T>(label: string, fn: () => T, onError?: (error: unknown) => void): T | null {
  try {
    return fn();
  } catch (error) {
    console.error(`[初始化失败] ${label}`, error);
    onError?.(error);
    showToast(`模块「${label}」初始化失败，已跳过；其余功能继续可用`, 'warn', 5000);
    return null;
  }
}
