# dsh-whale-bridge

桌宠 `pet-whale` 与 `dsh-whale-widget`（余额鲸鱼挂件）之间的**串联插件**：它不改动这两个插件的任何源文件，只是站在旁边观察它们的 DOM，并在合适的时机替用户"点一下"。

| 场景 | 桥接做的事 |
| --- | --- |
| 桌宠靠近鲸鱼挂件 | 让桌宠进入它自带的**「💼 假装工作」**模式（靠近时自动开、远离时自动关） |
| 假装工作期间 | 让桌宠贴图**转向并歪头对准**挂件（镜像 + 侧倾，挂件在上方就抬头、下方就低头），拖拽时保持朝向并实时转动，松手后再按落点刷新 |
| 鲸鱼挂件"看到"桌宠（贴图正对着它且距离够近） | 用挂件**自带的默认气泡**播一条**默认台词**（默认 25s 内最多一次，避免文字闪烁） |

```
       靠近 (gap ≤ nearGapPx)                     扫到 (sensorGap ≤ scanGapPx)
pet-whale ─────────────────────▶ 假装工作      dsh-whale-widget ─────────────▶ 默认气泡 + 默认台词
          ◀───────────────────── 退出假装工作              ◀─────────────────────  间隔限制 speakIntervalMs
       远离 (gap > releaseGapPx)                   点鲸鱼 → 点气泡（合成事件）
```

---

## 1. 为什么用"合成事件"这种方式

排查结论（两个插件都翻过源码了）：

* **pet-whale 1.2.6**：客户端没有导出任何 API，没有自定义事件、没有 `postMessage`，只有 localStorage 键 `pet-whale:pretend`。但它把 `.pet-official` / `.dsh-whale-menu` 直接放在普通 DOM 里（**没有 shadow DOM**），右键菜单项 `💼 假装工作` 的处理函数**没有 `isTrusted` 校验**，而且 `openMenu → buildMenu` 是同步的。
* **dsh-whale-widget 0.3.16**：同样没有气泡 API（只暴露 `window.__dshWhaleRoot` 给外部定位）。它的点击判定 `isWhaleHit(e)` **只读 `e.clientX / e.clientY`**（把坐标映射进 610×610 的贴图再读 alpha），挂件是 `pointerdown`/`pointerup`/`bubbleBox.click` 三段式，也没有 `isTrusted` 校验。

所以桥接用"同一同步任务内派发合成事件"实现，**全程不产生中间绘制**：菜单不会闪一下，气泡也不会闪一下。

> ⚠️ **有意为之的偏离**：产品自带的插件开发指引（`cordis-plugin-development/references/ui-plugin.md`）明文要求
> "Do not read another plugin's DOM, stylesheet, or component source to estimate placement"。
> 本插件**违反**了这一条 —— 因为 pet-whale 与 dsh-whale-widget 都没有暴露任何可用的对接 API，
> 不做 DOM 观察就根本无法实现用户要的交互。代价是：这两个插件升级改类名/文案后，本插件可能需要跟着改
> （改的是 `lib/client.js` 顶部的选择器常量与 `PRETEND_LABEL_HINTS`，都在文件开头，集中且易改）。

### 交互细节

* **假装工作**：先对 `.pet-official` 派发 `contextmenu`（坐标取贴图中心），再在**同一个同步任务**里点掉 `.dsh-whale-menu` 中带 `💼`（回退匹配 `假装` / `pretend`）的按钮——和用户自己右键点菜单完全等价。
* **默认气泡 + 默认台词**：对 `.dshwv-img` 派发 `pointerdown`+`pointerup`（＝点鲸鱼，弹出挂件默认序列第 1 项：余额），等 `.dshwv-pop` 出现 `dshwv-pop-open` 后再派发一次 `click`（＝`bubbleNext()`，前进到第 2 项：**挂件自带的默认随机台词**）。
* **"看到"的方向感**：挂件翻转由 `.dshwv-root.dshwv-left` 表示，未翻转时面对面朝右、翻转时面朝左；`scanFacingOnly: true`（默认）只把**前侧那半边贴图**当作视野，所以"鲸鱼背对着桌宠"时不会说话。
* 挂件菜单正开着时，第一次点击只会被用来关菜单——桥接会自动重试（最多 3 次，间隔 450ms），整轮 6s 超时。

### 「假装工作时面朝挂件」是怎么做的

