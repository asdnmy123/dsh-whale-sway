# dsh-whale-sway

[![CI](https://github.com/asdnmy123/dsh-whale-sway/actions/workflows/ci.yml/badge.svg)](https://github.com/asdnmy123/dsh-whale-sway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#)

> 让 DSH 运行状态行那个鲸尾真正摆起来：**逐帧画面组合、零旋转**，摆动快慢跟随实时 tok/s。
> Frame-by-frame whale-tail sway for the DeepSeek Harness running indicator, driven by the live token rate — no transform, no rotation.

| 快速吐字（约 47 tok/s） | 空闲 / 等工具（约 7 tok/s） |
| --- | --- |
| ![fast](preview/sway-fast.gif) | ![slow](preview/sway-slow.gif) |

## 它是怎么摆的

运行状态行（`深度求索中，用时 N 秒 ···`）左边那枚鲸尾，原版是一张把时序烤进图里的 base64 APNG 当 CSS mask 用——**样式表改不动它的速度**。本插件把它换成一条**预先画好的帧带**：

1. **用你自己的素材**：`preview/2C42C558D17C2745D1D47ED3DE000BD2.gif`（360×360、24 帧、20ms/帧）被零依赖解码成 24 张 RGBA 帧。
2. **去白底**：按墨色亮度反解 alpha —— `a = clamp((255 − L) / (255 − 92), 0, 1)`，再做一点点对比清理。纯白像素的 alpha 是 **0**，白底彻底消失，于是图标可以用 shell 自己的 `currentColor` 上色，深色模式自动跟随。
3. **拼成帧带**：24 个方格纵向排成一张 PNG（`preview/frames-sheet.png`），base64 内联进 `client.js`。
4. **运行时只写一个整数**：把 `--dsh-whale-frame` 设成 `0..23` 的**整数值**，`mask-position` 按整格滑动，把那一格露出来。

**全程没有任何 `transform` / `rotate` / `translate` / `matrix`。** 摆动是"换画"，不是"转画"——帧与帧之间不插值，不扭曲，不整体旋转。

```css
mask-size:     100% 2400%;                                   /* 一格宽，24 格高 */
mask-position: 0 calc(var(--dsh-whale-frame, 0) / 23 * 100%); /* 整格跳 */
```

## 速度怎么跟 tok/s 挂钩

客户端 API 拿不到 token 计数（客户端事件只有 4 个），所以按你**感知到**的速率测量：会话每秒新增的字符数 ÷ 每 token 字符数，再做 EMA 平滑。它与真实 tok/s 单调相关。

| tok/s | 一整个摆动周期 | 观感 |
| --- | --- | --- |
| 0（等工具） | 1500 ms | 慢悠悠地晃 |
| 9 | 750 ms | 明显在摆 |
| 45 | 250 ms | 飞快 |
| ≥160 | 190 ms | 拉满 |

周期公式：`clamp(1500 / (1 + rate / 9), 190, 1500)` ms。相位是**积分**出来的（`phase += dt / period`），所以速率变化时是连续加速，不会像切 `animation-duration` 那样跳帧重启。

## 幅度：用素材原生的，不放大

下面的数字由**独立验证器**在交付的帧带上重算（显示像素 = 16px 画框 ÷ 305px 裁剪边长）：

| 实测 | 数值 |
| --- | --- |
| 尾鳍质心摆动跨度 | **3.20 px**（欧氏跨度 3.28 px） |
| 尾鳍单帧最大步进 / 绕一圈累计行程 | **0.63 px** / **6.83 px** |
| 根部（尾柄带）跨度 / 单帧最大步进 | **0.045 px** / **0.014 px** |
| 24 格在 32px 光栅下互异 | **24 / 24**（最小汉明距离 152） |
| 格子四边残留墨量 | **0**（24/24 格全为 0；裁剪留边 12 源像素） |

单帧最大步进只有 0.63px —— **每一步都落在一个像素以内**：帧是逐格硬切的，看上去却是连续的。根部那 0.045px 的微动是**素材自带的**：我们没做任何配准、冻结或"钉死"处理，也没有放大或缩小摆幅（独立复核：帧带与素材原始运动的比例 1.0117 ~ 1.0176，全部落在 ±15% 内）。插件只负责换帧——画成什么样，就是素材原本的样子。

## 安装

```powershell
# 在 DSH profile 目录里
pnpm add link:D:/dsh-plugins/dsh-icon
```

然后在 `cordis.yml` 的 loader 里加一条 `include:dsh-whale-sway`，刷新页面（或重启 DSH）即可。插件包内已带 `cordis.patch.yml`，正常安装不需要手动改配置。

## 调参

`client.js` 顶部的 `TUNING`：

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `minPeriodMs` | 满速时一个周期 | `190` |
| `maxPeriodMs` | 空闲时一个周期 | `1500` |
| `rateRef` | 使周期减半的 tok/s | `9` |
| `charsPerToken` | 每 token 字符数（中文 1.7，英文可调到 4） | `1.7` |
| `sampleMs` | 采样窗口 | `200` |
| `smooth` | EMA 权重 | `0.4` |

摆幅**没有**旋钮：它就是素材里那 24 帧的幅度。想改幅度，改素材。

## 安全阀

- `@media (prefers-reduced-motion: no-preference)` —— 开了减少动效的用户保持原版静止图标。
- `@supports (mask-mode: alpha) and (mask-image: url(""))` —— 不支持 CSS mask 的浏览器保持原版渲染，不会变成一个实心方块。
- `FRAME_SHEET_BASE64` 为空（构建产物没拼进来）时**什么都不注入**，原版图标原样保留。
- JS 侧还有 `forced-colors: active` 门控与全程 `try/catch`：任何一步失败都退回原版，绝不打断对话流。

## 复现与验证

```powershell
node tools/build-frames.mjs      # 素材 GIF -> preview/frames-sheet.png + tools/generated/frames.json
node tools/sync-sheet.mjs        # 把帧带内联进 client.js（幂等）
node tools/test-motion.mjs       # 离线测试：纯数学、样式表、VM 里的换帧循环
node tools/verify-frames.mjs     # 独立复核：帧带确实来自素材、白底确实去掉、没有裁切
node tools/verify-motion.mjs     # 独立复核：运行时零 transform、只写整数帧号
node tools/make-gif.mjs          # 重新生成 README 这张动图（逐像素回读校验）
```

真实的引擎截图：[快流](preview/engine-fast.png) · [慢流](preview/engine-slow.png)。

## 和其他鲸鱼插件的区别

- `dsh-whale-animation` / `dsh-whale-pet` 等是**装饰性**的常驻动画。
- 这个是**遥测驱动**的：摆动速度是当前会话 tok/s 的函数，空闲就慢下来，吐字越快摆得越快。
- 而且摆动方式是**逐帧画面组合**，不是把一张矢量图整体 `rotate`。

## License

MIT © 2026 [asdnmy123](https://github.com/asdnmy123)
