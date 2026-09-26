/**
 * ============================================================
 * 预生成素材接入 —— docs/SPEC.md §6.6/§11（集成阶段方案）
 * ============================================================
 * 背景_AI 导师模块（src/ai，LLM/TTS/生图/生视频 Provider）已废弃并删除，
 * 教学引导与总结改用验收过的预生成素材（public/assets/，均已验收）。
 *
 * 原则（SPEC §6.6）：
 *  - 只用原生 <audio> / <video> 元素，禁止引入播放器库；
 *  - 语音全部由用户点击触发，不自动出声（开场视频例外：静音自动播放、可跳过）；
 *  - 播放/加载失败静默降级（console.warn），不弹窗、不阻塞主流程；
 *  - 素材路径相对文档根（vite base: './'），dev 与 build 行为一致。
 */
import type { ExperimentId, TaskId } from '../core/types';
import { showToast } from './toast';

// ========== 素材路径清单（public/assets/，与磁盘文件一一对应） ==========

const AUDIO_SRC: Record<
  'intro' | 'knowledge' | 'task' | 'guide',
  Record<string, string>
> = {
  intro: { welcome: 'assets/audio/00_intro.wav' },
  knowledge: {
    wind: 'assets/audio/knowledge_01_wind_waves.wav',
    interference: 'assets/audio/knowledge_02_superposition.wav',
    spectrum: 'assets/audio/knowledge_03_irregular.wav',
  },
  task: {
    whitecap: 'assets/audio/task_01_whitecap.wav',
    'max-amplitude': 'assets/audio/task_02_amplify.wav',
    'zero-amplitude': 'assets/audio/task_03_calming.wav',
    beating: 'assets/audio/task_04_beats.wav',
    'grid-pattern': 'assets/audio/task_05_crosssea.wav',
    'unknown-sea': 'assets/audio/task_06_unknown_sea.wav',
  },
  guide: {
    ruler: 'assets/audio/guide_instruments_ruler.wav',
    stopwatch: 'assets/audio/guide_instruments_stopwatch.wav',
    buoy: 'assets/audio/guide_instruments_buoy.wav',
    views: 'assets/audio/guide_views.wav',
    tracer: 'assets/audio/guide_tracer.wav',
    report: 'assets/audio/guide_report.wav',
  },
};

/** 兜底素材（映射表意外缺键时使用，保证永不返回 undefined 路径） */
const FALLBACK_AUDIO = 'assets/audio/00_intro.wav';

/** 首屏氛围图（boot 加载背景） */
export function heroImageSrc(): string {
  return 'assets/images/hero-lab.png';
}

/** 任务现象配图：六个任务各一张案例图（真实海况照片素材） */
export function taskCaseImageSrc(taskId: TaskId): string | null {
  switch (taskId) {
    case 'whitecap':
      return 'assets/images/case-whitecap.png';
    case 'grid-pattern':
      return 'assets/images/case-crosssea.png';
    case 'max-amplitude':
      return 'assets/images/case-constructive.png';
    case 'zero-amplitude':
      return 'assets/images/case-calm.png';
    case 'beating':
      return 'assets/images/case-wavegroup.png';
    case 'unknown-sea':
      return 'assets/images/case-buoy-obs.png';
    default:
      return null;
  }
}

/** 实验报告分享卡片底图 */
export function shareCardImageSrc(): string {
  return 'assets/images/share-card.png';
}

/** 开场短片 */
export function introVideoSrc(): string {
  return 'assets/video/intro-ocean.mp4';
}

// ========== 语音播放（全局单 <audio>，点击触发，失败静默） ==========

let voiceAudio: HTMLAudioElement | null = null;

function ensureVoiceAudio(): HTMLAudioElement {
  if (!voiceAudio) {
    voiceAudio = new Audio();
    voiceAudio.preload = 'none';
    voiceAudio.addEventListener('error', () => {
      console.warn('[media] 语音素材加载/播放失败（静默降级）', voiceAudio?.src);
    });
  }
  return voiceAudio;
}

/** 任务语音引导：六个任务各一段（task_01 ~ task_06） */
export function taskVoiceSrc(taskId: TaskId): string {
  return AUDIO_SRC.task[taskId] ?? FALLBACK_AUDIO;
}

/** 实验知识点语音：三个实验各一段（knowledge_01 ~ knowledge_03） */
export function knowledgeVoiceSrc(experimentId: ExperimentId): string {
  return AUDIO_SRC.knowledge[experimentId] ?? FALLBACK_AUDIO;
}

/** 开场欢迎语音（可由 UI 预留入口调用） */
export function introVoiceSrc(): string {
  return FALLBACK_AUDIO;
}