鲸鱼贴图默认**朝左**（眼睛画在 svg 左侧）。pet-whale 自己用内联 `transform: scaleX(±1)` 表示朝向，但它在「假装工作」时给 `.pet-official` 挂了 `animation: pw-swim` —— CSS 动画会**盖掉**内联 transform，所以桥接往**内层 `svg`**（`[data-dsh-whale] .pet-official svg`）写**内联** `style.transform`：与父级动画正交，转向做到了、原动画照旧。

内联而不是注入 `<style>`，是因为歪头角度要**逐帧**变化 —— 静态样式表表达不了"每帧一个角度"（`0.2.0` 曾经用注入样式表，还因为 `'[' + '[data-dsh-whale]' + ']'` 拼出 `[[data-dsh-whale]]` 这种非法选择器，被浏览器整条丢弃、镜像静默失效；`0.2.1` 修好，`0.3.0` 干脆改成内联，这类失效模式随之消失）。

* **朝向**：`scaleX(-1)` 表示朝右。要不要镜像由「**父级当前镜像状态 XOR 期望方向**」决定（父级在 `pw-swim` 动画跑着时不镜像，但在**拖拽**态和 `prefers-reduced-motion` 态会自己上 `!important` 的 `scaleX`，此时据 `data-facing` 判断），净朝向始终朝挂件，不会镜像反。
* **歪头（侧倾/仰角）**：`rotate(θ)` + `skewY(θ × pitchRatio)`，其中 `θ = leanMaxDeg × clamp((桌宠中心y − 挂件中心y) / leanRangePx, -1, 1)`（`|Δy| ≤ leanDeadPx` 的死区内不歪头）。挂件在**上方 → 正角 = 抬头**，在下方 → 低头；`skewY` 制造一点点近大远小的"仰角"错觉。旋转支点沿用原插件的 `transform-origin: 50% 85%`（底部中央），所以是"以底座为轴倾身"而非原地打转。
  * 角度的方向**与父子镜像无关**：整体矩阵是 `diag(p·c, 1) · R(A)`，头部局部坐标 `(-1, 0)` 的 y 分量恒为 `−sin A`（`rotate` 与 `skewY` 的 y 分量都与翻转解耦），父级翻转掉的方向，正好被"期望的视觉方向本身也随净朝向翻转"抵消。
* **拖拽时保持方向、放下再刷新**：拖拽期锁定进入拖拽时的那一侧（`lockedSide`），横穿挂件也不会突然翻面；松手后清掉锁定、按新落点重算一次。想让它照旧"让位"就给 `faceWhileDragging: false`。
* **实时**：拖拽期额外挂 `pointermove`（passive）+ `pointerup/pointercancel`，用 `requestAnimationFrame` 节流重算角度，不必等 200ms 的决策 tick；`pointerup` 时立刻重算一次，并在 80ms 后补算（pet-whale 摘掉 `.dragging` 类比我们的 `pointerup` 晚）。
* **动画**：`transition: transform <faceTransitionMs>ms ease`，翻面与歪头都平滑；`prefers-reduced-motion: reduce` 时过渡时长归零。
* 当前状态随时可查：`window.__dshWhaleBridge.status()` → `facing`（`'left' | 'right' | null`）、`face`（含 `leanDeg / rotateDeg / skewDeg / locked / parentMirrored` 的几何对象）、`dragging`、`lockedSide`、`lastDropAt`（`null` = 未接管，例如没在假装工作、`faceWhileDragging: false` 且正在拖拽、或 `faceWidget: false`）。

---

## 2. pet-whale 样式表守护（0.3.1 起，0.3.2 完善）

DSH 的客户端模块系统在每次物化插件时，会把文档里**没有 `data-plugin` 属性的 `<style>`** 认领到当时正在物化的那个插件名下（`@deepseek-ai/dsh-client-modules/lib/client.js` 的 `claimStyles()`），之后那个插件失效 / 热重载时会用自己的 id 做一次回收（`removeOwnedStyles()`），于是这些被认领的样式表被一并删掉。

pet-whale 建自己的 `#pet-whale-style` 时**没有打这个标**，所以它可能先被某个插件（本桥接的某次物化，或任何别的插件）认领，然后在那个插件重载时被删掉。样式表一没，桌宠根节点 `[data-dsh-whale]` 的 `position:fixed` 与 `width/height: calc(137px * var(--pw-scale))` 全部失效；里面那枚行内 `<svg viewBox="-2 -1 26 19">`（没有 width/height 属性）按 SVG 默认宽度撑满 body，装饰节点 `🐟`、`Zzz...` 也变成页面上的一行裸文本 —— 就是"整只桌宠卡在一个超大的黑边区域里"那个现象。

