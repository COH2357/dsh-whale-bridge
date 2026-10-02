/**
 * dsh-whale-bridge — 客户端半。
 *
 * 把 pet-whale（桌宠鲸鱼）与 dsh-whale-widget（余额/用量挂件鲸鱼）串起来。
 * 两个被串联的插件都没有对外 API（pet-whale 只有 DOM + localStorage，
 * dsh-whale-widget 只暴露 window.__dshWhaleRoot），所以本桥接只能在浏览器侧
 * 用「合成 DOM 事件」驱动它们的既有交互，源文件一行都不用改：
 *
 *   1) 每 200ms 量一次两者的贴图矩形，算最近间距 gap（相交为 0）。
 *   2) gap ≤ nearGapPx 持续 pretendSettleMs → 合成 contextmenu 打开 pet-whale
 *      的右键菜单，并在同一个 task 里点掉「💼 假装工作」（中英标签都含 💼）。
 *      菜单在同一个同步任务内被点掉，浏览器不会把它绘制出来 → 用户看不到闪。
 *      gap > releaseGapPx（迟滞）持续 releaseSettleMs → 仅当这次是本桥接打开的
 *      才再点一次关掉；用户手动开关的状态不会被抢。
 *   3) 挂件「扫到」桌宠（默认只用朝向屏幕中心的那半边贴图当视野）→ 合成
 *      pointerdown/pointerup 点一下挂件鲸鱼：默认气泡第 1 项（余额）出现；等
 *      ~400ms 再对气泡派发 click → bubbleNext() 前进到第 2 项，即挂件自带的
 *      默认台词文字。整轮带 speakIntervalMs 间隔与失败退避，避免文字闪烁。
 *   4) 假装工作期间把桌宠贴图转向挂件：朝右就镜像（scaleX(-1)），并按与挂件的
 *      垂直偏差歪头（rotate，>0 抬头；再叠一点 skewY 当仰角）看着它。全部写在内层
 *      svg 的 inline style 上（与父级 pw-swim 动画正交，也不加 !important）；拖拽期
 *      方向锁定不翻面、角度实时跟手，松手后再按落点刷新，翻面/歪头都带过渡动画。
 *      注：拖拽期 pet-whale 自己也会镜像父级（`.dragging[data-facing="right"]`），
 *      这时子级的镜像按父级状态反向抵消，净朝向仍等于挂件所在的一侧。
 *
 * 命中判定说明：挂件的 isWhaleHit() 只看事件的 clientX/clientY（把坐标映射进
 * 610×610 的 alpha 贴图），所以合成事件用真实屏幕坐标即可，派发目标只为绕开
 * 它自身的排除分支（.dshwv-pop / 菜单等）。
 *
 * 配置优先级：内置默认 ← localStorage['dsh-whale-bridge:config'] ← 设置页
 * 命名空间 'dsh-whale-bridge'（每 15s 读一次 api.settings.describe()）。
 * 运行期可直接用 window.__dshWhaleBridge 调试或改配置。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-bridge',
  factory() {
    const VERSION = '0.3.2';

    /** 几何/状态轮询间隔 */
    const TICK_MS = 200;
    /** 设置命名空间（= profile 条目 id） */
    const SETTINGS_NS = 'dsh-whale-bridge';
    /** 远端设置轮询间隔 */
    const SETTINGS_POLL_MS = 15000;

    /** 本地配置键（window.__dshWhaleBridge.setConfig 写这里） */
    const CONFIG_KEY = 'dsh-whale-bridge:config';
    /** 本桥接「拥有」桌宠假装工作状态的标记（页面刷新后据此重新接管） */
    const OWNED_KEY = 'dsh-whale-bridge:owned';
    /** pet-whale 自己的假装工作键 */
    const PRETEND_KEY = 'pet-whale:pretend';

    /** 一次播报的整轮超时 */
    const SPEAK_OPEN_TIMEOUT_MS = 6000;
    /** 点鲸鱼失败后的重试间隔（挂件菜单开着时第一次 pointerdown 只会关菜单） */
    const SPEAK_RETRY_MS = 450;
    /** 点鲸鱼的最大尝试次数（每次换一个贴图内的候选点） */
    const SPEAK_MAX_ATTEMPTS = 3;
    /** 气泡出现后等待多久再点气泡（让第 1 项先画出来） */
    const SPEAK_ADVANCE_DELAY_MS = 400;
    /** 播报失败后的退避 */
    const SPEAK_FAIL_BACKOFF_MS = 4000;
    /** 退出假装工作连续失败多少次后放弃（避免反复切换） */
    const RELEASE_MAX_FAILURES = 5;

    /** 假装工作菜单项标签特征（中英两版都含 💼） */
    const PRETEND_LABEL_HINTS = ['💼', '假装', 'pretend'];

    const PET_ROOT_SELECTOR = '[data-dsh-whale]';
    const PET_SPRITE_SELECTOR = '.pet-official';
    const PET_MENU_SELECTOR = '.dsh-whale-menu';
    const WIDGET_ROOT_SELECTOR = '.dshwv-root';
    const WIDGET_SPRITE_SELECTOR = '.dshwv-img';
    const WIDGET_BUBBLE_SELECTOR = '.dshwv-pop';
    const WIDGET_BUBBLE_OPEN_CLASS = 'dshwv-pop-open';
    const WIDGET_FACING_CLASS = 'dshwv-left';

    /** pet-whale 拖拽期的根类：拖拽期它自己按 data-facing 镜像，我们按它反向抵消 */
    const PET_DRAGGING_CLASS = 'dragging';
    /** 0.2.x 注入过的样式表 id，0.3.0 起不再使用，仅用于把它清理掉 */
    const FACE_STYLE_ID = 'dsh-whale-bridge-face-style';
    /** 写在桌宠根节点上的朝向标记（接管期间 = 当前朝向 'left' | 'right'） */
    const FACE_ATTR = 'data-whale-bridge-face';

    /** pet-whale 自己注入的样式表 id：本桥接只守护它，不动它的源文件 */
    const PET_STYLE_ID = 'pet-whale-style';
    /**
     * pet-whale 这条 profile 条目的 id。DSH 客户端模块系统按 data-plugin 记录
     * <style> 的归属，所以打上它自己的名字最合适：只有 pet-whale 自己被重载时
     * DSH 才会回收它，而那一刻 pet-whale 会立刻重建一份新的。
     */
    const PET_PLUGIN_ID = 'pet-whale';
    /** 本桥接补写的那份样式表会带这个标记（用来区分「pet-whale 自己写的」） */
    const PET_STYLE_REPAIR_ATTR = 'data-whale-bridge-repaired';
    /** 真样式表文本的缓存键（跨页面刷新留着，下次不必再挖矿） */
    const PET_STYLE_CACHE_KEY = 'dsh-whale-bridge:pet-css';
    /** 短于这个长度的一律不写进缓存（占位或半截内容没有价值） */
    const PET_STYLE_CACHE_MIN_CHARS = 400;
    /** 挖矿结果至少这么长才算 pet-whale 的样式表（免得把注释里的字样当成 CSS） */
    const PET_STYLE_MINE_MIN_CHARS = 2000;

    /**
     * 兜底样式表的取用顺序（见 guardPetStyle）：
     *   1. 本会话见到过的真样式表文本（state.petStyleText）
     *   2. 上次会话缓存进 localStorage 的真样式表文本（PET_STYLE_CACHE_KEY）
     *   3. 现场从 DSH 模块加载器里挖出来的 pet-whale 工厂源码中的 WHALE_CSS
     *      （版本永远与装着的 pet-whale 同步；见 minePetStyleCss）
     *   4. 下面这份内嵌快照（仅当 1-3 都不可用时才用）
     *
     * 0.3.1 的教训：当初的兜底只写了「压住灾难」的几条规则 —— 没有恢复
     * `[data-dsh-whale] .pet-official` 的 `pointer-events:auto`（桌宠收不到拖拽），
     * 也没有隐藏 `.dsh-whale-menu`（菜单常驻展开、把页面撑开）。结论：
     * 兜底要么就是真样式，要么就根本不要接管。
     */
    // >>> pet-whale WHALE_CSS 快照（由 E:\1\_embed_pet_css.mjs 生成，勿手改）
    const PET_STYLE_FALLBACK_CSS = `
[data-dsh-whale] .pet-official,
[data-dsh-whale-mini] {
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
[data-dsh-whale] {
  --pw-ink: #2E2A24;
  --pw-body-light: #8FB5FF;
  --pw-body: #4D6BFE;
  --pw-body-dark: #3550C9;
  --pw-blush: #F0A0A0;
  --pw-eye: #2E2A24;
  --pw-pupil: #FBF8F0;
  /* 尺寸总闸：只改这一个变量，下面所有几何都跟着走 */
  --pw-scale: 1;
  position: fixed;
  z-index: 900;
  width: calc(137px * var(--pw-scale));
  height: calc(101px * var(--pw-scale));
  pointer-events: none;
  user-select: none;
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}

/* 隐藏模式：整只收起来，只留右下角小按钮 */
[data-dsh-whale].hidden { display: none !important; }

/* 右下角召回小按钮（挂在 body 上，独立于鲸鱼本体） */
[data-dsh-whale-mini] {
  position: fixed;
  right: 14px;
  bottom: 14px;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,.22);
  background: linear-gradient(160deg, #4D6BFE, #2E3F9E);
  color: #fff;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(0,0,0,.28);
  z-index: 901;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  transition: transform .18s ease, box-shadow .18s ease;
}
[data-dsh-whale-mini]:hover {
  transform: translateY(-2px) scale(1.07);
  box-shadow: 0 10px 24px rgba(0,0,0,.36);
}
[data-dsh-whale-mini]:active { transform: scale(.94); }

/* 小按钮随 agent 状态变色呼吸：idle 蓝 / think 深蓝 / working 橙 / celebrate 绿 / error 红 */
[data-dsh-whale-mini] { animation: pw-mini-breathe 3.2s ease-in-out infinite; }
[data-dsh-whale-mini][data-state="think"] { background: linear-gradient(160deg, #6E8BFF, #3D55D6); animation: pw-mini-think 1.6s ease-in-out infinite; }
[data-dsh-whale-mini][data-state="working"] { background: linear-gradient(160deg, #F5A623, #C97B0B); animation: pw-mini-work 0.8s ease-in-out infinite; }
[data-dsh-whale-mini][data-state="celebrate"] { background: linear-gradient(160deg, #3BC46D, #1E8A4A); animation: pw-mini-celebrate 0.9s ease-in-out infinite; }
[data-dsh-whale-mini][data-state="error"] { background: linear-gradient(160deg, #E5484D, #A61B20); animation: pw-mini-error 0.5s ease-in-out infinite; }
[data-dsh-whale-mini].dragging { cursor: move; animation: none !important; transition: none; }

/* 思考内容滚动条：think 时悬在桌宠正上方，内容向左缓慢滚动 */
[data-dsh-whale-think] {
  position: fixed;
  left: 50%;
  top: 0;
  transform: translate(-50%, -100%);
  display: none;
  align-items: center;
  gap: 8px;
  width: auto;
  max-width: 360px;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(30, 34, 46, .82);
  color: #CFE0FF;
  font: 12px/1.4 ui-monospace, Consolas, "Courier New", monospace;
  border: 1px solid rgba(139,160,255,.25);
  box-shadow: 0 6px 20px rgba(0,0,0,.25);
  pointer-events: none;
  z-index: 899;
  white-space: nowrap;
  overflow: hidden;
}
[data-dsh-whale-think].show { display: flex; }
[data-dsh-whale-think] .dsh-whale-think-label { flex: none; opacity: .85; }
[data-dsh-whale-think] .dsh-whale-think-scroll { flex: 1; overflow: hidden; }
[data-dsh-whale-think] .dsh-whale-think-text {
  display: inline-block;
  will-change: transform;
  max-width: none;
}

[data-dsh-whale] .pet-official {
  width: calc(137px * var(--pw-scale));
  height: calc(101px * var(--pw-scale));
  position: relative;
  cursor: grab;
  pointer-events: auto;
}
[data-dsh-whale] .pet-official:active { cursor: grabbing; }
[data-dsh-whale] .pet-official svg {
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
  transform-origin: 50% 85%;
}

/* 地面阴影：独立兄弟元素，钉在地面，鲸鱼的任何动画（翻滚/跃起/深潜）都不带动它 */
[data-dsh-whale] .dsh-whale-shadow {
  position: absolute;
  left: 50%;
  bottom: calc(-12px * var(--pw-scale));
  width: calc(79px * var(--pw-scale));
  height: calc(12px * var(--pw-scale));
  margin-left: calc(-40px * var(--pw-scale));
  background: radial-gradient(ellipse, rgba(46,42,36,.24), transparent 65%);
  border-radius: 50%;
  animation: pw-shadowBob 3.2s ease-in-out infinite;
  pointer-events: none;
}

/* 游动时的水流尾波光晕 */
[data-dsh-whale] .dsh-whale-wake {
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(146px * var(--pw-scale));
  height: calc(96px * var(--pw-scale));
  margin-left: calc(-73px * var(--pw-scale));
  margin-top: calc(-48px * var(--pw-scale));
  border-radius: 50%;
  background: radial-gradient(ellipse at center, rgba(143, 181, 255, 0.28) 0%, rgba(77, 107, 254, 0.08) 50%, transparent 72%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.35s ease;
  filter: blur(4px);
  z-index: 1;
}
[data-dsh-whale].swimming .dsh-whale-wake {
  opacity: 1;
  animation: pw-wakePulse 1.6s ease-in-out infinite alternate;
}

/* 泡泡（庆祝 + 点击） */
[data-dsh-whale] .bubble {
  position: absolute;
  left: 50%;
  bottom: 5px;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  border-radius: 50%;
  background: rgba(232,217,188,.9);
  border: 1px solid rgba(46,42,36,.15);
  opacity: 0;
  pointer-events: none;
}
[data-dsh-whale] .bubble::after {
  content: "";
  position: absolute;
  left: 1.4px;
  top: 1.4px;
  width: 2.2px;
  height: 2.2px;
  border-radius: 50%;
  background: rgba(255,255,255,.85);
}
[data-dsh-whale] .bubble.show { animation: pw-rise 0.9s ease-out forwards; }

/* 深潜蓝泡 */
[data-dsh-whale] .bubble-blue {
  position: absolute;
  left: 50%;
  bottom: 4.5px;
  width: 6px;
  height: 6px;
  margin-left: -3.2px;
  border-radius: 50%;
  background: rgba(168,200,232,.78);
  border: 1px solid rgba(96,138,190,.4);
  opacity: 0;
  pointer-events: none;
}
[data-dsh-whale] .bubble-blue::after {
  content: "";
  position: absolute;
  left: 1.4px;
  top: 1.4px;
  width: 1.8px;
  height: 1.8px;
  border-radius: 50%;
  background: rgba(255,255,255,.85);
}

/* ===== 状态动画 ===== */
[data-dsh-whale] .pet-official .body { animation: pw-qbob 3.2s ease-in-out infinite; }
[data-dsh-whale] .pet-official .eye-group { animation: pw-blink 4.5s ease-in-out infinite; transform-origin: 5.55px 5.7px; }

[data-dsh-whale] .pet-official.think { animation: pw-dive2 3.2s ease-in-out infinite; }
[data-dsh-whale] .pet-official.think .bubble-blue { animation: pw-riseBlue 3.2s ease-out infinite; }
[data-dsh-whale] .pet-official.think .bubble-blue.bb2 { animation-delay: 0.9s; }
[data-dsh-whale] .pet-official.think .bubble-blue.bb3 { animation-delay: 1.8s; }

  [data-dsh-whale] .pet-official.swim-dive,
  [data-dsh-whale] .pet-official.swimming-dive { animation: pw-dive2 1.6s ease-in-out; filter: drop-shadow(0 6px 14px rgba(53, 80, 201, 0.28)); }
  [data-dsh-whale] .pet-official.swim-dive .bubble-blue,
  [data-dsh-whale] .pet-official.swimming-dive .bubble-blue { display: block; animation: pw-riseBlue 1.2s ease-out infinite; }
  [data-dsh-whale] .pet-official.swimming .body { animation: pw-swimBody 0.85s ease-in-out infinite alternate; }


[data-dsh-whale] .pet-official.working { animation: pw-swim 1.1s ease-in-out infinite; }
[data-dsh-whale] .pet-official.working .body { animation: none; }
[data-dsh-whale] .pet-official.working .keyboard-unit { display: block !important; }
[data-dsh-whale] .pet-official.working .code-particle { display: block !important; }

/* 思考：眼珠右上凝视 + 灵动高光微呼吸 */
[data-dsh-whale] .pet-official.think .pupil-highlight {
  animation: pw-pupilGaze 2s ease-in-out infinite alternate;
}

/* 报错：晕眩叉叉眼 */
[data-dsh-whale] .pet-official.error { animation: pw-shake 0.5s ease-in-out infinite; }
[data-dsh-whale] .pet-official.error .angry { display: block !important; animation: pw-angryJitter 0.5s ease-in-out infinite; }
[data-dsh-whale] .pet-official.error .eye-group .eye,
[data-dsh-whale] .pet-official.error .eye-group .pupil-highlight { opacity: 0 !important; }
[data-dsh-whale] .pet-official.error .eye-group .dizzy-eyes {
  display: inline !important;
  transform-origin: 5.55px 5.7px;
  animation: pw-dizzyShake 0.4s ease-in-out infinite alternate;
}

/* 休眠：安详月牙眼 */
[data-dsh-whale].sleeping .eye-group .eye,
[data-dsh-whale].sleeping .eye-group .pupil-highlight { opacity: 0 !important; }
[data-dsh-whale].sleeping .eye-group .sleep-eyes { display: inline !important; }

/* 开心态 */
[data-dsh-whale] .pet-official.joy {
  animation: pw-joyHop 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
}
[data-dsh-whale] .pet-official.joy .eye-group .eye,
[data-dsh-whale] .pet-official.joy .eye-group .pupil-highlight { opacity: 0 !important; }
[data-dsh-whale] .pet-official.joy .eye-group .sleep-eyes { display: inline !important; }

/* 戳晕态 */
[data-dsh-whale] .pet-official.dizzy {
  animation: pw-dizzyWobble 0.8s ease-in-out !important;
}
[data-dsh-whale] .pet-official.dizzy .eye-group .eye,
[data-dsh-whale] .pet-official.dizzy .eye-group .pupil-highlight { opacity: 0 !important; }
[data-dsh-whale] .pet-official.dizzy .eye-group .dizzy-eyes {
  display: inline !important;
  transform-origin: 5.55px 5.7px;
  animation: pw-dizzyShake 0.35s ease-in-out infinite alternate;
}

/* 甩晕态：抓着左右猛甩的结果 */
[data-dsh-whale] .pet-official.shaken .eye-group .eye,
[data-dsh-whale] .pet-official.shaken .eye-group .pupil-highlight { opacity: 0 !important; }
/* 正晕着比被抓住更该被看见，所以压过拖拽的眯眼 */
[data-dsh-whale].dragging .pet-official.shaken .eye-group .caught-eyes { display: none !important; }
[data-dsh-whale] .pet-official.shaken .eye-group .dizzy-eyes {
  display: inline !important;
  transform-origin: 5.55px 5.7px;
  animation: pw-dizzyShake 0.22s ease-in-out infinite alternate;
}
/* 身体只在松手后才摇：还攥在手里的时候它本来也动不了，
   而且拖拽态给 .pet-official 上了 !important 的 transform，动画压不过 */
[data-dsh-whale]:not(.dragging) .pet-official.shaken {
  animation: pw-dizzyWobble 0.7s ease-in-out 2 !important;
}

/* 翻肚皮：双击的专属反应 */
[data-dsh-whale] .pet-official.belly-up {
  animation: pw-bellyUp 2s cubic-bezier(0.34, 1.4, 0.64, 1) !important;
}
[data-dsh-whale] .pet-official.belly-up .eye-group .eye,
[data-dsh-whale] .pet-official.belly-up .eye-group .pupil-highlight { opacity: 0 !important; }
/* 借用弯月眼——翻着肚皮眯眼笑正是它该有的样子 */
[data-dsh-whale] .pet-official.belly-up .eye-group .sleep-eyes { display: inline !important; }

/* 贴边挤扁：横向压扁，方向由贴的是哪边决定 */
/* 后两条是为了压过拖拽态的 animation:none——特异性相同则后定义者胜，
   而那条规则写在本段之后，只靠前两条会被它盖掉 */
[data-dsh-whale].edge-left .pet-official .body,
[data-dsh-whale].edge-right .pet-official .body,
[data-dsh-whale].dragging.edge-left .pet-official .body,
[data-dsh-whale].dragging.edge-right .pet-official .body {
  transform-origin: 50% 50%;
  animation: pw-squeeze 0.35s ease-out forwards !important;
}
/* 上下压扁：锚在被压的那条边上，看着才像真被按住 */
[data-dsh-whale].edge-top .pet-official .body,
[data-dsh-whale].dragging.edge-top .pet-official .body {
  transform-origin: 50% 0%;
  animation: pw-squash 0.35s ease-out forwards !important;
}
[data-dsh-whale].edge-bottom .pet-official .body,
[data-dsh-whale].dragging.edge-bottom .pet-official .body {
  transform-origin: 50% 100%;
  animation: pw-squash 0.35s ease-out forwards !important;
}

/* 拖着不放又不动：晃着腰表示不耐烦 */
[data-dsh-whale].dragging .pet-official.impatient .body {
  animation: pw-impatientSway 0.9s ease-in-out infinite !important;
}

/* 连戳中段：不耐烦，侧身躲一下 */
[data-dsh-whale] .pet-official.annoyed {
  animation: pw-annoyedDodge 0.5s cubic-bezier(0.34, 1.4, 0.64, 1) !important;
}

/* 连戳过头：闹脾气，扭头 + 吊眉怒眼 */
[data-dsh-whale] .pet-official.sulking {
  animation: pw-sulkTurn 0.6s cubic-bezier(0.34, 1.4, 0.64, 1) forwards !important;
}
/* 生气不闭眼：眼睛留着瞪人，只加一道吊眉 */
[data-dsh-whale] .pet-official.sulking .eye-group .angry-eyes { display: inline !important; }

/* 欢迎态 */
[data-dsh-whale] .pet-official.welcome {
  animation: pw-leap2 1.2s ease-in-out !important;
}
[data-dsh-whale] .pet-official.welcome .stars { display: block !important; }
[data-dsh-whale] .pet-official.welcome .spout-group {
  display: inline !important;
  transform-origin: 8.6px 1.2px;
  animation: pw-spoutSpray 1.1s cubic-bezier(0.2, 0.8, 0.35, 1);
}

/* 庆祝与喷水柱 */
[data-dsh-whale] .pet-official.celebrate { animation: pw-leap2 1.4s ease-in-out infinite; }
/* 笑眼只在没有别的表情抢眼睛时出现：庆祝中被戳、甩晕、翻肚皮，各用各的眼睛 */
[data-dsh-whale]:not(.dragging) .pet-official.celebrate:not(.joy):not(.dizzy):not(.shaken):not(.belly-up):not(.petting) .eye-group .eye,
[data-dsh-whale]:not(.dragging) .pet-official.celebrate:not(.joy):not(.dizzy):not(.shaken):not(.belly-up):not(.petting) .eye-group .pupil-highlight { opacity: 0 !important; }
[data-dsh-whale]:not(.dragging) .pet-official.celebrate:not(.joy):not(.dizzy):not(.shaken):not(.belly-up):not(.petting) .eye-group .happy-eyes { display: inline !important; }
/* 笑眯着的眼睛不眨：一眨就压成一条横线，看着像睡着了 */
[data-dsh-whale] .pet-official.celebrate .eye-group { animation: none; }
[data-dsh-whale] .pet-official.celebrate .stars { display: block !important; }
[data-dsh-whale] .pet-official.celebrate .starL { animation: pw-starSpin 1.2s ease-in-out infinite; }
[data-dsh-whale] .pet-official.celebrate .starR { animation: pw-starSpin 1.2s ease-in-out 0.3s infinite; }
[data-dsh-whale] .pet-official.celebrate .bubble { animation: pw-rise 1.2s ease-out 0.3s infinite; }
[data-dsh-whale] .pet-official.celebrate .bubble.b2 { animation-delay: 0.7s; }
[data-dsh-whale] .pet-official.celebrate .bubble.b3 { animation-delay: 1.05s; }
[data-dsh-whale] .pet-official.celebrate .spout-group,
[data-dsh-whale] .pet-official.spouting .spout-group {
  display: inline !important;
  transform-origin: 8.6px 1.2px;
  animation: pw-spoutSpray 1.3s cubic-bezier(0.2, 0.8, 0.35, 1) infinite;
}

/* 摸头：你的鼠标在它头顶来回蹭。眯眼、腮红变深，每蹭一下头顶被按下去一点 */
[data-dsh-whale].patting .pet-official { cursor: ; }
[data-dsh-whale] .pet-official.petting .eye-group { animation: none; }
[data-dsh-whale] .pet-official.petting .eye-group .eye,
[data-dsh-whale] .pet-official.petting .eye-group .pupil-highlight { opacity: 0 !important; }
[data-dsh-whale] .pet-official.petting .eye-group .sleep-eyes { display: inline !important; }
[data-dsh-whale] .pet-official .blush { transition: opacity 0.3s ease; }
[data-dsh-whale] .pet-official.petting .blush { opacity: 0.9; }
[data-dsh-whale] .pet-official.pat-press .body {
  transform-origin: 50% 100%;
  animation: pw-patPress 0.3s ease-out !important;
}
[data-dsh-whale] .pat-heart {
  position: absolute;
  left: 26%;
  top: 0;
  color: #F07A8E;
  font-size: calc(15px * var(--pw-scale));
  line-height: 1;
  opacity: 0;
  pointer-events: none;
}
[data-dsh-whale] .pat-heart.show { animation: pw-heartFloat 1.1s ease-out forwards; }

/* 背部粼粼波光折射 */
[data-dsh-whale] .caustic-shimmer {
  animation: pw-causticDrift 4.2s ease-in-out infinite alternate;
}

[data-dsh-whale] .pet-official.wait { animation: pw-wait 1.2s ease-in-out infinite; }
[data-dsh-whale] .pet-official.wait .bubble-blue { display: block; animation: pw-riseBlue 1.2s ease-out infinite; }
[data-dsh-whale] .pet-official.disappointed { animation: pw-disappointed 2.6s ease-in-out infinite; }
/* 失落：眼珠往下垂、高光缩小，配八字眉和一滴往下掉的眼泪 */
[data-dsh-whale] .pet-official.disappointed .eye-group .eye { transform: translateY(0.25px); }
[data-dsh-whale] .pet-official.disappointed .eye-group .pupil-highlight { transform: translate(-0.12px, 0.45px) scale(0.7); transform-origin: 5.92px 5.35px; }
[data-dsh-whale] .pet-official.disappointed .eye-group .sad-eyes { display: inline !important; }
[data-dsh-whale] .pet-official.disappointed .tear {
  display: inline !important;
  animation: pw-tearDrop 1.3s ease-in infinite;
}


/* 双击翻滚特技 */
[data-dsh-whale] .pet-official.rolling { animation: pw-rollTrick 0.65s cubic-bezier(0.34, 1.4, 0.64, 1) !important; }

/* 点击挤压回弹：作用在 SVG 上，不干扰位置 */
[data-dsh-whale] .pet-official.squish svg { animation: pw-squish 0.42s cubic-bezier(0.25, 1.4, 0.5, 1); }

/* 拖拽中：暂停状态动画 + 斜拉变形 */
[data-dsh-whale].dragging .pet-official {
  animation: none !important;
  transform: scaleX(1) rotate(-5deg) scale(1.04, 0.96) !important;
}
[data-dsh-whale].dragging[data-facing="right"] .pet-official {
  transform: scaleX(-1) rotate(5deg) scale(1.04, 0.96) !important;
}
[data-dsh-whale].dragging .pet-official .body { animation: none !important; }

/* 被抓/拖拽：动漫勾勾眼（>_<），替换正常眼睛 */
[data-dsh-whale].dragging .eye-group .eye,
[data-dsh-whale].dragging .eye-group .pupil-highlight { opacity: 0 !important; }
[data-dsh-whale].dragging .eye-group .caught-eyes { display: inline !important; }
[data-dsh-whale].dragging .pet-official .eye-group .happy-eyes,
[data-dsh-whale].dragging .pet-official .eye-group .sad-eyes,
[data-dsh-whale].dragging .pet-official .tear { display: none !important; }
[data-dsh-whale].dragging .eye-group .caught-eyes path { stroke: var(--pw-eye, #2E2A24) !important; stroke-width: 0.9 !important; }

/* ===== 台词气泡 ===== */
[data-dsh-whale] .dsh-whale-dialog {
  position: absolute;
  top: -34px;
  left: 50%;
  transform: translateX(-50%);
  background: #FFFFFF;
  color: var(--pw-ink);
  border: 1px solid rgba(46,42,36,.15);
  border-radius: 12px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 4px 14px rgba(46,42,36,.08);
  pointer-events: none;
  opacity: 0;
  transform-origin: 50% 100%;
  transition: opacity .25s ease, transform .25s cubic-bezier(0.34, 1.56, 0.64, 1);
  z-index: 20;
}
[data-dsh-whale] .dsh-whale-dialog.show { opacity: 1; transform: translateX(-50%) scale(1); }
[data-dsh-whale] .dsh-whale-dialog::after {
  content: "";
  position: absolute;
  bottom: -5px;
  left: 50%;
  margin-left: -5px;
  border-width: 5px 5px 0;
  border-style: solid;
  border-color: #FFFFFF transparent transparent;
}

/* ===== 投喂小鱼干 ===== */
[data-dsh-whale] .dsh-whale-snack {
  position: absolute;
  top: -7px;
  left: 14px;
  font-size: 14px;
  opacity: 0;
  pointer-events: none;
  z-index: 15;
}
[data-dsh-whale] .dsh-whale-snack.drop { animation: pw-dropSnack 0.7s ease-in forwards; }
[data-dsh-whale][data-facing="right"] .dsh-whale-snack { left: auto; right: 14px; }

/* ===== 角标：别的会话里正在跑的个数 =====
 * 挂在鲸鱼头前上方（朝右时镜像过去），做成一颗小气泡：实色渐变 + 左上高光 + 内阴影。
 * 三种动效各占一个独立变换属性，互不覆盖：
 *   translate — JS 每帧跟着鲸鱼身体的起伏走（index.ts 的 followBody）
 *   rotate    — 轻微左右摆
 *   scale     — 数字变化时弹一下 */
[data-dsh-whale] .dsh-whale-badge {
  position: absolute;
  top: calc(4px * var(--pw-scale));
  left: calc(-6px * var(--pw-scale));
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  box-sizing: border-box;
  border-radius: 12px;
  /* 底色要够深，白字才看得清；亮面只交给 ::before 那一小块高光 */
  background: radial-gradient(circle at 35% 30%, var(--pw-body) 0%, var(--pw-body-dark) 85%);
  border: 1.5px solid rgba(255, 255, 255, 0.92);
  box-shadow:
    0 3px 8px rgba(53, 80, 201, 0.32),
    inset 0 -2px 3px rgba(20, 30, 90, 0.22),
    inset 0 1px 2px rgba(255, 255, 255, 0.55);
  color: #FFFFFF;
  font-size: 12px;
  font-weight: 800;
  line-height: 21px;
  text-align: center;
  text-shadow: 0 1px 2px rgba(20, 30, 90, 0.55);
  pointer-events: auto;
  cursor: default;
  z-index: 16;
  transform-origin: 50% 90%;
  animation: pw-badgeSway 2.8s ease-in-out infinite;
}
/* 气泡左上角的高光（右下角别再加小反光点，真机上看着像数字后面跟了个句号） */
[data-dsh-whale] .dsh-whale-badge::before {
  content: '';
  position: absolute;
  top: 3px;
  left: 4px;
  width: 7px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  transform: rotate(-28deg);
  pointer-events: none;
}
[data-dsh-whale] .dsh-whale-badge.pop {
  animation: pw-badgeSway 2.8s ease-in-out infinite, pw-badgePop 0.5s cubic-bezier(0.3, 1.6, 0.5, 1);
}
[data-dsh-whale][data-facing="right"] .dsh-whale-badge { left: auto; right: calc(-6px * var(--pw-scale)); }
@keyframes pw-badgeSway {
  0%, 100% { rotate: -6deg; }
  50% { rotate: 6deg; }
}
@keyframes pw-badgePop {
  0% { scale: 0.3; }
  60% { scale: 1.18 0.9; }
  80% { scale: 0.95 1.05; }
  100% { scale: 1; }
}
/* 以后给角标加 display 时，hidden 属性会被压过（青筋/星星踩过的坑），先钉死 */
[data-dsh-whale] .dsh-whale-badge[hidden] { display: none !important; }


/* ===== 打瞌睡 ===== */
[data-dsh-whale] .dsh-whale-zzz {
  position: absolute;
  left: 58%;
  top: 19px;
  font-size: 10px;
  font-weight: bold;
  color: #8F4427;
  opacity: 0;
  pointer-events: none;
}
[data-dsh-whale].sleeping .dsh-whale-zzz { animation: pw-zzzFloat 2.8s ease-in-out infinite; }
[data-dsh-whale].sleeping .pet-official .body { animation: pw-sleepBob 4s ease-in-out infinite !important; }
[data-dsh-whale].sleeping .pet-official .eye-group { transform: scaleY(0.08) !important; }
[data-dsh-whale].sleeping .pet-official .pupil-highlight { opacity: 0 !important; }

/* ===== 右键菜单 ===== */
[data-dsh-whale] .dsh-whale-menu {
  position: absolute;
  min-width: 132px;
  padding: 4px;
  border-radius: 10px;
  background: var(--dsw-hovercard-bg, #2C2C2E);
  color: var(--dsw-alias-text-1, #eee);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.25));
  pointer-events: auto;
  z-index: 30;
  display: none;
  font-size: 13px;
}
[data-dsh-whale] .dsh-whale-menu.open { display: block; }
[data-dsh-whale] .dsh-whale-menu button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  padding: 6px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
}
[data-dsh-whale] .dsh-whale-menu button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.1)); }
[data-dsh-whale] .dsh-whale-menu .pw-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  margin-right: 8px;
  vertical-align: -2px;
  border: 1px solid rgba(255,255,255,.35);
}

  [data-dsh-whale] .dsh-whale-menu {
    max-height: calc(100vh - 120px);
    overflow-y: auto;
    min-width: 168px;
  }
  [data-dsh-whale] .dsh-whale-menu .pw-panel-title {
    padding: 8px 10px 4px;
    font-weight: 600;
    font-size: 13px;
    opacity: .92;
    border-bottom: 1px solid rgba(255,255,255,.08);
    margin-bottom: 4px;
  }
  [data-dsh-whale] .dsh-whale-menu .pw-panel-section {
    padding: 4px 6px;
    border-bottom: 1px solid rgba(255,255,255,.06);
  }
  [data-dsh-whale] .dsh-whale-menu .pw-panel-section:last-of-type {
    border-bottom: none;
  }
  [data-dsh-whale] .dsh-whale-menu .pw-panel-section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .4px;
    opacity: .65;
    padding: 6px 4px 2px;
  }
  [data-dsh-whale] .dsh-whale-menu .pw-palette-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: auto;
    min-width: 86px;
    margin: 2px;
    padding: 5px 8px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 8px;
    background: rgba(255,255,255,.04);
  }
  [data-dsh-whale] .dsh-whale-menu .pw-palette-btn:hover {
    background: rgba(255,255,255,.12);
  }
  [data-dsh-whale] .dsh-whale-menu .pw-back {
    margin-top: 4px;
    opacity: .75;
  }


/* 悬停腮红加深 */
[data-dsh-whale] .pet-official:hover .eye-group {
  filter: drop-shadow(0 0 1px rgba(217, 142, 106, 0.8));
}

/* ===== keyframes（pw- 前缀） ===== */
@keyframes pw-qbob {
  0%,100% { transform: translateY(0) scale(1, 1); }
  22%     { transform: translateY(-7px) scale(.985, 1.035); }
  50%     { transform: translateY(2px) scale(1.02, .965); }
  72%     { transform: translateY(-3px) scale(.995, 1.012); }
}
@keyframes pw-dive2 {
  0%, 10%  { transform: translateY(0) rotate(0) scale(1, 1); opacity: 1; }
  24%      { transform: translateY(9px) rotate(-7deg) scale(1.03, .95); opacity: .78; }
  38%, 70% { transform: translateY(33px) rotate(3deg) scale(.95, 1.05); opacity: .42; }
  84%      { transform: translateY(6px) rotate(-5deg) scale(1.03, .96); opacity: .85; }
  94%,100% { transform: translateY(0) rotate(0) scale(1, 1); opacity: 1; }
}
@keyframes pw-leap2 {
  0%, 100%  { transform: translateY(0) rotate(0) scale(1, 1); }
  14%       { transform: translateY(-27px) rotate(-10deg) scale(.97, 1.06); }
  36%       { transform: translateY(2px) rotate(5deg) scale(1.09, .88); }
  52%       { transform: translateY(-13px) rotate(-4deg) scale(.98, 1.04); }
  72%       { transform: translateY(-3px) rotate(2deg) scale(1.03, .94); }
}
@keyframes pw-shake {
  0%, 100% { transform: translateX(0); }
  25%      { transform: translateX(-3.5px); }
  50%      { transform: translateX(2.5px); }
  75%      { transform: translateX(-2px); }
}
@keyframes pw-wait {
  0%, 100% { transform: translateY(0) rotate(0) scale(1, 1); }
  30%      { transform: translateY(-4px) rotate(-2deg) scale(1.01, .99); }
  60%      { transform: translateY(2px) rotate(2deg) scale(.99, 1.01); }
}
@keyframes pw-disappointed {
  0%, 100% { transform: translateY(0) rotate(0) scale(1, 1); opacity: 1; }
  40%      { transform: translateY(1px) rotate(-1.5deg) scale(0.99, 1.01); opacity: .88; }
  70%      { transform: translateY(0) rotate(1deg) scale(1, 0.99); opacity: .94; }
}


@keyframes pw-swim {
  0%,100% { transform: translateX(-3.5px) translateY(0) rotate(-1.5deg); }
  50%     { transform: translateX(3.5px) translateY(-2px) rotate(1.5deg); }
}
@keyframes pw-swimBody {
  0%   { transform: translateY(0) rotate(-1.2deg) scale(1, 1); }
  100% { transform: translateY(-1.8px) rotate(1.2deg) scale(0.99, 1.015); }
}
@keyframes pw-blink {
  0%, 91%, 100% { transform: scaleY(1); }
  94%           { transform: scaleY(0.08); }
  97%           { transform: scaleY(1); }
}
@keyframes pw-rise {
  0%   { transform: translateY(0) scale(.6); opacity: 0; }
  20%  { opacity: .9; }
  100% { transform: translateY(-50px) scale(1.1); opacity: 0; }
}
@keyframes pw-riseBlue {
  0%   { transform: translate(5px, 22px) scale(.5); opacity: 0; }
  25%  { opacity: .85; }
  100% { transform: translate(-7px, -33px) scale(1.15); opacity: 0; }
}
@keyframes pw-squish {
  0%   { transform: scale(1, 1); }
  25%  { transform: scale(1.15, 0.82); }
  55%  { transform: scale(0.93, 1.09); }
  78%  { transform: scale(1.03, 0.98); }
  100% { transform: scale(1, 1); }
}
@keyframes pw-rollTrick {
  0%   { transform: translateY(0) rotate(0deg) scale(1, 1); }
  30%  { transform: translateY(-22px) rotate(-120deg) scale(1.08, 0.92); }
  70%  { transform: translateY(-14px) rotate(-260deg) scale(0.95, 1.05); }
  100% { transform: translateY(0) rotate(-360deg) scale(1, 1); }
}
@keyframes pw-shadowBob {
  0%,100% { transform: scale(1); opacity: .9; }
  50%     { transform: scale(.78); opacity: .5; }
}
@keyframes pw-keyTap1 {
  0%,100% { transform: translateY(0); }
  50%     { transform: translateY(0.4px); }
}
@keyframes pw-keyTap2 {
  0%,100% { transform: translateY(0); }
  50%     { transform: translateY(0.4px); }
}
[data-dsh-whale] .tap-k1 { animation: pw-keyTap1 0.16s ease-in-out infinite alternate; }
[data-dsh-whale] .tap-k2 { animation: pw-keyTap2 0.18s ease-in-out 0.08s infinite alternate; }
@keyframes pw-codeFloat1 {
  0%   { transform: translateY(0) scale(0.5); opacity: 0; }
  30%  { opacity: 0.95; }
  100% { transform: translateY(-16px) translateX(-5px) scale(1); opacity: 0; }
}
@keyframes pw-codeFloat2 {
  0%   { transform: translateY(0) scale(0.5); opacity: 0; }
  30%  { opacity: 0.95; }
  100% { transform: translateY(-17px) translateX(4px) scale(1.05); opacity: 0; }
}
[data-dsh-whale] .code-fx1 { animation: pw-codeFloat1 1.2s ease-out infinite; }
[data-dsh-whale] .code-fx2 { animation: pw-codeFloat2 1.2s ease-out 0.6s infinite; }
@keyframes pw-starSpin {
  0%,100% { transform: scale(1) rotate(0deg); opacity: 1; }
  50%     { transform: scale(1.3) rotate(22deg); opacity: .65; }
}
@keyframes pw-angryJitter {
  0%,100% { transform: translateX(0); }
  50%     { transform: translateX(-1.2px); }
}
@keyframes pw-sleepBob {
  0%,100% { transform: translateY(0) scale(1, 1); }
  50%     { transform: translateY(3px) scale(1.02, 0.97); }
}
@keyframes pw-zzzFloat {
  0%   { transform: translate(0, 0) scale(0.6); opacity: 0; }
  30%  { opacity: 0.9; }
  100% { transform: translate(10px, -17px) scale(1.15); opacity: 0; }
}
@keyframes pw-dropSnack {
  0%   { transform: translateY(0) rotate(0); opacity: 1; }
  80%  { transform: translateY(79px) rotate(45deg); opacity: 1; }
  100% { transform: translateY(90px) scale(0.5); opacity: 0; }
}

@keyframes pw-mini-breathe {
  0%,100% { box-shadow: 0 8px 20px rgba(0,0,0,.28); }
  50%     { box-shadow: 0 8px 24px rgba(77,107,254,.55); }
}
@keyframes pw-mini-think {
  0%,100% { box-shadow: 0 8px 20px rgba(61,85,214,.35); }
  50%     { box-shadow: 0 8px 26px rgba(110,139,255,.75); }
}
@keyframes pw-mini-work {
  0%,100% { opacity: 1; }
  50%     { opacity: .62; }
}
@keyframes pw-mini-celebrate {
  0%,100% { box-shadow: 0 8px 20px rgba(27,138,74,.35); }
  50%     { box-shadow: 0 10px 28px rgba(59,196,109,.85); }
}
@keyframes pw-mini-error {
  0%,100% { box-shadow: 0 8px 20px rgba(166,27,32,.35); }
  50%     { box-shadow: 0 8px 26px rgba(229,72,77,.85); }
}

/* ===== 全屏独立固定粒子层 ===== */
.pw-particle-layer {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 898;
  overflow: hidden;
}

/* ===== 水纹与水泡特效 ===== */
.pw-water-ripple {
  position: absolute;
  pointer-events: none;
  border-radius: 50%;
  border: 1.5px solid rgba(143, 181, 255, 0.65);
  background: radial-gradient(ellipse at center, rgba(143, 181, 255, 0.22) 0%, rgba(77, 107, 254, 0.05) 55%, transparent 75%);
  transform: translate(-50%, -50%) scale(0.2);
  animation: pw-rippleFade 1s cubic-bezier(0.12, 0.8, 0.32, 1) forwards;
  z-index: 898;
  box-shadow: 0 0 8px rgba(143, 181, 255, 0.35);
}
@keyframes pw-rippleFade {
  0% {
    transform: translate(-50%, -50%) scale(0.2);
    opacity: 0.85;
  }
  60% {
    opacity: 0.45;
  }
  100% {
    transform: translate(-50%, -50%) scale(1.65);
    opacity: 0;
  }
}

.pw-stream-bubble {
  position: absolute;
  pointer-events: none;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #FFFFFF 0%, rgba(180, 215, 255, 0.85) 55%, rgba(77, 107, 254, 0.45) 100%);
  border: 0.8px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 0 4px rgba(143, 181, 255, 0.5), inset -1px -1px 2px rgba(53, 80, 201, 0.3);
  animation: pw-bubbleFloat var(--pw-b-dur, 1.1s) cubic-bezier(0.2, 0.7, 0.4, 1) forwards;
  z-index: 899;
}
@keyframes pw-bubbleFloat {
  0% {
    transform: translate(0, 0) scale(0.3);
    opacity: 0;
  }
  20% {
    opacity: 0.95;
  }
  80% {
    opacity: 0.75;
    transform: translate(var(--pw-b-dx, -10px), var(--pw-b-dy, -20px)) scale(1.05);
  }
  100% {
    transform: translate(calc(var(--pw-b-dx, -10px) * 1.3), calc(var(--pw-b-dy, -20px) - 16px)) scale(0.2);
    opacity: 0;
  }
}

@keyframes pw-wakePulse {
  0%   { transform: scale(0.9, 0.82) rotate(-2.5deg); opacity: 0.45; }
  100% { transform: scale(1.18, 1.08) rotate(2.5deg); opacity: 0.85; }
}

@keyframes pw-spoutSpray {
  0%   { transform: scale(0.2) translateY(2px); opacity: 0; }
  25%  { transform: scale(1) translateY(0); opacity: 0.95; }
  70%  { transform: scale(1.08) translateY(-1.5px); opacity: 0.75; }
  100% { transform: scale(1.15) translateY(-3px); opacity: 0; }
}

@keyframes pw-pupilGaze {
  0%, 100% { transform: translate(0, 0); }
  50%      { transform: translate(0.35px, -0.42px); }
}

@keyframes pw-annoyedDodge {
  0%   { transform: translateX(0) rotate(0deg); }
  35%  { transform: translateX(-9px) rotate(-7deg); }
  65%  { transform: translateX(4px) rotate(3deg); }
  100% { transform: translateX(0) rotate(0deg); }
}
/* 背过身：横向翻面到一半停住，读作"扭头不看你" */
@keyframes pw-sulkTurn {
  0%   { transform: rotate(0deg) scale(1, 1); }
  45%  { transform: rotate(-10deg) scale(0.94, 1.05); }
  100% { transform: rotate(-6deg) scale(0.97, 1.02); }
}
@keyframes pw-dizzyShake {
  0%   { transform: rotate(-12deg) scale(0.95); }
  100% { transform: rotate(12deg) scale(1.05); }
}

@keyframes pw-dizzyWobble {
  0%, 100% { transform: rotate(0deg) scale(1); }
  25%      { transform: rotate(-7deg) scale(0.96); }
  75%      { transform: rotate(7deg) scale(0.96); }
}

@keyframes pw-bellyUp {
  0%   { transform: rotate(0deg) translateY(0); }
  20%  { transform: rotate(160deg) translateY(-18px); }
  35%  { transform: rotate(180deg) translateY(-6px); }
  75%  { transform: rotate(180deg) translateY(-6px); }
  100% { transform: rotate(360deg) translateY(0); }
}

@keyframes pw-squeeze {
  0%   { transform: scaleX(1) scaleY(1); }
  100% { transform: scaleX(0.82) scaleY(1.1); }
}

@keyframes pw-patPress {
  0%   { transform: scale(1, 1); }
  35%  { transform: scale(1.05, 0.9); }
  100% { transform: scale(1, 1); }
}
@keyframes pw-heartFloat {
  0%   { transform: translateY(4px) scale(0.5); opacity: 0; }
  25%  { transform: translateY(0) scale(1.1); opacity: 1; }
  100% { transform: translateY(-22px) scale(0.9); opacity: 0; }
}

@keyframes pw-tearDrop {
  0%   { transform: translateY(-0.4px) scale(0.4); opacity: 0; }
  25%  { transform: translateY(0) scale(1); opacity: 1; }
  70%  { transform: translateY(1.6px) scale(1); opacity: 1; }
  100% { transform: translateY(2.6px) scale(0.9); opacity: 0; }
}

@keyframes pw-squash {
  0%   { transform: scaleX(1) scaleY(1); }
  100% { transform: scaleX(1.12) scaleY(0.8); }
}

@keyframes pw-impatientSway {
  0%, 100% { transform: rotate(0deg); }
  30%      { transform: rotate(-5deg); }
  70%      { transform: rotate(5deg); }
}

@keyframes pw-joyHop {
  0%, 100% { transform: translateY(0) scale(1); }
  35%      { transform: translateY(-16px) scale(1.08, 0.94); }
  65%      { transform: translateY(-4px) scale(0.96, 1.04); }
}

@keyframes pw-causticDrift {
  0%   { transform: translate(-0.6px, 0.3px); opacity: 0.12; stroke-width: 0.9; }
  50%  { opacity: 0.28; stroke-width: 1.25; }
  100% { transform: translate(0.6px, -0.3px); opacity: 0.14; stroke-width: 1.0; }
}

/* 破浪跃水与着陆飞溅水滴 */
.pw-splash-drop {
  position: absolute;
  pointer-events: none;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #FFFFFF 0%, rgba(180, 215, 255, 0.9) 60%, rgba(77, 107, 254, 0.5) 100%);
  box-shadow: 0 0 3px rgba(143, 181, 255, 0.6);
  animation: pw-splashFall var(--pw-sp-dur, 0.65s) cubic-bezier(0.25, 0.9, 0.4, 1) forwards;
  z-index: 899;
}
@keyframes pw-splashFall {
  0% {
    transform: translate(0, 0) scale(1);
    opacity: 0.95;
  }
  60% {
    opacity: 0.85;
  }
  100% {
    transform: translate(var(--pw-sp-dx, 12px), var(--pw-sp-dy, 35px)) scale(0.2);
    opacity: 0;
  }
}

/* 悬空拖拽滴水 */
.pw-drag-drip {
  position: absolute;
  pointer-events: none;
  border-radius: 50% 50% 50% 50% / 60% 60% 40% 40%;
  background: radial-gradient(circle at 35% 30%, #FFFFFF 0%, rgba(160, 205, 255, 0.85) 60%, rgba(77, 107, 254, 0.4) 100%);
  box-shadow: 0 0 3px rgba(143, 181, 255, 0.4);
  animation: pw-dripFall 0.52s cubic-bezier(0.45, 0.05, 0.85, 0.6) forwards;
  z-index: 897;
}
@keyframes pw-dripFall {
  0% {
    transform: translate(0, 0) scale(0.6);
    opacity: 0.9;
  }
  50% {
    transform: translate(0, 14px) scale(0.9, 1.25);
    opacity: 0.85;
  }
  100% {
    transform: translate(0, 46px) scale(0.3, 0.1);
    opacity: 0;
  }
}

/* 庆祝彩屑粒子 */
.pw-confetti {
  position: absolute;
  pointer-events: none;
  width: var(--pw-cf-w, 7px);
  height: var(--pw-cf-h, 10px);
  background: var(--pw-cf-bg, #4D6BFE);
  border-radius: var(--pw-cf-r, 2px);
  opacity: 0.95;
  animation: pw-confettiFall var(--pw-cf-dur, 1.1s) cubic-bezier(0.22, 0.8, 0.36, 1) forwards;
  z-index: 899;
}
@keyframes pw-confettiFall {
  0% {
    transform: translate(0, 0) rotateX(0deg) rotateY(0deg) rotateZ(0deg);
    opacity: 1;
  }
  60% {
    opacity: 0.85;
  }
  100% {
    transform: translate(var(--pw-cf-dx, 35px), var(--pw-cf-dy, 100px)) rotateX(540deg) rotateY(360deg) rotateZ(270deg);
    opacity: 0;
  }
}

/* 陪伴统计项目 */
[data-dsh-whale] .dsh-whale-menu .pw-stats-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font-size: 12px;
  padding: 6px 10px;
  margin-bottom: 4px;
  border-radius: 6px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0.95;
}
[data-dsh-whale][data-theme="dark"] .dsh-whale-menu .pw-stats-item {
  background: rgba(255, 255, 255, 0.08);
  color: #F2F2F0;
}

/* 后台省电：页面不可见时暂停一切动画 */
[data-dsh-whale].paused,
[data-dsh-whale].paused * { animation-play-state: paused !important; transition: none !important; }
[data-dsh-whale-mini].paused { animation: none !important; }

/* 主题联动：DSH 暗色主题下的 UI 皮肤 */
[data-dsh-whale][data-theme="dark"] .dsh-whale-dialog {
  background: #2C2C2E;
  color: #F2F2F0;
  border-color: rgba(255,255,255,.12);
}
[data-dsh-whale][data-theme="dark"] .dsh-whale-dialog::after {
  border-color: #2C2C2E transparent transparent;
}
[data-dsh-whale][data-theme="dark"] .dsh-whale-shadow {
  background: radial-gradient(ellipse, rgba(0,0,0,.5), transparent 65%);
}
[data-dsh-whale][data-theme="dark"] .dsh-whale-wake {
  background: radial-gradient(ellipse at center, rgba(110, 145, 255, 0.22) 0%, rgba(53, 80, 201, 0.06) 50%, transparent 72%);
}

/* 减少动态效果：全关动画 */
@media (prefers-reduced-motion: reduce) {
  [data-dsh-whale-mini] { animation: none !important; transition: none !important; }
  [data-dsh-whale] *,
  [data-dsh-whale] { animation: none !important; transition: none !important; }
  .pw-water-ripple, .pw-stream-bubble, .pw-splash-drop, .pw-drag-drip, .pw-confetti { display: none !important; }
}
`;
    // <<< pet-whale WHALE_CSS 快照

    /** 默认配置（须与 lib/index.js 的 schema 默认值一致） */
    const DEFAULTS = {
      enabled: true,
      faceWidget: true,
      leanMaxDeg: 26,
      leanRangePx: 240,
      leanDeadPx: 12,
      pitchRatio: 0.35,
      faceTransitionMs: 180,
      faceWhileDragging: true,
      nearGapPx: 140,
      releaseGapPx: 300,
      scanGapPx: 200,
      scanFacingOnly: true,
      speakIntervalMs: 25000,
      pretendSettleMs: 400,
      releaseSettleMs: 1000,
      debug: false,
    };

    /** 数值字段钳制范围 */
    const LIMITS = {
      leanMaxDeg: [0, 90],
      leanRangePx: [20, 2000],
      leanDeadPx: [0, 600],
      pitchRatio: [0, 1],
      faceTransitionMs: [0, 2000],
      nearGapPx: [0, 4000],
      releaseGapPx: [0, 4000],
      scanGapPx: [0, 4000],
      speakIntervalMs: [2000, 3600000],
      pretendSettleMs: [0, 60000],
      releaseSettleMs: [0, 60000],
    };

    /** 小于该角度（度）就不写进 transform，避免出现 rotate(0.0001deg) 这种噪声 */
    const LEAN_EPSILON_DEG = 0.05;

    // ------------------------------------------------------------------
    // 纯工具函数（无 DOM 依赖，便于单测）
    // ------------------------------------------------------------------

    function nowMs() {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
      return Date.now();
    }

    function toNumber(value, fallback, min, max) {
      let number = Number.NaN;
      if (typeof value === 'number') number = value;
      else if (typeof value === 'string' && value.trim() !== '') number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      if (number < min) return min;
      if (number > max) return max;
      return number;
    }

    function toBoolean(value, fallback) {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return fallback;
    }

    /** 把任意来源（localStorage / 设置页 / API）的配置规整成完整合法配置。 */
    function normalizeConfig(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const config = {
        enabled: toBoolean(source.enabled, DEFAULTS.enabled),
        faceWidget: toBoolean(source.faceWidget, DEFAULTS.faceWidget),
        leanMaxDeg: toNumber(source.leanMaxDeg, DEFAULTS.leanMaxDeg, LIMITS.leanMaxDeg[0], LIMITS.leanMaxDeg[1]),
        leanRangePx: toNumber(source.leanRangePx, DEFAULTS.leanRangePx, LIMITS.leanRangePx[0], LIMITS.leanRangePx[1]),
        leanDeadPx: toNumber(source.leanDeadPx, DEFAULTS.leanDeadPx, LIMITS.leanDeadPx[0], LIMITS.leanDeadPx[1]),
        pitchRatio: toNumber(source.pitchRatio, DEFAULTS.pitchRatio, LIMITS.pitchRatio[0], LIMITS.pitchRatio[1]),
        faceTransitionMs: toNumber(source.faceTransitionMs, DEFAULTS.faceTransitionMs, LIMITS.faceTransitionMs[0], LIMITS.faceTransitionMs[1]),
        faceWhileDragging: toBoolean(source.faceWhileDragging, DEFAULTS.faceWhileDragging),
        nearGapPx: toNumber(source.nearGapPx, DEFAULTS.nearGapPx, LIMITS.nearGapPx[0], LIMITS.nearGapPx[1]),
        releaseGapPx: toNumber(source.releaseGapPx, DEFAULTS.releaseGapPx, LIMITS.releaseGapPx[0], LIMITS.releaseGapPx[1]),
        scanGapPx: toNumber(source.scanGapPx, DEFAULTS.scanGapPx, LIMITS.scanGapPx[0], LIMITS.scanGapPx[1]),
        scanFacingOnly: toBoolean(source.scanFacingOnly, DEFAULTS.scanFacingOnly),
        speakIntervalMs: toNumber(source.speakIntervalMs, DEFAULTS.speakIntervalMs, LIMITS.speakIntervalMs[0], LIMITS.speakIntervalMs[1]),
        pretendSettleMs: toNumber(source.pretendSettleMs, DEFAULTS.pretendSettleMs, LIMITS.pretendSettleMs[0], LIMITS.pretendSettleMs[1]),
        releaseSettleMs: toNumber(source.releaseSettleMs, DEFAULTS.releaseSettleMs, LIMITS.releaseSettleMs[0], LIMITS.releaseSettleMs[1]),
        debug: toBoolean(source.debug, DEFAULTS.debug),
      };
      // 迟滞必须有意义：释放阈值不能小于进入阈值。
      if (config.releaseGapPx < config.nearGapPx) config.releaseGapPx = config.nearGapPx;
      return config;
    }

    /**
     * 两个矩形的最短间距（相交/接触 = 0）。
     * @param a - {left,top,right,bottom}
     * @param b - {left,top,right,bottom}
     */
    function rectGap(a, b) {
      const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
      const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
      return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * 取向的「视野」矩形：挂件朝左（dshwv-left，贴图被 scaleX(-1) 翻转，气泡锚在
     * 左侧）时取左半边，否则取右半边。
     */
    function frontRect(rect, facesLeft) {
      const half = rect.width / 2;
      if (facesLeft) {
        return { left: rect.left, top: rect.top, right: rect.left + half, bottom: rect.bottom, width: half, height: rect.height, cx: rect.left + half / 2, cy: rect.cy };
      }
      return { left: rect.right - half, top: rect.top, right: rect.right, bottom: rect.bottom, width: half, height: rect.height, cx: rect.right - half / 2, cy: rect.cy };
    }

    // ------------------------------------------------------------------
    // 浏览器环境辅助
    // ------------------------------------------------------------------

    function readStorage(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (error) {
        return null;
      }
    }

    function writeStorage(key, value) {
      try {
        if (value === null || value === undefined) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch (error) {
        /* 隐私模式等场景忽略 */
      }
    }

    function readJson(key) {
      const raw = readStorage(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (error) {
        return null;
      }
    }

    function debugLog(config, ...args) {
      if (!config || !config.debug) return;
      if (typeof console === 'undefined' || typeof console.log !== 'function') return;
      console.log('[dsh-whale-bridge]', ...args);
    }

    /** 把元素矩形规范化；不可见（0 尺寸）或不存在时返回 null。 */
    function rectOf(element) {
      if (!element || typeof element.getBoundingClientRect !== 'function') return null;
      let raw;
      try {
        raw = element.getBoundingClientRect();
      } catch (error) {
        return null;
      }
      if (!raw || !(raw.width > 0) || !(raw.height > 0)) return null;
      return {
        left: raw.left,
        top: raw.top,
        right: raw.right,
        bottom: raw.bottom,
        width: raw.width,
        height: raw.height,
        cx: raw.left + raw.width / 2,
        cy: raw.top + raw.height / 2,
      };
    }

    function connected(node) {
      if (!node) return false;
      if (typeof document === 'undefined' || typeof document.contains !== 'function') return true;
      try {
        return document.contains(node);
      } catch (error) {
        return true;
      }
    }

    /** 桌宠贴图快照；不可见/不存在返回 null。 */
    function readPet() {
      const root = document.querySelector(PET_ROOT_SELECTOR);
      if (!root) return null;
      const sprite = root.querySelector(PET_SPRITE_SELECTOR) || root;
      const rect = rectOf(sprite);
      if (!rect) return null;
      return { root: root, sprite: sprite, rect: rect };
    }

    /** 挂件贴图快照；不可见/不存在返回 null。 */
    function readWidget() {
      let root = window.__dshWhaleRoot;
      if (!root || typeof root.querySelector !== 'function' || !connected(root)) root = document.querySelector(WIDGET_ROOT_SELECTOR);
      if (!root) return null;
      const sprite = root.querySelector(WIDGET_SPRITE_SELECTOR) || root;
      const rect = rectOf(sprite);
      if (!rect) return null;
      const bubble = root.querySelector(WIDGET_BUBBLE_SELECTOR);
      let facesLeft = false;
      try {
        facesLeft = !!(root.classList && root.classList.contains(WIDGET_FACING_CLASS));
      } catch (error) {
        facesLeft = false;
      }
      let bubbleOpen = false;
      try {
        bubbleOpen = !!(bubble && bubble.classList && bubble.classList.contains(WIDGET_BUBBLE_OPEN_CLASS));
      } catch (error) {
        bubbleOpen = false;
      }
      return { root: root, sprite: sprite, rect: rect, bubble: bubble, facesLeft: facesLeft, bubbleOpen: bubbleOpen };
    }

    function makeMouseEvent(type, x, y, extra) {
      const Ctor = window.MouseEvent || window.Event;
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
      if (extra) for (const key of Object.keys(extra)) init[key] = extra[key];
      return new Ctor(type, init);
    }

    function makePointerEvent(type, x, y, buttons) {
      const Ctor = window.PointerEvent || window.MouseEvent;
      return new Ctor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: buttons,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      });
    }

    // ------------------------------------------------------------------
    // 与原插件的交互
    // ------------------------------------------------------------------

    function pretendActive() {
      return readStorage(PRETEND_KEY) === '1';
    }

    /**
     * 翻转 pet-whale 自带的「💼 假装工作」：合成一次右键、再点菜单项。
     * 全程同步，菜单不会被绘制出来；返回是否真的翻转了状态。
     */
    function togglePretend() {
      const root = document.querySelector(PET_ROOT_SELECTOR);
      if (!root) return false;
      const sprite = root.querySelector(PET_SPRITE_SELECTOR);
      if (!sprite) return false;
      const rect = rectOf(sprite);
      const x = rect ? rect.cx : 0;
      const y = rect ? rect.cy : 0;
      const before = pretendActive();
      try {
        // pet-whale 的 contextmenu 处理器会 openMenu() → 同步 buildMenu()
        sprite.dispatchEvent(makeMouseEvent('contextmenu', x, y, { button: 2, buttons: 2, detail: 2 }));
      } catch (error) {
        return false;
      }
      const menu = root.querySelector(PET_MENU_SELECTOR) || document.querySelector(PET_MENU_SELECTOR);
      if (!menu || typeof menu.querySelectorAll !== 'function') return false;
      const buttons = menu.querySelectorAll('button');
      let target = null;
      for (let index = 0; index < buttons.length; index += 1) {
        const label = String(buttons[index].textContent || '');
        for (const hint of PRETEND_LABEL_HINTS) {
          if (label.toLowerCase().indexOf(hint.toLowerCase()) !== -1) {
            target = buttons[index];
            break;
          }
        }
        if (target) break;
      }
      if (!target || typeof target.click !== 'function') return false;
      try {
        // 菜单项包装器会先 closeMenu() 再执行动作（并 showDialog 提示）
        target.click();
      } catch (error) {
        return false;
      }
      return pretendActive() !== before;
    }

    /** 点挂件鲸鱼的候选坐标（贴图中心区域，alpha>10 的命中率最高）。 */
    function whaleTapPoints(rect) {
      return [
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.55],
        [rect.left + rect.width * 0.4, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.6, rect.top + rect.height * 0.45],
      ];
    }

    /** 合成一次完整的「按下-抬起」，让挂件走 whaleClick()（显示默认气泡第 1 项）。 */
    function tapWidgetWhale(widget, attempt) {
      const points = whaleTapPoints(widget.rect);
      const point = points[Math.min(Math.max(attempt, 0), points.length - 1)];
      const target = widget.sprite || widget.root;
      if (!target || typeof target.dispatchEvent !== 'function') return false;
      try {
        // document 上的 capture 监听（onDocPointerDown/Move/Up）靠坐标判定命中
        target.dispatchEvent(makePointerEvent('pointerdown', point[0], point[1], 0));
        target.dispatchEvent(makePointerEvent('pointerup', point[0], point[1], 0));
        return true;
      } catch (error) {
        return false;
      }
    }

    /** 点一下气泡：挂件的 bubbleBox click 处理器会 bubbleNext()（第 1 项 → 第 2 项台词）。 */
    function tapWidgetBubble(widget) {
      const bubble = widget.bubble;
      if (!bubble || typeof bubble.dispatchEvent !== 'function') return false;
      const rect = rectOf(bubble) || widget.rect;
      try {
        bubble.dispatchEvent(makeMouseEvent('click', rect.cx, rect.cy, { button: 0, buttons: 0 }));
        return true;
      } catch (error) {
        return false;
      }
    }

    // ------------------------------------------------------------------
    // pet-whale 样式表守护
    // ------------------------------------------------------------------
    //
    // DSH 的客户端模块系统在每次物化插件时都会把「没有 data-plugin 的 <style>」
    // 认领到当时正在物化的那个插件名下（@deepseek-ai/dsh-client-modules 的
    // claimStyles），之后那个插件失效/热重载时 removeOwnedStyles 会把它们一并删掉。
    // pet-whale 建自己的 #pet-whale-style 时没有打标，于是样式表可能被别的插件
    // 「带走」：桌宠根节点失去 position:fixed 与尺寸，行内 <svg> 撑满 body 变成
    // 整屏巨鲸，装饰文本（🐟 / Zzz...）也变成裸文本排在页面上。
    //
    // 本桥接不碰 pet-whale 的源文件，只做两件事：见到就把归属补成它自己（打了标
    // 就没人能认领、也没人会替它删），并留一份 CSS 文本备胎，万一还是没了就用它
    // 重注入一份同 id 的样式（pet-whale 下次初始化天然会覆盖自己的版本）。

    /** 给样式元素打上归属标记；返回 true 表示这次真的改了值。 */
    function tagStyleElement(el, id) {
      if (!el || typeof el.getAttribute !== 'function' || typeof el.setAttribute !== 'function') return false;
      let current = null;
      try {
        current = el.getAttribute('data-plugin');
      } catch (error) {
        return false;
      }
      if (current === id) return false;
      try {
        el.setAttribute('data-plugin', id);
      } catch (error) {
        return false;
      }
      return true;
    }

    /** 把样式元素插进 document.head（桩 DOM / 极早期文档里可能还没有 head）。 */
    function appendStyleElement(el) {
      if (!el || typeof document === 'undefined') return false;
      const container = document.head || document.documentElement;
      if (!container || typeof container.appendChild !== 'function') return false;
      try {
        container.appendChild(el);
      } catch (error) {
        return false;
      }
      return true;
    }

    /**
     * 去掉模板字符串里的 `${...}`（按嵌套配对整段丢弃）。pet-whale 的 WHALE_CSS
     * 全文只有一处插值（"摸摸头"时的手掌光标 data URI），丢掉只少一个光标图案。
     */
    function stripTemplateExpressions(text) {
      const source = typeof text === 'string' ? text : '';
      if (source.indexOf('${') < 0) return source;
      let out = '';
      let i = 0;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === '$' && source[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        out += ch;
        i += 1;
      }
      return out;
    }

    /** 从 startIndex（正指向反引号）读出一个模板字符串的字面内容（不展开插值）。 */
    function readTemplateLiteral(src, startIndex) {
      if (typeof src !== 'string' || src[startIndex] !== '`') return '';
      let out = '';
      let i = startIndex + 1;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === '`') break;
        out += ch;
        i += 1;
      }
      return out;
    }

    /**
     * 从 DSH 客户端模块加载器里挖出 pet-whale 的真样式表。
     *
     * 依据（D:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-client-modules\lib\client.js）：
     * 注册时加载器把每个插件客户端的 factory 原样存进 `window.__ModuleLoader__.factories`
     * （Map: id → { factory, rev }，见该文件 register() 里的 `this.factories.set(...)`），
     * 而 pet-whale 的整个模块体（含 `const WHALE_CSS = \`...\``）都在 factory 里面，
     * 于是 `Function.prototype.toString` 就能把整份源码交出来。好处是拿到的样式表
     * 永远与装着的 pet-whale 版本一致，不用我们内嵌拷贝（内嵌快照只是最后一道）。
     *
     * 挖不到（或挖出来的不像样式表）就返回 ''，调用方会退回内嵌快照。
     */
    function minePetStyleCss() {
      let loader = null;
      try {
        loader = typeof window === 'undefined' ? null : window.__ModuleLoader__;
      } catch (error) {
        return '';
      }
      const factories = loader && loader.factories;
      if (!factories || typeof factories.forEach !== 'function') return '';
      let found = '';
      factories.forEach((entry, key) => {
        if (found) return;
        // 本桥接自己的工厂源码里也有 'WHALE_CSS' 字样（注释与挖矿代码），跳过它
        if (key === SETTINGS_NS) return;
        const factory = typeof entry === 'function' ? entry : entry && entry.factory;
        if (typeof factory !== 'function') return;
        let src = '';
        try {
          src = Function.prototype.toString.call(factory);
        } catch (error) {
          return;
        }
        const match = /const\s+WHALE_CSS\s*=/.exec(src);
        if (!match) return;
        const tick = src.indexOf('`', match.index + match[0].length);
        if (tick < 0) return;
        const css = stripTemplateExpressions(readTemplateLiteral(src, tick));
        if (css.length >= PET_STYLE_MINE_MIN_CHARS && css.indexOf(PET_ROOT_SELECTOR) >= 0) found = css;
      });
      return found;
    }

    /**
     * 一份 CSS 文本"看起来像 pet-whale 的真样式表"吗？
     *
     * 真样式表 36 KB 上下、必然带 `[data-dsh-whale]` 选择器；而 0.3.1 那份兜底
     * （以及任何被截断的残片）都又短又缺规则。**不能**因为 `#pet-whale-style`
     * 里"有字"就当它是真的 —— 那会把残片缓存下来，之后再拿残片去"修复"。
     */
    function isPlausiblePetCss(text) {
      return (
        typeof text === 'string' &&
        text.length >= PET_STYLE_MINE_MIN_CHARS &&
        text.indexOf(PET_ROOT_SELECTOR) >= 0
      );
    }

    /** 读上次会话缓存下来的真样式表文本（拿不到、或不像真样式表就返回 ''）。 */
    function readPetStyleCache() {
      const raw = readStorage(PET_STYLE_CACHE_KEY);
      return isPlausiblePetCss(raw) ? raw : '';
    }

    /** 把真样式表文本缓存到 localStorage（失败/重复就算了，不影响守护）。 */
    function writePetStyleCache(text) {
      if (typeof text !== 'string' || text.length < PET_STYLE_CACHE_MIN_CHARS) return false;
      try {
        if (window.localStorage.getItem(PET_STYLE_CACHE_KEY) === text) return false;
      } catch (error) {
        /* 读不到就直接写，写在 catch 里也会被忽略 */
      }
      writeStorage(PET_STYLE_CACHE_KEY, text);
      return true;
    }

    // ------------------------------------------------------------------
    // 朝向：假装工作时把桌宠转向挂件
    // ------------------------------------------------------------------

    /**
     * 清掉 0.2.x 注入过的样式表（那一版用 CSS 规则做镜像，0.3.0 改成内联 transform
     * 以便「歪头」角度可以逐帧变；旧样式表若留着会按过期属性继续镜像，必须收干净）。
     */
    function removeLegacyFaceStyle() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      let style = null;
      try {
        style = document.getElementById(FACE_STYLE_ID);
      } catch (error) {
        return;
      }
      if (!style) return;
      if (typeof style.remove === 'function') style.remove();
      else if (style.parentNode && typeof style.parentNode.removeChild === 'function') style.parentNode.removeChild(style);
    }

    function petRootOf(pet) {
      if (pet && pet.root) return pet.root;
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
      try {
        return document.querySelector(PET_ROOT_SELECTOR);
      } catch (error) {
        return null;
      }
    }

    function petDragging(root) {
      try {
        return !!(root && root.classList && root.classList.contains(PET_DRAGGING_CLASS));
      } catch (error) {
        return false;
      }
    }

    function prefersReducedMotion() {
      try {
        return !!(
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        );
      } catch (error) {
        return false;
      }
    }

    /**
     * 父级 `.pet-official` 此刻是否已经镜像。
     *
     * 两种情况下父级的镜像真的会被画出来：
     * - 拖拽期：`.dragging .pet-official` 是带 `!important` 的 transform
     *   （`scaleX(1) rotate(-5deg)…` / `scaleX(-1) rotate(5deg)…`），它盖掉 pw-swim
     *   动画，镜像与否由 pet-whale 自己的 `data-facing` 决定。此时我们仍然接管子级
     *   svg，必须按父级状态反向抵消 —— 否则拖动横穿挂件时贴图会跟着翻来翻去。
     * - `prefers-reduced-motion: reduce`：pet-whale 把动画全关掉，内联 scaleX 复活。
     *
     * 其余时候 `.working` 的 pw-swim 动画（keyframes 里没有 scaleX）盖掉父级的内联
     * transform，父级恒为「未镜像」。
     */
    function parentMirrored(root) {
      if (!petDragging(root) && !prefersReducedMotion()) return false;
      try {
        return !!(root && typeof root.getAttribute === 'function' && root.getAttribute('data-facing') === 'right');
      } catch (error) {
        return false;
      }
    }

    /**
     * 垂直偏差 → 视觉歪头角度（>0 = 抬头）。
     *
     * @param dy `pet.rect.cy - widget.rect.cy`：挂件在桌宠上方时为正 → 抬头。
     */
    function leanDegrees(dy, config) {
      const maxDeg = toNumber(config && config.leanMaxDeg, DEFAULTS.leanMaxDeg, LIMITS.leanMaxDeg[0], LIMITS.leanMaxDeg[1]);
      const rangePx = toNumber(config && config.leanRangePx, DEFAULTS.leanRangePx, LIMITS.leanRangePx[0], LIMITS.leanRangePx[1]);
      const deadPx = toNumber(config && config.leanDeadPx, DEFAULTS.leanDeadPx, LIMITS.leanDeadPx[0], LIMITS.leanDeadPx[1]);
      const offset = Number(dy || 0); // 挂件在上（dy>0）→ 抬头（正角）
      const magnitude = Math.abs(offset) <= deadPx ? 0 : Math.abs(offset) - deadPx;
      const ratio = rangePx > 0 ? Math.min(1, magnitude / rangePx) : 1;
      return (offset < 0 ? -1 : 1) * ratio * maxDeg;
    }

    function roundDeg(value) {
      return Math.round(value * 100) / 100;
    }

    /**
     * 朝向几何：把「想要的朝向 + 父级是否已镜像 + 垂直偏差」算成贴图上的 transform 字符串。
     *
     * 表达方式（左到右 = 由外到内）：`scaleX(S) rotate(A) skewY(B)`
     *
     * 设 p = 父级镜像（-1/1）、c = 子级镜像（S），贴图原始头朝向为左（-1,0）：
     * - 净朝向：总的横向翻转为 p·c，要求「头朝向挂件」→ p·c = -1 当且仅当 side === 'right'。
     *   所以 `c = (p === wantMirror) ? -1 : 1`（父级已翻到我们要的那侧时就不用再翻）。
     * - 歪头：`d` 为挂件在桌宠上方时为正的垂直偏差，`lean = leanDegrees(d)` > 0 表示抬头。
     *   头的位置 (∓1,0) 经 `diag(p·c,1)·R(A)` 后其 y 分量为 `±sin(A)`：净朝左时头在左，
     *   A > 0（屏幕顺时针）把左侧抬起来 = 抬头；净朝右时头在右，A > 0 反而不抬。
     *   把「净朝向」代进来算一遍会发现两处符号恰好抵消：**A = lean，与 p、c 都无关**
     *   （父级翻转会把旋转方向也翻一次，而期望的视觉方向本身也随朝向翻转）。
     *   剪切同理：`skewY(B)` 后头部的 y 分量恒为 `-tan(B)`，所以 B = lean × pitchRatio，
     *   也与镜像无关。
     *
     * @returns 纯数据（无 DOM 依赖），便于单测。
     */
    function faceGeometry(options) {
      const opts = options || {};
      const config = opts.config || DEFAULTS;
      const side = opts.side === 'right' ? 'right' : 'left';
      const wantMirror = side === 'right';
      const parentMirrored = !!opts.parentMirrored;
      const mirror = parentMirrored !== wantMirror ? -1 : 1;
      const lean = leanDegrees(opts.dy, config);
      const pitchRatio = toNumber(config.pitchRatio, DEFAULTS.pitchRatio, LIMITS.pitchRatio[0], LIMITS.pitchRatio[1]);
      const rotateDeg = lean;
      const skewDeg = lean * pitchRatio;
      const parts = [];
      if (mirror === -1) parts.push('scaleX(-1)');
      if (Math.abs(rotateDeg) >= LEAN_EPSILON_DEG) parts.push('rotate(' + roundDeg(rotateDeg) + 'deg)');
      if (Math.abs(skewDeg) >= LEAN_EPSILON_DEG) parts.push('skewY(' + roundDeg(skewDeg) + 'deg)');
      return {
        side: side,
        parentMirrored: parentMirrored,
        childMirror: mirror,
        leanDeg: roundDeg(lean),
        pitchDeg: roundDeg(skewDeg),
        rotateDeg: roundDeg(rotateDeg),
        skewDeg: roundDeg(skewDeg),
        transform: parts.join(' '),
      };
    }

    /** 桌宠贴图里那枚 svg（镜像/歪头都打在它身上，与父级的动画正交）。 */
    function petSvgOf(pet) {
      const root = petRootOf(pet);
      let sprite = pet && pet.sprite ? pet.sprite : null;
      if (!sprite && root && typeof root.querySelector === 'function') {
        try {
          sprite = root.querySelector(PET_SPRITE_SELECTOR);
        } catch (error) {
          sprite = null;
        }
      }
      if (!sprite || typeof sprite.querySelector !== 'function') return null;
      try {
        return sprite.querySelector('svg');
      } catch (error) {
        return null;
      }
    }

    function setInlineStyle(node, property, value) {
      if (!node || !node.style) return false;
      try {
        if (value === null || value === undefined) {
          if (typeof node.style.removeProperty === 'function') node.style.removeProperty(property);
          else node.style[property] = '';
        } else if (typeof node.style.setProperty === 'function') {
          node.style.setProperty(property, value);
        } else {
          node.style[property] = value;
        }
      } catch (error) {
        return false;
      }
      return true;
    }

    /**
     * 把几何写进贴图 svg 的内联样式。
     *
     * 只碰 `transform` 与 `transition` 两个属性，卸载时原样撤掉；刻意不加 `!important`
     * —— pet-whale 的戳一戳挤压（pw-squish）与双击翻滚（pw-rollTrick）也 animate 在
     * 同一枚 svg 的 transform 上：让那些互动动作短暂接管、动画结束自动回到我们的朝向，
     * 比用 `!important` 把它的互动压死更合适（见 README §5）。
     */
    function applyFaceTransform(pet, geometry, config) {
      const svg = petSvgOf(pet);
      if (!svg) return false;
      setInlineStyle(svg, 'transform', geometry && geometry.transform ? geometry.transform : null);
      const ms = prefersReducedMotion()
        ? 0
        : toNumber(config && config.faceTransitionMs, DEFAULTS.faceTransitionMs, LIMITS.faceTransitionMs[0], LIMITS.faceTransitionMs[1]);
      setInlineStyle(svg, 'transition', ms > 0 ? 'transform ' + ms + 'ms ease' : null);
      return true;
    }

    /**
     * 假装工作状态下把桌宠贴图转向挂件（并歪头看向它）。
     *
     * @param options.dragging - 是否处于拖拽（调用方已判定时传进来，省一次读类名）
     * @param options.lockedSide - 拖拽期锁定的朝向（'left' | 'right' | null）
     * @returns { side, desiredSide, dragging, locked, ...几何 }，null = 本 tick 没接管
     */
    function applyFacing(config, pet, widget, options) {
      const opts = options || {};
      const root = petRootOf(pet);
      if (!root || typeof root.setAttribute !== 'function') return null;
      const dragging = opts.dragging === undefined ? petDragging(root) : !!opts.dragging;
      // 拖拽期默认继续接管（faceWhileDragging）：方向被锁定 → 拖着横穿挂件也不翻面。
      const engaged = !!config.faceWidget && !!pet && !!widget && pretendActive() && (!dragging || config.faceWhileDragging !== false);
      if (!engaged) {
        clearFacing(pet);
        return null;
      }
      const desiredSide = widget.rect.cx >= pet.rect.cx ? 'right' : 'left';
      const locked = !!(dragging && (opts.lockedSide === 'left' || opts.lockedSide === 'right'));
      const side = locked ? opts.lockedSide : desiredSide;
      const geometry = faceGeometry({
        side: side,
        parentMirrored: parentMirrored(root),
        dy: pet.rect.cy - widget.rect.cy,
        config: config,
      });
      applyFaceTransform(pet, geometry, config);
      root.setAttribute(FACE_ATTR, side);
      return {
        side: side,
        desiredSide: desiredSide,
        dragging: dragging,
        locked: locked,
        parentMirrored: geometry.parentMirrored,
        childMirror: geometry.childMirror,
        leanDeg: geometry.leanDeg,
        pitchDeg: geometry.pitchDeg,
        rotateDeg: geometry.rotateDeg,
        skewDeg: geometry.skewDeg,
        transform: geometry.transform,
      };
    }

    /** 撤掉朝向标记、贴图内联样式与 0.2.x 留下的样式表。 */
    function clearFacing(pet) {
      const root = petRootOf(pet);
      if (root && typeof root.removeAttribute === 'function') root.removeAttribute(FACE_ATTR);
      const svg = petSvgOf(pet);
      setInlineStyle(svg, 'transform', null);
      setInlineStyle(svg, 'transition', null);
      removeLegacyFaceStyle();
    }

    // ------------------------------------------------------------------
    // 桥接主体
    // ------------------------------------------------------------------

    function createBridge(ctx) {
      let localConfig = normalizeConfig(readJson(CONFIG_KEY));
      let remoteConfig = null;

      const state = {
        ticker: 0,
        settingsTimer: 0,
        adopted: false,
        disposed: false,
        nearSince: null,
        farSince: null,
        episodeTried: false,
        autoPretend: false,
        releaseFailures: 0,
        lastSpeakAt: null,
        speakCount: 0,
        pending: null,
        facing: null,
        face: null,
        dragging: false,
        lockedSide: null,
        lastDropAt: null,
        snapshot: { ready: false },
        /** pet-whale 样式表守护状态：'ok' | 'tagged' | 'repaired' | 'missing' | 'absent' */
        petStyle: null,
        /** 见过一次的 pet-whale CSS 文本（重注入时优先用它） */
        petStyleText: '',
        /** 上次用的是哪一路来源：'live' | 'cache' | 'mined' | 'snapshot' */
        petStyleSource: '',
        /** 重注入次数（诊断用） */
        petStyleRepairs: 0,
        styleObserver: null,
      };

      /** 远端设置优先于本地 localStorage 覆盖（设置页总是给出全部字段）。 */
      function effectiveConfig() {
        return remoteConfig ? remoteConfig : localConfig;
      }

      function statusSnapshot() {
        const config = effectiveConfig();
        return {
          version: VERSION,
          config: config,
          source: remoteConfig ? 'settings' : readStorage(CONFIG_KEY) ? 'localStorage' : 'defaults',
          petVisible: !!state.snapshot.pet,
          widgetVisible: !!state.snapshot.widget,
          gap: state.snapshot.gap === undefined ? null : state.snapshot.gap,
          sensorGap: state.snapshot.sensorGap === undefined ? null : state.snapshot.sensorGap,
          seeing: !!state.snapshot.seeing,
          widgetFacesLeft: state.snapshot.widget ? state.snapshot.widget.facesLeft : null,
          bubbleOpen: state.snapshot.widget ? state.snapshot.widget.bubbleOpen : null,
          facing: state.facing === undefined ? null : state.facing,
          face: state.face || null,
          dragging: !!state.dragging,
          lockedSide: state.lockedSide || null,
          lastDropAt: state.lastDropAt,
          petStyle: state.petStyle || null,
          petStyleSource: state.petStyleSource || null,
          petStyleRepairs: state.petStyleRepairs,
          petStyleHasCachedCss: !!state.petStyleText,
          pretend: { active: pretendActive(), owned: readStorage(OWNED_KEY) === '1', auto: state.autoPretend },
          speaking: !!state.pending,
          speakCount: state.speakCount,
          lastSpeakAt: state.lastSpeakAt,
          lastEvent: state.snapshot.lastEvent || null,
          autoPretend: state.autoPretend,
          episode: { tried: state.episodeTried, nearSince: state.nearSince, farSince: state.farSince },
        };
      }

      /**
       * 按优先级挑一份可用的真样式表文本：
       * live（本会话见到过 pet-whale 自己写的那份）→ cache（上次会话缓存的）
       * → mined（现场从模块加载器挖出来的 pet-whale 源码里的 WHALE_CSS）
       * → snapshot（内嵌快照，最后一道）。source 只用于日志与 status()。
       */
      function pickPetStyleCss() {
        if (state.petStyleText) return { css: state.petStyleText, source: 'live' };
        const cached = readPetStyleCache();
        if (cached) return { css: cached, source: 'cache' };
        const mined = minePetStyleCss();
        if (mined) return { css: mined, source: 'mined' };
        return { css: PET_STYLE_FALLBACK_CSS, source: 'snapshot' };
      }

      /**
       * 守护 pet-whale 的样式表：补归属标记（补了才不会被人认领/删除）、
       * 缓存真样式表文本、必要时按 pickPetStyleCss 的顺序重注入一份。
       *
       * 只在「桌宠根节点还在」时才重注入 —— 根不在说明 pet-whale 没初始化或已卸载，
       * 这时补样式没有意义（它自己 init 时会重建）。
       *
       * @returns 'ok' | 'tagged' | 'repaired' | 'missing' | 'absent'
       */
      function guardPetStyle() {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return state.petStyle;
        const previous = state.petStyle;
        let style = null;
        try {
          style = document.getElementById(PET_STYLE_ID);
        } catch (error) {
          style = null;
        }

        if (style) {
          const repairedAttr =
            typeof style.getAttribute === 'function' && style.getAttribute(PET_STYLE_REPAIR_ATTR) === '1';
          const text = typeof style.textContent === 'string' ? style.textContent : '';
          // "真货"= pet-whale 自己写的、而且看起来完整。0.3.1 补写过的那份没有
          // PET_STYLE_REPAIR_ATTR（那时还没这个标记），只能靠"像不像真样式表"认出来。
          if (!repairedAttr && isPlausiblePetCss(text)) {
            // pet-whale 自己写的那份：留一份文本（内存 + localStorage），下次就不怕丢
            state.petStyleText = text;
            state.petStyleSource = 'live';
            writePetStyleCache(text);
          } else {
            // 本桥接补写的、或一份残片（例如 0.3.1 的兜底 / 被截断的样式表）：
            // 就地升级成现在能拿到的最好的那一份（真样式表 -> 快照）
            const picked = pickPetStyleCss();
            if (picked.css !== text) {
              try {
                style.textContent = picked.css;
                state.petStyleSource = picked.source;
                if (picked.source !== 'snapshot') {
                  state.petStyleText = picked.css;
                  writePetStyleCache(picked.css);
                }
              } catch (error) {
                /* 只读属性：忽略 */
              }
            }
            // 认领下来：以后它再丢，我们知道要重写；也不会把它误当成 pet-whale 的原件
            if (typeof style.setAttribute === 'function') {
              try {
                style.setAttribute(PET_STYLE_REPAIR_ATTR, '1');
              } catch (error) {
                /* 只读属性：忽略 */
              }
            }
          }
          state.petStyle = tagStyleElement(style, PET_PLUGIN_ID) ? 'tagged' : 'ok';
        } else if (!petRootOf(null)) {
          state.petStyle = 'absent';
        } else {
          const picked = pickPetStyleCss();
          let created = null;
          if (typeof document.createElement === 'function') {
            try {
              created = document.createElement('style');
            } catch (error) {
              created = null;
            }
          }
          if (created) {
            try {
              // 真实 DOM 里 id 属性是反射的，桩 DOM 里不是：统一用 setAttribute。
              if (typeof created.setAttribute === 'function') {
                created.setAttribute('id', PET_STYLE_ID);
                created.setAttribute(PET_STYLE_REPAIR_ATTR, '1');
              } else {
                created.id = PET_STYLE_ID;
              }
              created.textContent = picked.css;
            } catch (error) {
              /* 只读属性：忽略 */
            }
            tagStyleElement(created, PET_PLUGIN_ID);
            if (appendStyleElement(created)) {
              state.petStyle = 'repaired';
              state.petStyleRepairs += 1;
              state.petStyleSource = picked.source;
              // 挖矿/缓存拿到的就是真样式表，记下来省得下一轮再挖
              if (picked.source !== 'snapshot') {
                state.petStyleText = picked.css;
                writePetStyleCache(picked.css);
              }
            } else {
              state.petStyle = 'missing';
            }
          } else {
            state.petStyle = 'missing';
          }
        }

        if (state.petStyle !== previous) {
          debugLog(
            effectiveConfig(),
            'pet-whale style guard:',
            state.petStyle,
            `(${state.petStyleSource || 'unknown'} css)`
          );
        }
        return state.petStyle;
      }

      /**
       * 在 document.head 上挂一个 childList 观察器：样式表被别的插件删掉时立刻补回来，
       * 不必等下一个 tick。环境里没有 MutationObserver（或没有 head）就只靠 tick。
       */
      function watchPetStyle() {
        if (state.styleObserver || state.disposed) return;
        if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
        const container = document.head || document.documentElement;
        if (!container || typeof container.appendChild !== 'function') return;
        try {
          state.styleObserver = new MutationObserver(() => {
            if (state.disposed) return;
            guardPetStyle();
          });
          state.styleObserver.observe(container, { childList: true });
        } catch (error) {
          state.styleObserver = null;
        }
      }

      function adoptStaleOwnership() {
        if (state.adopted) return;
        state.adopted = true;
        // 上次会话是本桥接把桌宠切进假装工作的（页面刷新后 pretendOn 仍在），
        // 重新接管，避免「刷新后一直假装工作」。
        if (readStorage(OWNED_KEY) === '1' && pretendActive()) {
          state.autoPretend = true;
          state.snapshot.lastEvent = 'adopt';
          debugLog(effectiveConfig(), 'adopt stale pretend state');
        }
      }

      function enterPretend(config) {
        if (pretendActive()) {
          debugLog(config, 'pretend already on (manual), leave it alone');
          return;
        }
        const toggled = togglePretend();
        if (toggled) {
          state.autoPretend = true;
          state.releaseFailures = 0;
          writeStorage(OWNED_KEY, '1');
          state.snapshot.lastEvent = 'pretend-on';
        } else {
          state.snapshot.lastEvent = 'pretend-on-failed';
        }
        debugLog(config, 'enter pretend:', toggled);
      }

      function releasePretend(config, reason) {
        if (!pretendActive()) {
          state.autoPretend = false;
          state.releaseFailures = 0;
          writeStorage(OWNED_KEY, null);
          return;
        }
        const toggled = togglePretend();
        debugLog(config, 'release pretend (' + reason + '):', toggled);
        if (toggled) {
          state.autoPretend = false;
          state.releaseFailures = 0;
          writeStorage(OWNED_KEY, null);
          state.snapshot.lastEvent = 'pretend-off';
          return;
        }
        state.snapshot.lastEvent = 'pretend-off-failed';
        state.releaseFailures += 1;
        if (state.releaseFailures >= RELEASE_MAX_FAILURES) {
          // 放弃接管：不要再反复切换，尊重当前状态。
          state.autoPretend = false;
          writeStorage(OWNED_KEY, null);
          debugLog(config, 'give up releasing pretend after', state.releaseFailures, 'failures');
        }
      }

      function startSpeak(now, config) {
        state.pending = { attempts: 0, lastAttempt: 0, dueAt: 0, startedAt: now, stage: 'open' };
        state.snapshot.lastEvent = 'speak-start';
        debugLog(config, 'speak: tapping widget whale');
      }

      function finishSpeak(now, config, reason) {
        state.pending = null;
        if (reason === 'spoken') {
          state.lastSpeakAt = now;
          state.speakCount += 1;
          state.snapshot.lastEvent = 'spoken';
        } else {
          // 失败后退避：等 speakIntervalMs 走完再提前 SPEAK_FAIL_BACKOFF_MS 允许重试
          state.lastSpeakAt = now - config.speakIntervalMs + SPEAK_FAIL_BACKOFF_MS;
          state.snapshot.lastEvent = 'speak-' + reason;
        }
        debugLog(config, 'speak finished:', reason);
      }

      function advanceSpeak(now, config, widget) {
        const pending = state.pending;
        if (!pending) return;
        if (now - pending.startedAt > SPEAK_OPEN_TIMEOUT_MS) {
          finishSpeak(now, config, 'timeout');
          return;
        }
        if (pending.stage === 'open') {
          if (widget.bubbleOpen) {
            pending.stage = 'advance';
            pending.dueAt = now + SPEAK_ADVANCE_DELAY_MS;
            debugLog(config, 'speak: bubble opened');
            return;
          }
          if (now - pending.lastAttempt < SPEAK_RETRY_MS) return;
          if (pending.attempts >= SPEAK_MAX_ATTEMPTS) {
            finishSpeak(now, config, 'no-bubble');
            return;
          }
          pending.lastAttempt = now;
          tapWidgetWhale(widget, pending.attempts);
          pending.attempts += 1;
          return;
        }
        if (now < pending.dueAt) return;
        // 第 1 项（余额）已显示 → 点气泡前进到第 2 项：挂件自带的默认台词。
        const tapped = tapWidgetBubble(widget);
        finishSpeak(now, config, tapped ? 'spoken' : 'no-bubble-tap');
      }

      function updateSnapshot(config, pet, widget, gap, sensorGap, seeing) {
        state.snapshot = {
          ready: true,
          pet: pet,
          widget: widget,
          gap: gap === null || gap === undefined ? undefined : gap,
          sensorGap: sensorGap === null || sensorGap === undefined ? undefined : sensorGap,
          seeing: !!seeing,
          lastEvent: state.snapshot.lastEvent,
        };
      }

      /** 算一次朝向并同步进 state（tick 与拖拽期的即时刷新共用）。 */
      function setFace(config, pet, widget, dragging) {
        const isDragging = dragging === undefined ? petDragging(petRootOf(pet)) : !!dragging;
        state.face = applyFacing(config, pet, widget, {
          dragging: isDragging,
          lockedSide: state.lockedSide,
        });
        state.facing = state.face ? state.face.side : null;
        return state.face;
      }

      function tick() {
        if (state.disposed) return;
        // 样式守护与 enabled 无关：这是修 DSH 认领/删除 <style> 的坑，不是桥接功能。
        guardPetStyle();
        const now = nowMs();
        const config = effectiveConfig();
        adoptStaleOwnership();
        const pet = readPet();
        const widget = readWidget();

        if (!config.enabled || !pet || !widget) {
          const reason = !config.enabled ? 'disabled' : 'absent';
          if (state.autoPretend) releasePretend(config, reason);
          if (state.pending) finishSpeak(now, config, reason);
          state.nearSince = null;
          state.farSince = now;
          state.episodeTried = false;
          state.facing = null;
          state.face = null;
          state.dragging = false;
          state.lockedSide = null;
          clearFacing(pet);
          updateSnapshot(config, pet, widget, null, null, false);
          return;
        }

        const gap = rectGap(pet.rect, widget.rect);
        const near = gap <= config.nearGapPx;
        const far = gap > config.releaseGapPx;

        if (near) {
          if (state.nearSince === null) state.nearSince = now;
          state.farSince = null;
        } else {
          state.nearSince = null;
          if (far) {
            if (state.farSince === null) state.farSince = now;
          } else {
            state.farSince = null; // 迟滞区间：保持现状
          }
        }

        if (!state.autoPretend && !state.episodeTried && near && state.nearSince !== null && now - state.nearSince >= config.pretendSettleMs) {
          state.episodeTried = true;
          enterPretend(config);
        }

        if (state.autoPretend) {
          if (!pretendActive()) {
            // 用户自己关掉了 → 交还控制权，本回合不再抢。
            state.autoPretend = false;
            state.episodeTried = true;
            state.releaseFailures = 0;
            writeStorage(OWNED_KEY, null);
          } else if (far && state.farSince !== null && now - state.farSince >= config.releaseSettleMs) {
            releasePretend(config, 'far');
          }
        }

        if (far && state.farSince !== null && now - state.farSince >= config.releaseSettleMs) state.episodeTried = false;

        let sensorGap = null;
        let seeing = false;
        if (state.pending) {
          advanceSpeak(now, config, widget);
        } else if (config.scanGapPx > 0) {
          const sensor = config.scanFacingOnly ? frontRect(widget.rect, widget.facesLeft) : widget.rect;
          sensorGap = rectGap(sensor, pet.rect);
          seeing = sensorGap <= config.scanGapPx;
          const quiet = state.lastSpeakAt === null || now - state.lastSpeakAt >= config.speakIntervalMs;
          if (seeing && quiet && !widget.bubbleOpen) startSpeak(now, config);
        }

        // 拖拽期锁定朝向：抓起来的那一刻钉住当前朝向 → 拖着横穿挂件也不翻面；
        // 松手时解锁，并按落点立刻重算一次（「放下时再刷新」）。
        const dragging = petDragging(pet.root);
        if (dragging && !state.dragging) {
          state.dragging = true;
          state.lockedSide = state.facing || (widget.rect.cx >= pet.rect.cx ? 'right' : 'left');
        } else if (!dragging && state.dragging) {
          state.dragging = false;
          state.lockedSide = null;
          state.lastDropAt = now;
        }

        updateSnapshot(config, pet, widget, gap, sensorGap, seeing);
        // 朝向放在最后：本 tick 刚进入的假装工作也能立刻被照顾到。
        setFace(config, pet, widget, dragging);
      }

      // -------------------- 拖拽期的实时朝向 --------------------
      //
      // tick 是 200ms 一跳，拖拽时「角度实时跟着挂件走」会明显发木，所以在 window 上
      // 另挂 pointermove / pointerup：拖拽期用 rAF 节流即时重算，松手后再补算一次
      // （pet-whale 的 dragging 类由它自己的 pointerup 摘掉，所以补算要往后放一点）。
      // 非拖拽期早退，指针动一下不会去逐帧量矩形。

      let faceFrame = 0; // requestAnimationFrame 句柄
      let faceTimer = 0; // 没有 rAF 时的兜底
      let dropTimer = 0; // 松手后的补算

      function cancelPendingFace() {
        if (faceFrame) {
          if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(faceFrame);
          faceFrame = 0;
        }
        if (faceTimer) {
          window.clearTimeout(faceTimer);
          faceTimer = 0;
        }
        if (dropTimer) {
          window.clearTimeout(dropTimer);
          dropTimer = 0;
        }
      }

      /** 即时重算朝向（不跑整条 tick：不读设置、不动气泡，纯粹为了跟手）。 */
      function faceNow() {
        faceFrame = 0;
        faceTimer = 0;
        if (state.disposed) return null;
        const pet = readPet();
        const widget = readWidget();
        if (!pet || !widget) return null;
        return setFace(effectiveConfig(), pet, widget);
      }

      /** @param delay >0 时延后跑一整轮 tick（识别「已松手」→ 解锁 + 按落点刷新） */
      function scheduleFaceNow(delay) {
        if (state.disposed) return;
        if (delay > 0) {
          if (dropTimer) return;
          dropTimer = window.setTimeout(() => {
            dropTimer = 0;
            tick();
          }, delay);
          return;
        }
        if (faceFrame || faceTimer) return;
        if (typeof window.requestAnimationFrame === 'function') {
          faceFrame = window.requestAnimationFrame(faceNow);
        } else {
          faceTimer = window.setTimeout(faceNow, 16);
        }
      }

      function onPointerMove() {
        if (state.disposed) return;
        const pet = readPet();
        if (!pet || !petDragging(pet.root)) return; // 非拖拽期不排队
        scheduleFaceNow(0);
      }

      function onPointerEnd() {
        if (state.disposed) return;
        cancelPendingFace();
        faceNow(); // 先按当前类名算一次
        scheduleFaceNow(80); // 等 pet-whale 摘掉 dragging 后再按落点刷新
      }

      function attachFaceListeners() {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        window.addEventListener('pointerup', onPointerEnd);
        window.addEventListener('pointercancel', onPointerEnd);
      }

      function detachFaceListeners() {
        cancelPendingFace();
        if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerEnd);
        window.removeEventListener('pointercancel', onPointerEnd);
      }

      // -------------------------- 远端设置 --------------------------

      function remoteSettingsService() {
        if (!ctx || typeof ctx.get !== 'function') return null;
        let direct = null;
        try {
          direct = ctx.get('remote.settings');
        } catch (error) {
          direct = null;
        }
        if (direct && typeof direct.describe === 'function') return direct;
        let root = null;
        try {
          root = ctx.get('remote');
        } catch (error) {
          root = null;
        }
        if (root && root.settings && typeof root.settings.describe === 'function') return root.settings;
        return null;
      }

      function pollSettings() {
        const service = remoteSettingsService();
        if (!service) return;
        let outcome = null;
        try {
          outcome = service.describe();
        } catch (error) {
          return;
        }
        if (!outcome || typeof outcome.then !== 'function') return;
        outcome.then(
          (response) => {
            if (state.disposed) return;
            const payload = response && response.ok === false ? null : response && response.value !== undefined ? response.value : response;
            const namespaces = payload && Array.isArray(payload.namespaces) ? payload.namespaces : [];
            let hit = null;
            for (const item of namespaces) {
              if (item && item.ns === SETTINGS_NS) {
                hit = item;
                break;
              }
            }
            if (hit && hit.value && typeof hit.value === 'object') {
              remoteConfig = normalizeConfig(hit.value);
              debugLog(effectiveConfig(), 'settings namespace loaded', remoteConfig);
            }
          },
          () => {
            /* 远端设置不可用就退回本地配置 */
          },
        );
      }

      // -------------------------- 生命周期 --------------------------

      function start() {
        if (state.ticker) return;
        tick();
        watchPetStyle();
        state.ticker = window.setInterval(tick, TICK_MS);
        pollSettings();
        state.settingsTimer = window.setInterval(pollSettings, SETTINGS_POLL_MS);
        attachFaceListeners();
        debugLog(effectiveConfig(), 'bridge started, version', VERSION);
      }

      function dispose() {
        state.disposed = true;
        if (state.ticker) {
          window.clearInterval(state.ticker);
          state.ticker = 0;
        }
        if (state.settingsTimer) {
          window.clearInterval(state.settingsTimer);
          state.settingsTimer = 0;
        }
        detachFaceListeners();
        if (state.styleObserver) {
          try {
            state.styleObserver.disconnect();
          } catch (error) {
            /* 观察器已失效 */
          }
          state.styleObserver = null;
        }
        state.petStyle = null;
        state.facing = null;
        state.face = null;
        state.dragging = false;
        state.lockedSide = null;
        clearFacing(null);
        debugLog(effectiveConfig(), 'bridge disposed');
      }

      const api = {
        version: VERSION,
        getConfig: () => effectiveConfig(),
        setConfig: (patch) => {
          const next = Object.assign({}, readJson(CONFIG_KEY) || {}, patch && typeof patch === 'object' ? patch : {});
          writeStorage(CONFIG_KEY, JSON.stringify(next));
          localConfig = normalizeConfig(next);
          debugLog(effectiveConfig(), 'config updated', localConfig);
          return localConfig;
        },
        resetConfig: () => {
          writeStorage(CONFIG_KEY, null);
          localConfig = normalizeConfig(null);
          return localConfig;
        },
        status: () => statusSnapshot(),
        tick: () => {
          tick();
          return statusSnapshot();
        },
        /** 立刻允许下一次播报（仍需挂件扫到桌宠）。 */
        speakNow: () => {
          state.lastSpeakAt = null;
          return statusSnapshot();
        },
        /** 手动设置桌宠假装工作模式（同时接管/交还所有权）。 */
        setPretend: (value) => {
          const want = value !== false;
          if (pretendActive() === want) return want;
          const toggled = togglePretend();
          if (toggled) {
            state.autoPretend = want;
            state.releaseFailures = 0;
            writeStorage(OWNED_KEY, want ? '1' : null);
          }
          return toggled;
        },
        /** 内部：供 HMR / 重复激活时释放旧实例。 */
        __dispose: dispose,
      };

      return { api: api, state: state, tick: tick, start: start, dispose: dispose };
    }

    return {
      inject: [],
      apply(ctx) {
        const existing = window.__dshWhaleBridge;
        if (existing && typeof existing.__dispose === 'function') {
          try {
            existing.__dispose();
          } catch (error) {
            /* 旧实例已坏就忽略 */
          }
        }
        if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
        const bridge = createBridge(ctx);
        bridge.start();
        const api = bridge.api;
        window.__dshWhaleBridge = api;
        const stop = () => {
          bridge.dispose();
          if (window.__dshWhaleBridge === api) {
            try {
              delete window.__dshWhaleBridge;
            } catch (error) {
              window.__dshWhaleBridge = undefined;
            }
          }
        };
        // cordis: effect(cb) 立刻执行 cb，并把 cb 的返回值登记为清理器
        if (ctx && typeof ctx.effect === 'function') {
          try {
            ctx.effect(() => stop);
          } catch (error) {
            /* 作用域已失效：退化为只能由下一次激活释放 */
          }
        }
        return stop;
      },
      __internals: {
        VERSION: VERSION,
        TICK_MS: TICK_MS,
        DEFAULTS: DEFAULTS,
        LIMITS: LIMITS,
        PRETEND_KEY: PRETEND_KEY,
        OWNED_KEY: OWNED_KEY,
        CONFIG_KEY: CONFIG_KEY,
        normalizeConfig: normalizeConfig,
        rectGap: rectGap,
        frontRect: frontRect,
        toNumber: toNumber,
        toBoolean: toBoolean,
        createBridge: createBridge,
        readPet: readPet,
        readWidget: readWidget,
        togglePretend: togglePretend,
        tapWidgetWhale: tapWidgetWhale,
        tapWidgetBubble: tapWidgetBubble,
        whaleTapPoints: whaleTapPoints,
        pretendActive: pretendActive,
        applyFacing: applyFacing,
        faceGeometry: faceGeometry,
        leanDegrees: leanDegrees,
        petSvgOf: petSvgOf,
        removeLegacyFaceStyle: removeLegacyFaceStyle,
        clearFacing: clearFacing,
        parentMirrored: parentMirrored,
        prefersReducedMotion: prefersReducedMotion,
        FACE_ATTR: FACE_ATTR,
        FACE_STYLE_ID: FACE_STYLE_ID,
        PET_STYLE_ID: PET_STYLE_ID,
        PET_PLUGIN_ID: PET_PLUGIN_ID,
        PET_STYLE_FALLBACK_CSS: PET_STYLE_FALLBACK_CSS,
        PET_STYLE_REPAIR_ATTR: PET_STYLE_REPAIR_ATTR,
        PET_STYLE_CACHE_KEY: PET_STYLE_CACHE_KEY,
        PET_STYLE_CACHE_MIN_CHARS: PET_STYLE_CACHE_MIN_CHARS,
        PET_STYLE_MINE_MIN_CHARS: PET_STYLE_MINE_MIN_CHARS,
        tagStyleElement: tagStyleElement,
        appendStyleElement: appendStyleElement,
        readTemplateLiteral: readTemplateLiteral,
        stripTemplateExpressions: stripTemplateExpressions,
        minePetStyleCss: minePetStyleCss,
        readPetStyleCache: readPetStyleCache,
        isPlausiblePetCss: isPlausiblePetCss,
        writePetStyleCache: writePetStyleCache,
        PET_DRAGGING_CLASS: PET_DRAGGING_CLASS,
      },
    };
  },
});