/** 仪器教程 / 操作指南语音：guide_*.wav（键见 AUDIO_SRC.guide） */
export function guideVoiceSrc(name: string): string {
  return AUDIO_SRC.guide[name] ?? FALLBACK_AUDIO;
}

// ========== 实拍案例视频与海况图鉴（真实海况素材，点击触发） ==========

/** 实拍案例视频清单：键 → { 标题, 路径 }（public/assets/video/） */
export const CASE_VIDEOS: Record<string, { title: string; src: string }> = {
  breaking: { title: '白帽破碎 · 强风下的波峰失稳', src: 'assets/video/video-breaking.mp4' },
  crosssea: { title: '交叉浪 · 两波系织成菱形网格', src: 'assets/video/video-crosssea.mp4' },
  wavegroup: { title: '波群 · 涌浪成群推进（拍的原型）', src: 'assets/video/video-wavegroup.mp4' },
  buoy: { title: '海洋观测浮标 · 随波起伏', src: 'assets/video/video-buoy.mp4' },
};

/** 海况图鉴清单：键 → { 标题, 路径 }（public/assets/images/） */
export const CASE_GALLERY: Record<string, { title: string; src: string }> = {
  underwater: { title: '水下仰视 · 波面与光柱', src: 'assets/images/scene-underwater.png' },
  'wind-streaks': { title: '风纹 · 毛细波诞生', src: 'assets/images/scene-wind-streaks.png' },
  storm: { title: '风暴海况 · 充分发展的极端海面', src: 'assets/images/scene-storm.png' },
  orbits: { title: '质点轨迹 · 深水圆周随深度衰减（示意）', src: 'assets/images/diagram-orbits.png' },
  hero: { title: '海洋动力虚拟实验室', src: 'assets/images/hero-lab.png' },
};

/**
 * 播放一段语音（互斥：新播放会打断上一段）。
 * 成功开播时 toast 提示一次；加载/播放失败静默（不弹窗、不抛错）。
 */
export function playVoice(src: string): void {
  if (typeof document === 'undefined' || typeof Audio === 'undefined') return;
  try {
    const audio = ensureVoiceAudio();
    audio.pause();
    audio.src = src;
    audio.addEventListener(
      'playing',
      () => showToast('正在播放语音讲解', 'info', 2200),
      { once: true },
    );
    void audio.play().catch(() => {
      /* 静默：素材缺失 / 浏览器自动播放策略 / 编码不支持 */
    });
  } catch {
    /* 静默 */
  }
}

// ========== 开场短片浮层（hero-lab 氛围底 + intro-ocean.mp4，可跳过） ==========

/**
 * 显示开场浮层：hero-lab.png 氛围底图 + intro-ocean.mp4（静音自动播放）。
 * 播放结束 / 用户点击跳过 / 视频加载失败 ⇒ 浮层自动移除，主界面照常可用。
 * 若 <video> 不被支持（极端环境），直接移除浮层并回落到 hero 底图一闪而过。
 */
export function showIntroOverlay(): void {
  if (typeof document === 'undefined') return;
  try {
    const overlay = document.createElement('div');
    overlay.className = 'ui-intro';
    // 氛围底图由 JS 内联设置（CSS 内相对 url 打包后会相对 CSS 文件解析，不可靠）
    overlay.style.backgroundImage = `linear-gradient(rgba(4, 31, 34, 0.55), rgba(4, 31, 34, 0.8)), url("${heroImageSrc()}")`;
    overlay.style.backgroundSize = 'cover';
    overlay.style.backgroundPosition = 'center';
    overlay.setAttribute('aria-label', '开场短片（可跳过）');

    const video = document.createElement('video');
    video.className = 'ui-intro__video';
    video.src = introVideoSrc();
    video.muted = true; // 静音自动播放是浏览器允许的唯一形态
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'ui-intro__skip';
    skip.textContent = '跳过开场 ›';

    const close = (): void => {
      overlay.remove();
      video.pause();
    };
    skip.addEventListener('click', close);
    video.addEventListener('ended', close);
    video.addEventListener('error', close); // 素材缺失 ⇒ 静默回落主界面

    overlay.append(video, skip);
    document.body.appendChild(overlay);
    void video.play().catch(() => {
      /* 自动播放被拒 ⇒ 用户可手动跳过或等待 ended 不触发；5s 后兜底关闭 */
      window.setTimeout(() => {
        if (overlay.isConnected) close();
      }, 5000);
    });
  } catch {
    /* 静默：开场浮层绝不阻塞主流程 */
  }
}

/**
 * 案例视频浮层（用户点击触发，带声音与控制条）。
 * 关闭 / 播放结束 / 加载失败 ⇒ 浮层移除，绝不阻塞主流程。
 */
