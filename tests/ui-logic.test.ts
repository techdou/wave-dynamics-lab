/**
 * UI 壳层纯逻辑测试 —— 断点计算 / 面板折叠状态机 / schema→控件映射 / 展示格式化。
 * DOM 部分（ui.ts、toast.ts 等）以 `npx tsc --noEmit` 零错误为准，不在本文件覆盖。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM_STATE, PARAM_LIMITS } from '../src/core/constants';
import { computeLayoutMode, LAYOUT_BREAKPOINTS } from '../src/ui/logic/breakpoints';
import { formatInteger, formatMetric, formatSimTime } from '../src/ui/logic/format';
import { initialPanelState, reducePanelAction } from '../src/ui/logic/panels';
import {
  applyParamPath,
  buildParamSchema,
  clampFieldValue,
  flattenParamGroups,
  getParamField,
  readParamPath,
  stepDecimals,
} from '../src/ui/logic/paramSchema';

describe('断点计算 computeLayoutMode', () => {
  it('≥1440 为 wide（含 1440 边界，优先教学大屏 1920×1080）', () => {
    expect(computeLayoutMode(1440)).toBe('wide');
    expect(computeLayoutMode(1920)).toBe('wide');
    expect(computeLayoutMode(4096)).toBe('wide');
  });

  it('1024–1439 为 medium（含 1024 边界）', () => {
    expect(computeLayoutMode(1439)).toBe('medium');
    expect(computeLayoutMode(1024)).toBe('medium');
  });

  it('<1024 为 compact（面板变抽屉）', () => {
    expect(computeLayoutMode(1023)).toBe('compact');
    expect(computeLayoutMode(0)).toBe('compact');
  });

  it('阈值常量与响应式规格一致', () => {
    expect(LAYOUT_BREAKPOINTS.wideMin).toBe(1440);
    expect(LAYOUT_BREAKPOINTS.mediumMin).toBe(1024);
  });
});

describe('面板折叠状态机', () => {
  it('wide 初始：左右全开、学习资源浮窗收起、右栏停在参数 tab', () => {
    const state = initialPanelState('wide');
    expect(state.collapsed).toEqual({ left: false, right: false, media: true });
    expect(state.rightTab).toBe('params');
  });

  it('medium 初始右栏折叠为图标；compact 初始全部收起（抽屉）', () => {
    expect(initialPanelState('medium').collapsed).toEqual({
      left: false,
      right: true,
      media: true,
    });
    expect(initialPanelState('compact').collapsed).toEqual({
      left: true,
      right: true,
      media: true,
    });
  });

  it('toggle-panel 翻转对应面板且不可变', () => {
    const state = initialPanelState('wide');
    const next = reducePanelAction(state, { type: 'toggle-panel', panel: 'left' });
    expect(next.collapsed.left).toBe(true);
    expect(next.collapsed.right).toBe(false);
    expect(state.collapsed.left).toBe(false);
  });

  it('set-mode 重置为该模式默认折叠态（确定性规则）', () => {
    const toggled = reducePanelAction(initialPanelState('wide'), {
      type: 'toggle-panel',
      panel: 'right',
    });
    expect(toggled.collapsed.right).toBe(true);
    const switched = reducePanelAction(toggled, { type: 'set-mode', mode: 'compact' });
    expect(switched.collapsed).toEqual({ left: true, right: true, media: true });
  });

  it('select-tab 切换右栏 tab；重复选择返回原状态对象', () => {
    const state = initialPanelState('wide');
    expect(reducePanelAction(state, { type: 'select-tab', tab: 'data' }).rightTab).toBe('data');
    expect(reducePanelAction(state, { type: 'select-tab', tab: 'params' })).toBe(state);
  });


  it('open-media 只打开学习资源浮窗，不影响其他面板', () => {
    const state = initialPanelState('compact');
    const next = reducePanelAction(state, { type: 'open-media' });
    expect(next.collapsed.media).toBe(false);
    expect(next.collapsed.left).toBe(true);
    expect(next.collapsed.right).toBe(true);
  });
});

describe('schema→控件映射', () => {
  it('实验一：一组 3 个滑块，范围与 PARAM_LIMITS 同源', () => {
    const groups = buildParamSchema('wind');
    expect(groups).toHaveLength(1);
    const fields = flattenParamGroups(groups);
    expect(fields.map((field) => field.path)).toEqual([
      'wind.windSpeed',
      'wind.windDuration',
      'wind.windDirection',
    ]);
    for (const field of fields) {
      expect(field.kind).toBe('slider');
      const key = field.path.split('.')[1] as keyof typeof PARAM_LIMITS.wind;
      const limits = PARAM_LIMITS.wind[key];
      expect(field.min).toBe(limits[0]);
      expect(field.max).toBe(limits[1]);
    }
  });

  it('实验二：造波机 A/B 两组各 4 个字段，路径前缀正确', () => {
    const groups = buildParamSchema('interference');
    expect(groups.map((group) => group.id)).toEqual(['makerA', 'makerB']);
    for (const group of groups) {
      expect(group.fields).toHaveLength(4);
      for (const field of group.fields) {
        expect(field.path.startsWith(`interference.${group.id}.`)).toBe(true);
      }
    }
  });

  it('实验三：含 select / number / checkbox，数值范围与 PARAM_LIMITS 同源', () => {
    const fields = flattenParamGroups(buildParamSchema('spectrum'));
    const byPath = new Map(fields.map((field) => [field.path, field]));
    expect(byPath.get('spectrum.kind')?.kind).toBe('select');
    expect(byPath.get('spectrum.randomSeed')?.kind).toBe('number');
    expect(byPath.get('spectrum.mystery')?.kind).toBe('checkbox');
    expect(byPath.get('spectrum.windSpeed')?.min).toBe(PARAM_LIMITS.spectrum.windSpeed[0]);
    expect(byPath.get('spectrum.fetch')?.max).toBe(PARAM_LIMITS.spectrum.fetch[1]);
    expect(byPath.get('spectrum.peakEnhancement')?.min).toBe(
      PARAM_LIMITS.spectrum.peakEnhancement[0],
    );
  });

  it('readParamPath 读取嵌套标量；路径不存在抛错', () => {
    const params = DEFAULT_SIM_STATE.params;
    expect(readParamPath(params, 'wind.windSpeed')).toBe(8);
    expect(readParamPath(params, 'interference.makerA.phase')).toBe(0);
    expect(readParamPath(params, 'spectrum.kind')).toBe('jonswap');
    expect(readParamPath(params, 'spectrum.mystery')).toBe(false);
    expect(() => readParamPath(params, 'wind.notExist')).toThrow();
  });

  it('applyParamPath 不可变写入嵌套路径（未触及的分支保持引用）', () => {
    const before = DEFAULT_SIM_STATE.params;
    const after = applyParamPath(before, 'interference.makerB.phase', 180);
    expect(after).not.toBe(before);
    expect(after.interference).not.toBe(before.interference);
    expect(after.interference.makerB).not.toBe(before.interference.makerB);
    expect(after.interference.makerB.phase).toBe(180);
    expect(before.interference.makerB.phase).toBe(0);
    expect(after.interference.makerA).toBe(before.interference.makerA);
    expect(after.wind).toBe(before.wind);
    expect(after.spectrum).toBe(before.spectrum);
  });

  it('clampFieldValue：越界夹取 / NaN 回落下界 / 整数字段取整', () => {
    const speed = getParamField(buildParamSchema('wind'), 'wind.windSpeed');
    expect(speed).toBeDefined();
    if (!speed) throw new Error('schema 缺少 wind.windSpeed');
    expect(clampFieldValue(speed, -5)).toBe(0);
    expect(clampFieldValue(speed, 99)).toBe(30);
    expect(clampFieldValue(speed, Number.NaN)).toBe(0);
    expect(clampFieldValue(speed, 12.34)).toBe(12.34);

    const seed = getParamField(buildParamSchema('spectrum'), 'spectrum.randomSeed');
    expect(seed).toBeDefined();
    if (!seed) throw new Error('schema 缺少 spectrum.randomSeed');
    expect(clampFieldValue(seed, 42.6)).toBe(43);
  });

  it('stepDecimals 由步进推小数位数', () => {
    expect(stepDecimals(0.5)).toBe(1);
    expect(stepDecimals(0.05)).toBe(2);
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(undefined)).toBe(0);
  });
});

describe('展示格式化', () => {
  it('formatSimTime：mm:ss / h:mm:ss；非法输入回落 00:00', () => {
    expect(formatSimTime(0)).toBe('00:00');
    expect(formatSimTime(59)).toBe('00:59');
    expect(formatSimTime(60)).toBe('01:00');
    expect(formatSimTime(75.9)).toBe('01:15');
    expect(formatSimTime(3661)).toBe('1:01:01');
    expect(formatSimTime(-5)).toBe('00:00');
    expect(formatSimTime(Number.NaN)).toBe('00:00');
    expect(formatSimTime(Number.POSITIVE_INFINITY)).toBe('00:00');
  });

  it('formatMetric：固定小数位；非有限值显示占位符', () => {
    expect(formatMetric(3.14159)).toBe('3.14');
    expect(formatMetric(0, 1)).toBe('0.0');
    expect(formatMetric(Number.NaN)).toBe('—');
    expect(formatMetric(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('formatInteger：千分位；非有限值显示占位符', () => {
    expect(formatInteger(12345.6)).toBe('12,346');
    expect(formatInteger(0)).toBe('0');
    expect(formatInteger(Number.NaN)).toBe('—');
  });
});