`dsh-whale-widget` 的作者在 PR #114 里踩过同一个坑，修法是给自己的 `<style>` 打上 `data-plugin="dsh-whale-widget"`（`assets/whale-widget.js:878-885` 有完整注释）。

本桥接不改 pet-whale 的源文件，只做守护：

* **补标**：见到 `#pet-whale-style` 就补上 `data-plugin="pet-whale"`。打了标之后 `claimStyles()` 不会再认领它，DSH 只会在 pet-whale **自己**被重载时回收它 —— 而那一刻 pet-whale 会立刻重建一份新的，所以是自愈的。
* **缓存**：见到真样式表就把它的文本记进内存，并写进 `localStorage['dsh-whale-bridge:pet-css']`（≥400 字符才写），下次刷新哪怕又丢了也能立刻还原。
* **重注入（按优先级取文本）**：万一样式表还是没了、而 `[data-dsh-whale]` 根节点还在，就重注入一份同 id、已打标、带 `data-whale-bridge-repaired="1"` 的样式表。文本来源依次是
  1. `live` —— 本会话见到过的真样式表；
  2. `cache` —— 上次会话缓存进 localStorage 的那份；
  3. `mined` —— **现场从 DSH 模块加载器里挖出来的**：注册时 `@deepseek-ai/dsh-client-modules` 会把每个插件客户端的 `factory` 原样存进 `window.__ModuleLoader__.factories`（Map），而 pet-whale 的整个模块体（含 `const WHALE_CSS = \`…\``）都在 `factory` 里，于是 `Function.prototype.toString` 就能连同 CSS 一起交出来 —— 这条路拿到的样式表**版本永远与装着的 pet-whale 一致**（其中唯一一处模板插值会被剥掉）；
  4. `snapshot` —— 实在拿不到就用内嵌的 pet-whale 1.2.6 `WHALE_CSS` 快照（逐字，同样剥掉那处插值）。
  pet-whale 下次初始化会 `getElementById("pet-whale-style")?.remove()` 再建自己的完整版，天然覆盖我们的补写，不会打架。
* **触发时机**：每次 tick（200ms）顺带查一次；另外在 `document.head` 上挂一个 `childList` 观察器 —— pet-whale 若在本桥接之后才物化，它的样式表刚插进来就会被立刻补标。这一项**与 `enabled` 开关无关**：它修的是 DSH 的通用行为，不是桥接功能。
* **自查**：`window.__dshWhaleBridge.status()` 里的 `petStyle`（`ok` / `tagged` / `repaired` / `missing` / `absent`）、`petStyleSource`（`live` / `cache` / `mined` / `snapshot`）、`petStyleRepairs`、`petStyleHasCachedCss`。

> **0.3.1 的教训（0.3.2 修）**：0.3.1 的"兜底"只写了"压住灾难"的几条规则 —— 忘了恢复 `[data-dsh-whale] .pet-official` 的 `pointer-events: auto`（桌宠收不到指针事件，**拖不动**），也忘了隐藏 `.dsh-whale-menu`（菜单常驻展开、把页面撑开）。于是当它真的被派上用场时，反而做出一版比"没样式"更怪的界面。0.3.2 的结论是：兜底要么就是**真样式**（挖矿 / 缓存 / 内嵌快照三选一），要么就根本不要接管；那条 `pointer-events:auto` 与菜单的 `display:none` / `.open{display:block}` 现在都有单元测试盯着。

> 未打标的 `<style>` 被认领/删除**不是** pet-whale 独有的问题：任何插件把自己 `<style>` 注入文档而没打标都可能中招。哪天看到别的插件样式突然全丢，先怀疑这一条。

---

## 3. 配置

