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
import type { QualityLevel, SimState, ViewKind } from '../core/types';
import {
  nextRenderScale,
  shouldAutoDowngrade,
  RENDER_SCALE_INTERVAL_S,
  RENDER_SCALE_MIN,
  RENDER_SCALE_MAX,
  AUTO_DOWNGRADE_WARMUP_S,
} from './logic/quality';
import { VISUAL_DEFAULT_DEPTH } from './oceanSurface';
import type { WaveField } from '../physics/waveField';
import { createCameraRig } from './cameraRig';
import { createOceanSurface } from './oceanSurface';
import { createParticleField } from './particleSystems';
import { createSceneProps } from './props';
import type { WaveMakerVisual } from './props';
import { createSeabed } from './seabed';
import { createCausticsBuffer } from './causticsBuffer';
import { createRippleBuffer } from './rippleBuffer';
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
  /** 初始画质档位（缺省 high；UI 侧持久化选择由集成工程师传入） */
  quality?: QualityLevel;
  /** FPS 自适应自动降档（high→low，只降不升）时回调（UI 提示与按钮态回写） */
  onAutoDowngrade?: () => void;
}

export interface Renderer {
  /** 启动 requestAnimationFrame 主循环（每帧 clock.advance + 重建波面 + 渲染） */
  start(): void;
  /** 切换画质档位（低配：像素比 1、关后处理增强、泡沫隔帧；物理与读数不变） */
  setQuality(level: QualityLevel): void;
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
  const { container, store, waveField, clock, onAutoDowngrade } = deps;

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

  // ---------- 浅水可视化层（overlays.shallowMode，纯装饰，见各模块头注释）----------
  const caustics = createCausticsBuffer(threeRenderer);
  const seabed = createSeabed();
  scene.add(seabed.mesh);
  const ripple = createRippleBuffer(threeRenderer);
  /** 浅水模式过渡权重（0..1，指数趋近目标） */
  let shallowMix = 0;

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
    seabed.mesh, // 体积光遮罩里海床按不可见处理（遮罩只关心天空与波面轮廓）
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
  let qualityLevel: QualityLevel = deps.quality ?? 'high';
  let avgFrameMs = 16.7;
  let simElapsed = 0;
  let autoDowngraded = false;
  let frameIndex = 0;

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

  /** 遮罩渲染：换材质 → 半分辨率 RT 渲染太阳+黑色波面 → 恢复（遮挡=真实波形）。
   *  可见性按「记录原值 → 关 → 恢复原值」处理：maskHidden 中海床的 visible
   *  由浅水模式动态控制，不能盲目恢复为 true。 */
  function renderSunMask(): void {
    const bg = scene.background;
    const prevVisible = maskHidden.map((obj) => obj.visible);
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
    maskHidden.forEach((obj, i) => {
      obj.visible = prevVisible[i] ?? true;
    });
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
    const rawDtMs = now - lastFrame;
    const dt = Math.min(rawDtMs / 1000, 0.1);
    lastFrame = now;
    frameIndex++;
    avgFrameMs = avgFrameMs * 0.95 + rawDtMs * 0.05;
    simElapsed += dt;

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
    //     低配档隔帧更新（泡沫时间常数 2.6s，30Hz 更新完全平滑）
    const wind = windOf(state);
    if (qualityLevel !== 'low' || frameIndex % 2 === 0) {
      foam.update(particleDt, waveT, waveField.whitecapIntensity(), wind.dirDeg, worldSize, pack);
    }

    // 2.6 浅水可视化层（overlays.shallowMode，纯装饰）：模式过渡 → 海床/焦散/涟漪
    const shallowTarget = state.overlays.shallowMode ? 1 : 0;
    shallowMix += (shallowTarget - shallowMix) * (1 - Math.exp(-4 * dt));
    const shallowActive = shallowMix > 0.003;
    const shallowDepth = state.overlays.shallowDepth;
    seabed.mesh.visible = shallowActive;
    if (shallowActive) {
      seabed.configure(shallowDepth, worldSize, caustics.texture);
      seabed.setTime(waveT);
      // 焦散纹理与泡沫同策略：低配隔帧更新（512² 单 pass，开销小）
      if (qualityLevel !== 'low' || frameIndex % 2 === 0) {
        caustics.update(waveT, worldSize, shallowDepth, pack);
      }
    }
    ripple.update(particleDt, worldSize);

    // 水色调色深度：深水用视觉默认 80，有限物理水深用实际值——过渡插值以它
    // 为基点，避免浅水开/关时调色跳变（例如物理 10 m → 跳 80 m 再滑回来）
    const baseDepth = Number.isFinite(waveField.depth) ? waveField.depth : VISUAL_DEFAULT_DEPTH;
    const colorDepth = shallowActive
      ? baseDepth + (shallowDepth - baseDepth) * shallowMix
      : waveField.depth;
    ocean.update(pack, waveT, waveField.whitecapIntensity(), colorDepth, foam.texture, {
      causticsTex: caustics.texture,
      causticsWorldSize: worldSize,
      shallowMix,
      shallowDepth,
      rippleTex: ripple.texture,
      rippleWorldSize: ripple.available ? worldSize : 0,
    });

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
    if (qualityLevel === 'high') {
      underwaterPass.update(underwaterBlend, waveT);

      // 8.5 体积光：波面遮挡遮罩 + 径向模糊合成（强度随水下过渡增强）
      //     低配跳过：遮罩需整帧重渲染海面几何，是隐藏的渲染大头
      updateGodRays();
    }

    composer.render();

    // FPS 自适应（粗档位）：先让动态分辨率发挥（renderScale 到下限仍有富余
    // 压力才允许降档，与 SPEC §10「先降分辨率，不够再降档」的顺序一致）
    if (
      shouldAutoDowngrade(avgFrameMs, qualityLevel, autoDowngraded, simElapsed) &&
      renderScale <= RENDER_SCALE_MIN + 0.01
    ) {
      autoDowngraded = true;
      setQuality('low');
      onAutoDowngrade?.();
    }

    // 连续动态分辨率（细粒度）：档位内调像素比。预热期传入 0 帧时长（只升，
    // 首帧着色器编译的尖峰会误导降采样判定），之后按滑动平均帧时长双向调整。
    scaleTimer += dt;
    if (scaleTimer >= RENDER_SCALE_INTERVAL_S) {
      scaleTimer = 0;
      const probe = simElapsed > AUTO_DOWNGRADE_WARMUP_S ? avgFrameMs : 0;
      const next = nextRenderScale(renderScale, probe);
      if (Math.abs(next - renderScale) > 0.01) {
        renderScale = next;
        applyQuality();
      }
    }
  }

