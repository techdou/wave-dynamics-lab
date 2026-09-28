/**
 * 浅水可视化 GLSL 源码完整性检查（常驻）。
 * ShaderMaterial 的 GLSL 错误只在 GPU 编译时暴露，本测试在 node 侧拦截
 * 最常见的拼接类缺陷：模板插值产生的非法浮点字面量（如 2.4.0）、函数重复
 * 定义、括号失衡、uniform/varying 缺失。
 */
import { describe, expect, it } from 'vitest';
import {
  NOISE_GLSL,
  SAND_COLOR_GLSL,
  OCEAN_FRAG,
  OCEAN_VERT,
} from '../src/render/shaders';
import { CAUSTICS_VERT, CAUSTICS_FRAG } from '../src/render/causticsBuffer';
import { RIPPLE_STEP_FRAG } from '../src/render/rippleBuffer';
import { createSeabed } from '../src/render/seabed';

/** 括号配平 + 无 undefined 残留 + 无「2.4.0」式非法浮点字面量 */
function assertBalanced(src: string, label: string): void {
  expect(src, `${label}: undefined 残留`).not.toContain('undefined');
  const open = (re: RegExp) => (src.match(re) ?? []).length;
  expect(open(/\{/g), `${label}: 大括号不配平`).toBe(open(/\}/g));
  expect(open(/\(/g), `${label}: 圆括号不配平`).toBe(open(/\)/g));
  expect(src, `${label}: 非法浮点字面量 x.y.z`).not.toMatch(/\d+\.\d+\.\d+/);
}

describe('浅水 GLSL 源码完整性', () => {
  it('公共片段：噪声与沙色函数定义完整', () => {
    expect(NOISE_GLSL).toContain('float hash12');
    expect(NOISE_GLSL).toContain('float valueNoise');
    expect(SAND_COLOR_GLSL).toContain('vec3 sandBase');
    assertBalanced(NOISE_GLSL + SAND_COLOR_GLSL, '公共片段');
  });

  it('OCEAN_FRAG：函数只定义一次、新 uniform 齐全、透底/涟漪已接入', () => {
    expect((OCEAN_FRAG.match(/float hash12/g) ?? []).length).toBe(1);
    expect((OCEAN_FRAG.match(/float valueNoise/g) ?? []).length).toBe(1);
    expect((OCEAN_FRAG.match(/vec3 sandBase/g) ?? []).length).toBe(1);
    for (const u of ['uCausticsTex', 'uCausticsWorldSize', 'uShallowMix', 'uShallowDepth', 'uRippleTex', 'uRippleWorldSize']) {
      expect(OCEAN_FRAG).toContain(`uniform ${u.includes('Tex') ? 'sampler2D' : 'float'} ${u}`);
    }
    expect(OCEAN_FRAG).toContain('refract(-V, n, 0.75)');
    assertBalanced(OCEAN_FRAG, 'OCEAN_FRAG');
    assertBalanced(OCEAN_VERT, 'OCEAN_VERT');
  });

  it('焦散 shader：顶点重投影到折射落点、片元参数面积反比光强', () => {
    // Wallace 折射网格法的关键不变量：光能沉积在落点位置（裁剪空间重投影），
    // 而非在入射参数位置画强度场
    expect(CAUSTICS_VERT).toContain('gl_Position = vec4(bedUv * 2.0 - 1.0, 0.0, 1.0)');
    expect(CAUSTICS_VERT).toContain('refract(-uSunDirPhys, N, 0.75)');
    expect(CAUSTICS_FRAG).toContain('dFdx(vParam.x)');
    expect(CAUSTICS_FRAG).toContain('dFdy(vParam.y)');
    assertBalanced(CAUSTICS_VERT + CAUSTICS_FRAG, 'caustics');
  });

  it('涟漪 shader：波动方程步进完整、含淡出系数、数值字面量合法', () => {
    expect(RIPPLE_STEP_FRAG).toContain('exp(-uDelta / 2.4000)');
    expect(RIPPLE_STEP_FRAG).toContain('uWorldSize / 256.0');
    expect(RIPPLE_STEP_FRAG).toContain('uDecay');
    assertBalanced(RIPPLE_STEP_FRAG, 'ripple');
  });

  it('海床 shader：世界坐标起伏（uWorldSize 展开）、焦散采样齐全（真实实例）', () => {
    const seabed = createSeabed();
    const mat = seabed.mesh.material as unknown as { vertexShader: string; fragmentShader: string };
    expect(mat.fragmentShader).toContain('sandBase');
    expect(mat.fragmentShader).toContain('uCausticsTex');
    // 起伏必须在世界尺度坐标上计算（单位平面直接求正弦相位范围过小，起伏失效）
    expect(mat.vertexShader).toContain('position.x * uWorldSize');
    expect(mat.vertexShader).toContain('vSlopeNormal');
    assertBalanced(mat.vertexShader + mat.fragmentShader, 'seabed');
    seabed.dispose();
  });
});
