/**
 * dsh-whale-bridge — 宿主半。
 *
 * 桥接逻辑全部在客户端半（lib/client.js）：它用合成 DOM 事件驱动 pet-whale 与
 * dsh-whale-widget，两个被串联的插件都不需要改一行。
 *
 * 宿主半只做一件事：导出根级 volatile 的 `Config`，让内核把命名空间
 * 'dsh-whale-bridge' 暴露到设置页（表单由内核按 schema 自动生成）。客户端半
 * 每 15s 读一次 api.settings.describe()，所以设置改动最多 15s 生效；也可以
 * 用 window.__dshWhaleBridge.setConfig()/localStorage 立即生效。
 *
 * 依赖说明：`@deepseek-ai/schemastery` 不写进 package.json —— profile 的
 * 共享模块索引（<profiles>/node_modules 下的 junction）会把它解析到内核同版
 * 的 schemastery，这样既避免 autoInstallPeers:false 下的依赖安装问题，也不会
 * 声明任何 @deepseek-ai/dsh* peer 而触发兼容性门禁。
 */
import Schema from '@deepseek-ai/schemastery';

/** 默认值必须与 lib/client.js 的 DEFAULTS 保持一致。 */
const DEFAULT_ENABLED = true;
const DEFAULT_FACE_WIDGET = true;
const DEFAULT_LEAN_MAX_DEG = 26;
const DEFAULT_LEAN_RANGE_PX = 240;
const DEFAULT_LEAN_DEAD_PX = 12;
const DEFAULT_PITCH_RATIO = 0.35;
const DEFAULT_FACE_TRANSITION_MS = 180;
const DEFAULT_FACE_WHILE_DRAGGING = true;
const DEFAULT_NEAR_GAP_PX = 140;
const DEFAULT_RELEASE_GAP_PX = 300;
const DEFAULT_SCAN_GAP_PX = 200;
const DEFAULT_SCAN_FACING_ONLY = true;
const DEFAULT_SPEAK_INTERVAL_MS = 25000;
const DEFAULT_PRETEND_SETTLE_MS = 400;
const DEFAULT_RELEASE_SETTLE_MS = 1000;
const DEFAULT_DEBUG = false;

/**
 * 构造设置 schema。
 *
 * 根节点必须 volatile：内核只在根（或最近的易变祖先）是 volatile 时返回完整
 * 表单（见 @deepseek-ai/dsh-settings 的 volatileForm / validateVolatileSchema）。
 * 注意 volatile 字段不能互相嵌套，所以这里只有根一层 volatile。
 *
 * @param zz - schemastery 实例（注入便于单测）
 */
export function buildConfigSchema(zz = Schema) {
  return zz
    .object({
      enabled: zz
        .boolean()
        .default(DEFAULT_ENABLED)
        .description('总开关：关掉后桥接不再切换桌宠模式、也不再触发挂件气泡'),
      faceWidget: zz
        .boolean()
        .default(DEFAULT_FACE_WIDGET)
        .description('假装工作状态下把桌宠镜像转向挂件所在的一侧（只改贴图朝向，不动原插件代码）'),
      leanMaxDeg: zz
        .number()
        .min(0)
        .max(90)
        .default(DEFAULT_LEAN_MAX_DEG)
        .description('朝向挂件时的最大歪头角度(度)：挂件在正上方/正下方时达到上限，0 = 不歪头'),
      leanRangePx: zz
        .number()
        .min(20)
        .max(2000)
        .default(DEFAULT_LEAN_RANGE_PX)
        .description('歪头角度的垂直量程(px)：上下偏差达到该值就用满 leanMaxDeg'),
      leanDeadPx: zz
        .number()
        .min(0)
        .max(600)
        .default(DEFAULT_LEAN_DEAD_PX)
        .description('垂直偏差死区(px)：小于该值不歪头，避免桌宠与挂件等高时来回抖动'),
      pitchRatio: zz
        .number()
        .min(0)
        .max(1)
        .default(DEFAULT_PITCH_RATIO)
        .description('仰角剪切占比：在歪头之外再叠一点 skewY 让“抬头/低头”更有立体感，0 = 只旋转'),
      faceTransitionMs: zz
        .number()
        .min(0)
        .max(2000)
        .default(DEFAULT_FACE_TRANSITION_MS)
        .description('贴图朝向变化的过渡时长(ms)：翻面与歪头都是平滑动画，0 = 瞬间切换'),
      faceWhileDragging: zz
        .boolean()
        .default(DEFAULT_FACE_WHILE_DRAGGING)
        .description('拖拽桌宠期间继续接管朝向：方向锁住不变、角度实时跟着挂件；关掉则拖拽期间让原插件自己管'),
      nearGapPx: zz
        .number()
        .min(0)
        .max(4000)
        .default(DEFAULT_NEAR_GAP_PX)
        .description('桌宠与挂件贴图的最短间距 ≤ 该值(px) 视为「靠近」，进入假装工作'),
      releaseGapPx: zz
        .number()
        .min(0)
        .max(4000)
        .default(DEFAULT_RELEASE_GAP_PX)
        .description('间距 > 该值(px) 且持续 releaseSettleMs 才退出假装工作（迟滞，需 ≥ nearGapPx）'),
      scanGapPx: zz
        .number()
        .min(0)
        .max(4000)
        .default(DEFAULT_SCAN_GAP_PX)
        .description('挂件贴图（或朝向侧半边）与桌宠间距 ≤ 该值(px) 视为「扫到」；0 = 关闭气泡播报'),
      scanFacingOnly: zz
        .boolean()
        .default(DEFAULT_SCAN_FACING_ONLY)
        .description('仅用挂件朝向屏幕中心的那半边贴图当作「视野」，更贴近“面向桌宠才看到”'),
      speakIntervalMs: zz
        .number()
        .min(2000)
        .max(3600000)
        .default(DEFAULT_SPEAK_INTERVAL_MS)
        .description('两次气泡播报的最小间隔(ms)，避免文字频繁闪烁'),
      pretendSettleMs: zz
        .number()
        .min(0)
        .max(60000)
        .default(DEFAULT_PRETEND_SETTLE_MS)
        .description('靠近持续该时长(ms)后才进入假装工作，抑制抖动'),
      releaseSettleMs: zz
        .number()
        .min(0)
        .max(60000)
        .default(DEFAULT_RELEASE_SETTLE_MS)
        .description('远离持续该时长(ms)后才退出假装工作'),
      debug: zz
        .boolean()
        .default(DEFAULT_DEBUG)
        .description('在浏览器控制台打印桥接决策过程（[dsh-whale-bridge] 前缀）'),
    })
    .volatile();
}

/** 本插件的设置 schema 实例。命名空间 id 就是 profile 条目 id。 */
export const Config = buildConfigSchema();

/**
 * 宿主半没有需要注册的服务或资源：桥接的定时器、DOM 事件都在客户端半里，
 * 由客户端的 apply 生命周期管理。
 */
export function apply() {}
