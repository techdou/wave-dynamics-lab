/**
 * createRenderer —— docs/SPEC.md §7.1 契约实现（签名不变）。
 * 职责：rAF 主循环（每帧 clock.advance → components() 更新 uniform → 渲染）、
 * 三视角相机、白帽/飞沫粒子、示踪与冻结波形、天空/水下氛围、造波机与浮标道具。
 * 波面唯一数据源：waveField.components() / evalSurface / particleOrbit /
 * whitecapIntensity；运行期只依赖 core + physics，通过 store 只读状态 + 事件通信。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { SimClock } from '../core/clock';
import type { Store } from '../core/store';
import type { SimState, ViewKind } from '../core/types';
import type { WaveField } from '../physics/waveField';
import { createCameraRig } from './cameraRig';
import { createOceanSurface } from './oceanSurface';
import { createParticleField } from './particleSystems';
import { createSceneProps } from './props';
import type { WaveMakerVisual } from './props';
import {
  createParticlePool,
  emitParticle,
  sprayEmitChance,
  stepParticles,
  whitecapEmitChance,
} from './logic/spawn';
import { degToRad } from './logic/mathUtils';
import { createSkyDome } from './skyDome';
import { createMarineSnow } from './marineSnow';
import { createUnderwaterPass } from './underwaterPass';
import { createFoamBuffer } from './foamBuffer';
import {
  createSunMaskMaterial,
  createOccluderMaterial,
  createGodRaysPass,
} from './godRays';
import { createTracerSystem } from './tracerSystem';
import { defaultTracerLayout } from './logic/tracerLayout';
import { packWaveComponents, planWorldSize, createWaveUniformPack } from './logic/uniforms';

export interface RendererDeps {
  /** 3D 视口容器（index.html #viewport，铺满全屏底层） */
  container: HTMLElement;
  store: Store<SimState>;
  waveField: WaveField;
  clock: SimClock;
}

export interface Renderer {
  /** 启动 requestAnimationFrame 主循环（每帧 clock.advance + 重建波面 + 渲染） */
  start(): void;
  /** 切换视角（sea-surface / side-section / underwater），自行订阅 store 亦可 */
  setView(view: ViewKind): void;
  /** 停止循环并释放 GPU 资源 */
  dispose(): void;
}

/** 粒子池硬上限（固定容量，防内存无限增长） */
const WHITECAP_POOL_SIZE = 1500;
const SPRAY_POOL_SIZE = 800;
/** 每帧白帽出生尝试采样数 */
const WHITECAP_ATTEMPTS_PER_FRAME = 10;
const SPRAY_ATTEMPTS_PER_FRAME = 6;

/** 从 store 提取风况（速度 m/s + 方向 deg；实验二无风） */
function windOf(state: SimState): { speed: number; dirDeg: number } {
  switch (state.experiment) {
    case 'wind':
      return {
        speed: state.params.wind.windSpeed,
        dirDeg: state.params.wind.windDirection,
      };
    case 'spectrum':
      return { speed: state.params.spectrum.windSpeed, dirDeg: 0 };
    default:
      return { speed: 0, dirDeg: 0 };
  }
}

/** 实验二造波机可视化参数（振幅 = H/2，与 physics 分量一致） */
function waveMakerVisuals(state: SimState): WaveMakerVisual[] | null {
  if (state.experiment !== 'interference') return null;
  const { makerA, makerB } = state.params.interference;
  return [
    { angleDeg: makerA.angle, amp: makerA.amplitude / 2, phaseDeg: makerA.phase, period: makerA.period },
    { angleDeg: makerB.angle, amp: makerB.amplitude / 2, phaseDeg: makerB.phase, period: makerB.period },
  ];
}