配置文件即设置命名空间 `dsh-whale-bridge`（宿主半导出了 volatile `Config`，DSH 会自动生成设置表单）。
**优先级：设置页 > `localStorage['dsh-whale-bridge:config']` > 内置默认值。**

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总线开关，关掉会立刻退出假装工作并停止播报 |
| `faceWidget` | `true` | 假装工作时让桌宠贴图面向挂件（转向 + 歪头；只改内层 `svg` 的内联 transform，不动原插件代码/属性） |
| `leanMaxDeg` | `26` | 最大歪头角度（度）。挂件相对桌宠的垂直偏差拉满时就是它 |
| `leanRangePx` | `240` | 垂直偏差到多少像素算"拉满"（超出按上限截断） |
| `leanDeadPx` | `12` | 垂直偏差小于该值就不歪头（避免挂件与桌宠几乎等高时轻微晃动） |
| `pitchRatio` | `0.35` | 仰角剪切占歪头角度的比例（`skewY(θ × 该值)`），`0` = 只转不切 |
| `faceTransitionMs` | `180` | 转向/歪头的过渡时长（ms），`0` = 硬切；`prefers-reduced-motion` 时自动归零 |
| `faceWhileDragging` | `true` | 拖拽桌宠期间是否继续接管朝向（锁定拖拽开始时的方向、角度实时跟随；`false` = 拖拽期让位给 pet-whale 自己的抓取朝向） |
| `nearGapPx` | `140` | 桌宠与挂件的间距 ≤ 该值算"靠近"（相交为 0） |
| `releaseGapPx` | `300` | 间距 > 该值算"远离"；两者之间是**迟滞区**，保持现状不抖动 |
| `scanGapPx` | `200` | 挂件视野与桌宠的间距 ≤ 该值算"看到"；`0` = 关闭播报 |
| `scanFacingOnly` | `true` | 只认挂件**前侧**那半边贴图作为视野 |
| `speakIntervalMs` | `25000` | 两次播报的最小间隔（防闪烁） |
| `pretendSettleMs` | `400` | 靠得多近多久才进入假装工作 |
| `releaseSettleMs` | `1000` | 离开多久才退出假装工作 |
| `debug` | `false` | 打开后把决策日志打到 `console` |

### 运行时 API（调试用）

```js
window.__dshWhaleBridge.getConfig()          // 当前生效配置
window.__dshWhaleBridge.setConfig({ ... })   // 局部覆盖（写 localStorage，立即生效）
window.__dshWhaleBridge.resetConfig()        // 清掉本地覆盖，回到设置页/默认值
window.__dshWhaleBridge.status()             // 快照：可见性、gap、sensorGap、seeing、speakCount、pretend 所有权…
window.__dshWhaleBridge.speakNow()           // 忽略间隔，允许下一次播报
window.__dshWhaleBridge.setPretend(true)     // 手动开关一次 pretend（走合成右键，等价于用户点菜单）
window.__dshWhaleBridge.tick()               // 立即跑一次决策（调试）
```

### 不抢用户的手

* 只有在**本桥接自己打开**假装工作（`localStorage['dsh-whale-bridge:owned'] === '1'`）时才会去关它；
  用户手动开着假装工作时，桥接不接管、远离也不关。
* 自动开启后用户自己关掉 → 本轮"靠近回合"内不再抢，直到桌宠真的离开过再回来。
* 刷新页面后如果发现 `owned=1` 且 pretend 还开着，会重新接管（避免刷新一次就永远假装工作）。

---

## 4. 安装 / 卸载

包内已带 `cordis.patch.yml`，正确的安装方式是让插件管理器（或桌面端）把它作为 profile bundle 装入：

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-whale-bridge
      name: dsh-whale-bridge