export function showCaseVideo(title: string, src: string): void {
  if (typeof document === 'undefined') return;
  try {
    const overlay = document.createElement('div');
    overlay.className = 'ui-intro ui-caseview';
    overlay.setAttribute('aria-label', title);

    const bar = document.createElement('div');
    bar.className = 'ui-caseview__bar';
    const caption = document.createElement('span');
    caption.className = 'ui-caseview__title';
    caption.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ui-intro__skip';
    closeBtn.textContent = '关闭 ×';
    bar.append(caption, closeBtn);

    const video = document.createElement('video');
    video.className = 'ui-intro__video ui-caseview__video';
    video.src = src;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-label', title);

    const close = (): void => {
      overlay.remove();
      video.pause();
    };
    closeBtn.addEventListener('click', close);
    video.addEventListener('ended', close);
    video.addEventListener('error', () => {
      close();
      console.warn('[media] 案例视频加载失败（静默降级）', src);
    });

    overlay.append(bar, video);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    void video.play().catch(() => {
      /* 自动播放被拒 ⇒ 用户手动点播放即可 */
    });
  } catch {
    /* 静默 */
  }
}

/** 海况图鉴查看器：全屏 lightbox 展示一张图，点击任意处关闭。 */
export function showGalleryImage(title: string, src: string): void {
  if (typeof document === 'undefined') return;
  try {
    const overlay = document.createElement('div');
    overlay.className = 'ui-intro ui-caseview';
    overlay.setAttribute('aria-label', title);

    const bar = document.createElement('div');
    bar.className = 'ui-caseview__bar';
    const caption = document.createElement('span');
    caption.className = 'ui-caseview__title';
    caption.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ui-intro__skip';
    closeBtn.textContent = '关闭 ×';
    bar.append(caption, closeBtn);

    const img = document.createElement('img');
    img.className = 'ui-caseview__img';
    img.alt = title;
    img.addEventListener('error', () => {
      close();
      console.warn('[media] 图鉴素材加载失败（静默降级）', src);
    });
    img.src = src;

    const close = (): void => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target === img) close();
    });

    overlay.append(bar, img);
    document.body.appendChild(overlay);
  } catch {
    /* 静默 */
  }
}

// ========== 实验分享卡片（share-card.png 底图 + 关键读数 → PNG 下载） ==========

export interface ShareCardData {
  experimentLabel: string;
  /** 有效波高 Hs（m） */
  hs: number;
  /** 谱峰周期 Tp（s） */
  tp: number;
  /** 已完成任务数 / 总数 */
  tasksDone: number;
  tasksTotal: number;
  /** 仿真时间（s） */
  simTime: number;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * 生成分享卡片 PNG Blob（share-card.png 底图 + 参数读数覆盖层）。
 * 素材缺失 / canvas 不可用 ⇒ 返回 null（调用方提示后静默）。
 */
export async function buildShareCard(data: ShareCardData): Promise<Blob | null> {
  try {
    if (typeof document === 'undefined') return null;
    const base = await loadImage(shareCardImageSrc());
    const canvas = document.createElement('canvas');
    // 16:9 输出（适配社交分享），底图 cover 铺满
    canvas.width = 1200;
    canvas.height = 675;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    if (base) {
      const scale = Math.max(canvas.width / base.width, canvas.height / base.height);
      const w = base.width * scale;
      const h = base.height * scale;
      ctx.drawImage(base, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#041F22';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 底部信息条：半透明深底保证文字可读
    const barH = 190;
    const grad = ctx.createLinearGradient(0, canvas.height - barH, 0, canvas.height);
    grad.addColorStop(0, 'rgba(4,31,34,0)');
    grad.addColorStop(0.35, 'rgba(4,31,34,0.82)');
    grad.addColorStop(1, 'rgba(4,31,34,0.94)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, canvas.height - barH, canvas.width, barH);

    const padX = 48;
    const baseY = canvas.height - 44;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#7FD4C1';
    ctx.font = '600 34px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText('海水运动的基本方程 · 海浪动力学虚拟探索实验', padX, baseY - 96);
    ctx.fillStyle = '#E8F5F1';
    ctx.font = '28px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText(`当前实验：${data.experimentLabel}`, padX, baseY - 50);
    ctx.fillText(
      `理论海况　Hs ${fmt(data.hs)} m　Tp ${fmt(data.tp)} s`,
      padX + 420,
      baseY - 50,
    );
    ctx.fillStyle = '#9DC3BC';
    ctx.font = '22px Consolas, monospace';
    ctx.fillText(
      `任务进度 ${data.tasksDone}/${data.tasksTotal}　·　仿真时间 ${Math.round(data.simTime)} s　·　${new Date().toLocaleDateString('zh-CN')}`,
      padX,
      baseY,
    );

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  } catch {
    return null;
  }
}

/** 触发浏览器下载一个 Blob（失败静默，返回是否成功） */
export function downloadBlob(blob: Blob, filename: string): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