  // ---------- 点击涟漪（装饰层）：pointerup 判定「轻点」（位移小、时长短），
  // 与相机轨道拖拽互不干扰（rig 只消费拖拽增量）；射线与 y=0 静水面求交得
  // 世界点 → 涟漪高度场注入。三个视角均可点击。 ----------
  const raycaster = new THREE.Raycaster();
  const seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  let pressX = 0;
  let pressY = 0;
  let pressT = 0;
  const onRipplePointerDown = (e: PointerEvent): void => {
    pressX = e.clientX;
    pressY = e.clientY;
    pressT = performance.now();
  };
  const onRipplePointerUp = (e: PointerEvent): void => {
    if (disposed) return;
    const moved = Math.hypot(e.clientX - pressX, e.clientY - pressY);
    if (moved > 6 || performance.now() - pressT > 400) return; // 拖拽/长按不算轻点
    if (rig.isTransitioning()) return;
    const rect = threeRenderer.domElement.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), rig.camera);
    if (!raycaster.ray.intersectPlane(seaPlane, hitPoint)) return;
    const half = worldSize / 2;
    if (Math.abs(hitPoint.x) > half || Math.abs(hitPoint.z) > half) return;
    ripple.splash(hitPoint.x, hitPoint.z, worldSize);
  };
  container.addEventListener('pointerdown', onRipplePointerDown);
  window.addEventListener('pointerup', onRipplePointerUp);

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

  // ---------- 画质档位 + 连续动态分辨率 ----------
  let renderScale = RENDER_SCALE_MAX;
  let scaleTimer = 0;

  function applyQuality(): void {
    const low = qualityLevel === 'low';
    const base = low ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    threeRenderer.setPixelRatio(base * renderScale);
    composer.setPixelRatio(threeRenderer.getPixelRatio());
    composer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    bloomPass.enabled = !low;
    underwaterPass.enabled = !low;
    if (low) godRaysPass.enabled = false;
  }

  function setQuality(level: QualityLevel): void {
    if (disposed || level === qualityLevel) return;
    qualityLevel = level;
    applyQuality();
  }

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

  applyQuality(); // 初始档位生效（持久化传入 low 时像素比/后处理即降）

  return {
    start() {
      if (started || disposed) return;
      started = true;
      running = true;
      lastFrame = performance.now();
      rafId = requestAnimationFrame(frame);
    },

    setQuality,

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
      container.removeEventListener('pointerdown', onRipplePointerDown);
      window.removeEventListener('pointerup', onRipplePointerUp);
      rig.dispose();
      ocean.dispose();
      sky.dispose();
      whitecapField.dispose();
      sprayField.dispose();
      marineSnow.dispose();
      foam.dispose();
      caustics.dispose();
      seabed.dispose();
      ripple.dispose();
      maskRT.dispose();
      sunMaskMaterial.dispose();
      blackOccluder.dispose();
      tracer.dispose();
      props.dispose();
      scene.remove(rig.camera, ocean.mesh, sky.mesh, whitecapField.points, sprayField.points, marineSnow.points, tracer.group, props.group, seabed.mesh, dirLight, hemiLight);
      composer.dispose();
      threeRenderer.dispose();
      threeRenderer.forceContextLoss();
      threeRenderer.domElement.remove();
    },
  };
}