```

> 注意：本包**不声明任何 dependencies / peerDependencies**。宿主半的 `import Schema from '@deepseek-ai/schemastery'`
> 依赖 DSH profile 的共享模块索引（`<profiles>/node_modules/@deepseek-ai/*`）解析，因此**必须装在 profile 目录里**
> （`<profile>/node_modules/dsh-whale-bridge`），不能用会保持符号链接的 `link:` 方式安装到别处。

卸载：从 profile 的 `dsh.profile.bundles` 移除 `dsh-whale-bridge` 并删掉 `<profile>/node_modules/dsh-whale-bridge`，重启桌面端。
插件本身也会在卸载时清理：`ctx.effect` 登记的清理器会停掉定时器并摘掉 `window.__dshWhaleBridge`（支持客户端 HMR 重载，不会累积定时器）。

---

## 5. 校验

`../verify-whale-bridge.mjs` 是**自包含**的校验脚本（不依赖 DSH 运行时）：

```powershell
node ..\verify-whale-bridge.mjs      # 71/71 通过则退出码 0
```

它做的事：

* 用 DOM 桩 + 虚拟时钟在 `node:vm` 里跑**真实的** `lib/client.js`，再用桩模拟 pet-whale 的右键菜单与 dsh-whale-widget 的贴图/气泡点击管线，断言几何、迟滞、所有权、合成事件序列、重试与退避、以及朝向（镜像 XOR、歪头角度/死区/量程/上限、拖拽锁定与实时重算、松手补算、过渡时长、`prefers-reduced-motion` 三例、卸载清理与内联样式回收）；
* 用内核同版的 `schemastery`（`<profiles>/node_modules/@deepseek-ai/schemastery`）真实构建宿主半的 `Config`，断言根节点 volatile、默认值与客户端 `DEFAULTS` **逐字段一致**、越界/非法值被 `ValidationError` 拒绝。
* 样式表守护用桩 DOM 覆盖：桌宠在而样式表从未出现 → 快照重注入且反复 tick 不重复注入；没有桌宠时不插手；pet-whale 自己的样式表被补标并缓存文本；已被别的插件认领的改回 `pet-whale`；样式表被删后用**缓存文本**重注入并计数 +1；**残缺样式表（0.3.1 兜底那种又短又缺规则的形态）会被认出来、就地升级成真样式表、并且不会把残片当成"真样式表"缓存**；内嵌快照的关键规则齐全且没有未展开的插值；能从 `__ModuleLoader__.factories` 挖出真样式并就地升级（短于门槛的不认）；上次会话的缓存能直接复用；已打对标的 `ok` 且不重复注入；只碰 `#pet-whale-style`、别的插件样式表原样不动；`tagStyleElement` / `stripTemplateExpressions` / `readTemplateLiteral` 纯函数边界；卸载后不再重注入。

---

## 6. 已知限制

* 依赖两个被串联插件的 DOM 契约（见 §1 的偏离说明）：类名/文案变了就要同步改 `lib/client.js` 顶部常量。
* 朝向/歪头是靠往 pet-whale 的**内层 `svg` 写内联 `style.transform` / `style.transition`** 实现的；本插件"写"进别人 DOM 的地方只有两处，这是其一（只写这一枚子节点的这两个属性，退出假装工作或卸载时会删干净；不碰 `.pet-official` 的内联 style，也不碰 `data-facing`）。另一处是 §2 的样式表守护：给 `#pet-whale-style` 补 `data-plugin` 属性；只有它已经丢失、而桌宠根节点还在时，才会重注入一份同 id 的样式表。
* 原插件的两个互动动作会在**动画期间短暂盖掉**桥接的 transform（它们在**同一枚 `svg`** 上 animate，且都带 `animation` 优先级）：`pw-squish`（戳一戳，0.42s，只写 `scale()`）和 `pw-rollTrick`（双击翻滚，0.65s，只有 `translate/rotate`）。桥接故意不加 `!important` —— 让用户的互动优先，动画结束自动回到朝向状态；`pw-swim` 跑在父级 `.pet-official` 上，与此正交，不受影响。
* 歪头只做**绕底部中央的侧倾（rotate）+ 仰角错觉（skewY）**，没有真正的 3D 透视；鲸鱼贴图是侧视的，`skewY` 值过大会显得被拉斜，所以 `pitchRatio` 默认压低到 `0.35`。
* 桥接只在**桌宠与挂件同时存在**时工作；其中一个被隐藏（贴图尺寸为 0）视为不存在，不做任何动作。
* 播报用的是挂件的默认序列（先余额、再台词），因此挂件自己的"每轮消耗/告警"气泡优先级不受影响。

---

## 7. 本机安装记录（2026-09-30）

| 项 | 值 |
| --- | --- |
| 版本 | `0.3.2`（§2 的样式表守护改成"真样式兜底"：不再用一小段自写 CSS 顶替，而是按 `live` → `cache` → `mined`（现场从 `__ModuleLoader__.factories` 反解 pet-whale 源码里的 `WHALE_CSS`）→ `snapshot`（内嵌 36 KB 真样式表）取文本；并且**不再相信又短又缺规则的样式表**——0.3.1 那份残缺兜底（没有 `pointer-events:auto`、没藏 `.dsh-whale-menu`）正是"菜单常驻展开 + 拖不动"的原因，现在会被认出来就地升级。`0.3.1` 给 `#pet-whale-style` 补 `data-plugin` + 缓存文本 + 丢失后重注入；`0.3.0` 歪头/侧倾 + 仰角剪切、拖拽期锁定方向与实时重算、松手后按落点刷新、翻面/歪头过渡动画，朝向改为写内层 `svg` 的**内联** transform，不再注入样式表；`0.2.1` 修掉 `0.2.0` 注入样式表里的非法选择器 `[[data-dsh-whale]]…`；`0.2.0` 首次加入 `faceWidget`） |
| 工作区源码 | `E:\1\dsh-whale-bridge\` |
| 已装位置 | `C:\Users\coh23\.dsh\profiles\desktop\node_modules\dsh-whale-bridge\`（**拷贝**，不是链接） |
| profile 清单 | `C:\Users\coh23\.dsh\profiles\desktop\package.json` → `dsh.profile.bundles` 末尾新增 `"dsh-whale-bridge"`（未动 `dependencies`，以免影响 pnpm 的 lockfile） |
| 清单备份 | `E:\1\_backup\desktop-package.json.<时间戳>.bak` |
| 被串联插件的原始副本 | `E:\1\_backup\pet-whale-original\`、`E:\1\_backup\dsh-whale-widget-original\` |
| 已装文件哈希（SHA256 前 16 位，0.3.2） | `lib/client.js` = `5794A26A86859212`、`package.json` = `3407F18C5EA9BC36`、`lib/index.js` = `C60B45FBD9E2736B`、`cordis.patch.yml` = `A6A389EC44E68EE1`、`icon.svg` = `448EBF22280E9091`、`locale/zh.json` = `7E0E1528DA392595`、`locale/en.json` = `5D9B8E926222CCF6`（与工作区逐文件一致；README.md 自身会因为写入这行哈希而变，故不列。工作区的 `package.json` 之后为发布补了元数据、并新增了 `LICENSE`/`PUBLISHING.md`，见 §8——profile 里那份运行时拷贝未动，行为一致） |
| 生效方式 | 设置页新增的 6 个字段（`leanMaxDeg` 等）来自**宿主半**，要看到它们需**重启 DSH 桌面端**；若只用默认值、不打算改设置，重载界面窗口（窗口内 `Ctrl+R`）即可用上新客户端半。§2 的样式守护也在客户端半：**改完文件后要重载一次窗口（`Ctrl+R`）才会生效**（客户端半是随页面加载/热重载下发的，光拷文件不一定马上跑）；重载后若桌宠正处于"超大裸奔"或"菜单常驻展开"状态，它会被就地修回真样式 |

回退（任选其一）：

```powershell
# 1) 只关掉桥接，保留文件
$p='C:\Users\coh23\.dsh\profiles\desktop\package.json'
(Get-Content $p -Raw | ConvertFrom-Json) | ForEach-Object { $_.dsh.profile.bundles = $_.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-whale-bridge' }; $_ } |
  ConvertTo-Json -Depth 10 | Set-Content $p -Encoding utf8

# 2) 完全卸载
Remove-Item -Recurse -Force 'C:\Users\coh23\.dsh\profiles\desktop\node_modules\dsh-whale-bridge'
Copy-Item 'E:\1\_backup\desktop-package.json.<时间戳>.bak' 'C:\Users\coh23\.dsh\profiles\desktop\package.json' -Force
```

重启后在浏览器控制台执行 `window.__dshWhaleBridge.status()`：能看到快照即为已激活；
若启动日志出现 `skipping profile bundle "dsh-whale-bridge"`，说明宿主半加载失败，把该行错误发我即可。

---

## 8. 分享给别人（发布 npm / 上架市场）

本机这套是"手工装进 profile"（§7）。要让别人能像装 `pet-whale`、`dsh-whale-widget` 那样**一句话安装**、或在插件市场里搜到，需要两件事（都不改代码）：

1. 把本目录放到一个公开 GitHub 仓库（市场只管收录 GitHub 仓库）；
2. 往精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提一个 YAML 小文件的 PR（站点与市场会自动收录，通常一天内生效）。

发布到 npm 可选（能显示下载量、安装更快）。**每个命令、要粘贴的文件内容、审查要点**见 [`PUBLISHING.md`](./PUBLISHING.md)。

> 与运行时无关：发布用的 `package.json` 元数据（`repository`/`keywords`/`engines`/`publishConfig`）、新增的 `LICENSE` 都只影响 npm/GitHub 展示，**不改插件行为**。因此 profile 里那份运行时拷贝（§7）无需同步；真要同步就按 §4 重拷一次，并记得重载窗口（`Ctrl+R`）。