export function createRenderer(deps: RendererDeps): Renderer {
  const { container, store, waveField, clock } = deps;

  // ---------- WebGL 基础 ----------
  const threeRenderer = new THREE.WebGLRenderer({ antialias: true });
  // ACES 电影级色调映射由后处理链的 OutputPass 统一执行（渲染到 linear HDR RT）；
  // 自研 ShaderMaterial 不含 tonemapping chunk，正好保持线性输出交给链尾。
  threeRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  threeRenderer.toneMappingExposure = 1.12;
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  threeRenderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
  threeRenderer.domElement.style.display = 'block';
  container.appendChild(threeRenderer.domElement);

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(new THREE.Color().setStyle('#8fa8a3').getHex(), 0.0009);
  scene.fog = fog;
  scene.background = new THREE.Color().setStyle('#8fa8a3');

  // 道具照明（海面/天空为自绘 shader，不依赖灯光）
  const sunDir = new THREE.Vector3(0.45, 0.4, -0.55).normalize();
  const dirLight = new THREE.DirectionalLight(new THREE.Color().setStyle('#fff2dc'), 1.2);
  dirLight.position.copy(sunDir).multiplyScalar(300);
  const hemiLight = new THREE.HemisphereLight(
    new THREE.Color().setStyle('#5d7a7a'),
    new THREE.Color().setStyle('#0a2f3f'),
    0.8,
  );
  scene.add(dirLight, hemiLight);

  // ---------- 子系统 ----------
  const rig = createCameraRig(container, (container.clientWidth || 1) / (container.clientHeight || 1));
  scene.add(rig.camera);

  const ocean = createOceanSurface();
  scene.add(ocean.mesh);

  const sky = createSkyDome(2800);
  scene.add(sky.mesh);

  const whitecapPool = createParticlePool(WHITECAP_POOL_SIZE);
  const sprayPool = createParticlePool(SPRAY_POOL_SIZE);
  const whitecapField = createParticleField(WHITECAP_POOL_SIZE, '#eef4f4', 0.85);
  const sprayField = createParticleField(SPRAY_POOL_SIZE, '#d8f2ec', 0.7);
  scene.add(whitecapField.points, sprayField.points);

  const tracer = createTracerSystem(defaultTracerLayout());
  scene.add(tracer.group);
  tracer.setTrailsVisible(store.getState().overlays.showTrails);

  const marineSnow = createMarineSnow();
  scene.add(marineSnow.points);

  const props = createSceneProps();
  scene.add(props.group);

  // ---------- 物理泡沫积累缓冲（ping-pong RT，见 foamBuffer.ts）----------
  const foam = createFoamBuffer(threeRenderer);

  // ---------- 体积光遮挡资源（太阳遮罩 + 黑色波面遮挡体，见 godRays.ts）----------
  const MASK_SCALE = 0.5;
  const maskRT = new THREE.WebGLRenderTarget(
    Math.max(2, Math.floor((container.clientWidth || 1) * MASK_SCALE)),
    Math.max(2, Math.floor((container.clientHeight || 1) * MASK_SCALE)),
    { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter },
  );
  const sunMaskMaterial = createSunMaskMaterial(sunDir);
  const blackOccluder = createOccluderMaterial();
  const maskBackground = new THREE.Color(0x000000);
  const skyMaterial = sky.mesh.material;
  const oceanMaterial = ocean.mesh.material;
  const maskHidden: THREE.Object3D[] = [
    whitecapField.points,
    sprayField.points,
    marineSnow.points,
    tracer.group,
    props.group,
  ];

  // ---------- 后处理链（全部来自 three 官方 addons，零新增依赖）----------
  // RenderPass(线性 HDR) → UnrealBloom(太阳高光/白帽微光) → Underwater(水下扭曲) → OutputPass(ACES+sRGB)
  const composer = new EffectComposer(threeRenderer);
  composer.addPass(new RenderPass(scene, rig.camera));
  const godRaysPass = createGodRaysPass(maskRT.texture);
  composer.addPass(godRaysPass);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth || 1, container.clientHeight || 1),
    0.32, // strength：克制的高光泛光
    0.55, // radius
    0.82, // threshold：只让高光与泡沫亮部泛光
  );
  composer.addPass(bloomPass);
  const underwaterPass = createUnderwaterPass();
  composer.addPass(underwaterPass);
  composer.addPass(new OutputPass());

  // ---------- 运行时状态 ----------
  const pack = createWaveUniformPack();
  let worldSize = 240;
  let frozenWaveT: number | null = null;
  let waveT = 0;
  let lastParticleT = 0; // 粒子推进用的波面时间锚点（暂停/冻结时 Δt=0）
  let lastMakersKey = '';
  let underwaterBlend = 0;
  let whitecapCursor = 0;
  let sprayCursor = 0;
  let rafId = 0;
  let running = false;
  let started = false;
  let disposed = false;
  let lastFrame = 0;

  props.setReferenceExtent(worldSize); // 初始参考线长度

  const aboveFogColor = new THREE.Color().setStyle('#8fa8a3');
  const underFogColor = new THREE.Color().setStyle('#0d454c');
  const fogTarget = new THREE.Color();

  // ---------- 每帧辅助 ----------
  const sampleEta = (sceneX: number, sceneZ: number): number =>
    waveField.evalSurface(sceneX, -sceneZ, waveT).eta;

  function emitAtSea(rngSource: () => number, spray: boolean): boolean {
    const half = worldSize * 0.45;
    const sx = (rngSource() * 2 - 1) * half;
    const sz = (rngSource() * 2 - 1) * half;
    const sample = waveField.evalSurface(sx, -sz, waveT);
    const steep = Math.hypot(sample.normal.x, sample.normal.y) / Math.max(sample.normal.z, 1e-6);
    const state = store.getState();
    if (spray) {
      const wind = windOf(state);
      if (Math.random() > sprayEmitChance(wind.speed)) return false;
      if (steep < 0.25) return false;
      const th = degToRad(wind.dirDeg);
      sprayCursor = emitParticle(sprayPool, sprayCursor, {
        px: sx,
        py: sample.eta + 0.15,
        pz: sz,
        windVx: wind.speed * Math.sin(th),
        windVz: wind.speed * -Math.cos(th),
        spray: true,
        rngA: rngSource(),
        rngB: rngSource(),
        rngC: rngSource(),
      });
      return true;
    }
    const chance = whitecapEmitChance(waveField.whitecapIntensity(), steep);
    if (rngSource() >= chance) return false;
    const wind = windOf(state);
    const th = degToRad(wind.dirDeg);
    whitecapCursor = emitParticle(whitecapPool, whitecapCursor, {
      px: sx,
      py: sample.eta + 0.1,
      pz: sz,
      windVx: wind.speed * Math.sin(th),
      windVz: wind.speed * -Math.cos(th),
      spray: false,
      rngA: rngSource(),
      rngB: rngSource(),
      rngC: rngSource(),
    });
    return true;
  }

  function syncMakers(): void {
    const state = store.getState();
    const makers = waveMakerVisuals(state);
    const key = makers
      ? makers.map((m) => `${m.angleDeg},${m.amp},${m.phaseDeg},${m.period}`).join('|') +
        `@${worldSize.toFixed(1)}`
      : '';
    if (key !== lastMakersKey) {
      lastMakersKey = key;
      props.setWaveMakers(makers, worldSize);
    }
  }

  const sunPoint = new THREE.Vector3();
  const camForward = new THREE.Vector3();

  /** 遮罩渲染：换材质 → 半分辨率 RT 渲染太阳+黑色波面 → 恢复（遮挡=真实波形） */
  function renderSunMask(): void {
    const bg = scene.background;
    scene.background = maskBackground;
    sky.mesh.material = sunMaskMaterial;
    ocean.mesh.material = blackOccluder;
    for (const obj of maskHidden) obj.visible = false;
    threeRenderer.setRenderTarget(maskRT);
    threeRenderer.render(scene, rig.camera);
    threeRenderer.setRenderTarget(null);
    scene.background = bg;
    sky.mesh.material = skyMaterial;
    ocean.mesh.material = oceanMaterial;
    for (const obj of maskHidden) obj.visible = true;
  }

  function updateGodRays(): void {
    rig.camera.getWorldDirection(camForward);
    sunPoint.copy(sunDir).multiplyScalar(2000);
    const toSunX = sunPoint.x - rig.camera.position.x;
    const toSunY = sunPoint.y - rig.camera.position.y;
    const toSunZ = sunPoint.z - rig.camera.position.z;
    const inFront = toSunX * camForward.x + toSunY * camForward.y + toSunZ * camForward.z > 0;
    if (!inFront) {
      godRaysPass.enabled = false;
      return;
    }
    sunPoint.project(rig.camera);
    godRaysPass.enabled = true;
    (godRaysPass.uniforms['uSunScreen']!['value'] as THREE.Vector2).set(
      sunPoint.x * 0.5 + 0.5,
      sunPoint.y * 0.5 + 0.5,
    );
    (godRaysPass.uniforms['uIntensity']!['value'] as number) = 0.10 + underwaterBlend * 0.8;
    renderSunMask();
  }

  function frame(now: number): void {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;

    // 1. 推进仿真（onStep 内同步完成示踪采样）
    clock.advance(dt);
    const state = store.getState();
    const simT = clock.time();
    waveT = frozenWaveT ?? simT;

    // 粒子/泡沫共同的时间基准：暂停/冻结波形时 Δt=0，重置回退钳 0，掉帧钳 0.25
    let particleDt = waveT - lastParticleT;
    if (particleDt < 0) particleDt = 0;
    else particleDt = Math.min(particleDt, 0.25);
    lastParticleT = waveT;

    // 2. 波面 uniform（唯一数据源：components()）
    const comps = waveField.components();
    packWaveComponents(pack, comps);
    const nextWorldSize = planWorldSize(comps);
    if (Math.abs(nextWorldSize - worldSize) > 0.5) {
      worldSize = nextWorldSize;
      props.setReferenceExtent(worldSize);
      lastMakersKey = ''; // 触发推板重新布局
    }
    ocean.setWorldSize(worldSize);

    // 2.5 泡沫积累缓冲（雅可比/白帽注入 + 衰减 + 风漂）→ 海面片元采样
    const wind = windOf(state);
    foam.update(particleDt, waveT, waveField.whitecapIntensity(), wind.dirDeg, worldSize, pack);
    ocean.update(pack, waveT, waveField.whitecapIntensity(), waveField.depth, foam.texture);

    // 3. 剖面波形曲线（真实 evalSurface 采样）
    props.updateProfileLine(worldSize, (py) => waveField.evalSurface(0, py, waveT).eta);

    // 4. 浪花粒子：出生（真实波陡/白帽强度/风速）→ 积分 → 上传
    //    粒子时间与波面时间（waveT）同步：暂停/冻结波形时 Δt = 0，粒子定格、
    //    不再从冻结波峰出生；2x 倍速下波形与粒子同为 2 倍速，全屏一套仿真时间。
    if (particleDt > 0) {
      for (let i = 0; i < WHITECAP_ATTEMPTS_PER_FRAME; i++) emitAtSea(Math.random, false);
      for (let i = 0; i < SPRAY_ATTEMPTS_PER_FRAME; i++) emitAtSea(Math.random, true);
      stepParticles(whitecapPool, particleDt);
      stepParticles(sprayPool, particleDt);
    }
    whitecapField.sync(whitecapPool);
    sprayField.sync(sprayPool);

    // 5. 示踪几何重建（采样在 clock.onStep 中按固定仿真步进行）
    tracer.syncGeometry();

    // 6. 道具：造波机（真实波形相位）+ 浮标（真实 η/法线）
    syncMakers();
    props.updateWaveMakers(waveT);
    const probe = state.probe;
    const probeSample = waveField.evalSurface(probe.x, probe.y, waveT);
    props.updateBuoy(probe.x, probe.y, probeSample.eta, probeSample.normal);

    // 7. 相机与水下氛围
    rig.update(dt, worldSize, sampleEta);
    const targetBlend = rig.isUnderwater() ? 1 : 0;
    underwaterBlend += (targetBlend - underwaterBlend) * (1 - Math.exp(-5 * dt));
    sky.setUnderwaterBlend(underwaterBlend);
    fogTarget.copy(aboveFogColor).lerp(underFogColor, underwaterBlend);
    fog.color.lerp(fogTarget, 1 - Math.exp(-5 * dt));
    (scene.background as THREE.Color).copy(fog.color);
    const camDepth = Math.max(0, -rig.camera.position.y);
    fog.density = 0.0009 + underwaterBlend * (0.012 + Math.min(0.03, camDepth * 0.0022));
    sky.setWaterHaze(fog.density, fog.color);

    // 8. 粒子点尺寸换算（fov 插值期间连续变化）
    const pixelScale =
      (threeRenderer.domElement.clientHeight || 1) /
      (2 * Math.tan(degToRad(rig.camera.fov) / 2));
    whitecapField.setPixelScale(pixelScale);
    sprayField.setPixelScale(pixelScale);
    marineSnow.update(waveT, underwaterBlend, pixelScale);
    underwaterPass.update(underwaterBlend, waveT);

    // 8.5 体积光：波面遮挡遮罩 + 径向模糊合成（强度随水下过渡增强）
    updateGodRays();

    composer.render();
  }

  // ---------- store / clock 订阅 ----------
  const unsubscribeStore = store.subscribe((next, prev) => {
    if (next.view !== prev.view) rig.setView(next.view, worldSize);
    if (
      next.overlays.freezeWaveform !== prev.overlays.freezeWaveform
    ) {
      frozenWaveT = next.overlays.freezeWaveform ? waveT : null;
    }
    if (next.overlays.showTrails !== prev.overlays.showTrails) {
      tracer.setTrailsVisible(next.overlays.showTrails);
    }
  });
  const unsubscribeStep = clock.onStep((simTime) => {
    tracer.sampleAll(simTime, waveField.particleOrbit);
  });

  // ---------- 窗口事件 ----------
  const onResize = (): void => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    threeRenderer.setSize(w, h);
    composer.setSize(w, h);
    maskRT.setSize(
      Math.max(2, Math.floor(w * MASK_SCALE)),
      Math.max(2, Math.floor(h * MASK_SCALE)),
    );
    rig.camera.aspect = w / h;
    rig.camera.updateProjectionMatrix();
  };
  const onVisibility = (): void => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(rafId);
    } else if (started && !disposed) {
      running = true;
      lastFrame = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    start() {
      if (started || disposed) return;
      started = true;
      running = true;
      lastFrame = performance.now();
      rafId = requestAnimationFrame(frame);
    },

    setView(view) {
      if (disposed) return;
      rig.setView(view, worldSize);
      if (store.getState().view !== view) {
        store.setState({ view });
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancelAnimationFrame(rafId);
      unsubscribeStore();
      unsubscribeStep();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      rig.dispose();
      ocean.dispose();
      sky.dispose();
      whitecapField.dispose();
      sprayField.dispose();
      marineSnow.dispose();
      foam.dispose();
      maskRT.dispose();
      sunMaskMaterial.dispose();
      blackOccluder.dispose();
      tracer.dispose();
      props.dispose();
      scene.remove(rig.camera, ocean.mesh, sky.mesh, whitecapField.points, sprayField.points, marineSnow.points, tracer.group, props.group, dirLight, hemiLight);
      composer.dispose();
      threeRenderer.dispose();
      threeRenderer.forceContextLoss();
      threeRenderer.domElement.remove();
    },
  };
}
