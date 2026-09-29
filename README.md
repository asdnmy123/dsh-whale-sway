# dsh-whale-sway

[![CI](https://github.com/asdnmy123/dsh-whale-sway/actions/workflows/ci.yml/badge.svg)](https://github.com/asdnmy123/dsh-whale-sway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#)

**为 DeepSeek Harness 运行状态行提供帧序列驱动的鲸尾动画：摆动速度实时跟随模型 token 输出速率。**

> A frame-composed whale-tail sway for the DeepSeek Harness running indicator, driven by the live token rate.

| 高速输出（约 47 tok/s） | 空闲等待（约 7 tok/s） |
| --- | --- |
| ![高速输出](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/sway-fast.gif) | ![空闲等待](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/sway-slow.gif) |

## 概述

DeepSeek Harness 运行状态行（`深度求索中，用时 N 秒 ···`）左侧的鲸尾，出厂实现为一枚内嵌 APNG 遮罩：其播放时序固化在图像数据内部，样式表无法干预其速度与幅度。

`dsh-whale-sway` 将该指示图标替换为一条**预渲染帧带**，把动画明确拆分为「离线生成帧序列」与「运行时逐帧呈现」两个阶段。运行时不对图形做任何形变、位移或旋转，仅依据当前吞吐量选择应显示的整帧画面。

## 特性

- **帧序列驱动** —— 摆动由 24 张预渲染画面逐帧切换构成，帧间不做插值或形变。
- **零变换** —— 输出样式表不包含 `transform`、`rotate`、`translate`、`matrix`、`scale` 等任何变换声明，动画完全由遮罩位移实现。
- **速率自适应** —— 摆动周期由会话实时吞吐量决定，空闲放慢、高速加快；相位以积分方式推进，速率变化表现为连续加速，而非时间轴重启造成的跳变。
- **原生幅度** —— 摆幅完整取自帧序列素材的原始运动，不做放大或缩小。
- **主题自适应** —— 图标以 `currentColor` 绘制，自动适配明暗主题与强调色。
- **静默降级** —— 任一环节异常时保持 Harness 原有渲染，不干扰会话内容。

## 工作原理

1. **帧提取** —— 构建期以零依赖解码器提取素材的 24 张 RGBA 画面。
2. **背景剔除** —— 按墨色亮度反解笔画覆盖度，纯白背景 alpha 归零，仅保留笔画覆盖：

   `a = clamp((clamp((255 − L) / (255 − 92), 0, 1) − 0.02) / 0.96, 0, 1)`

3. **帧带封装** —— 24 格方形画面纵向拼合为单张 PNG，以 base64 内联于客户端模块（14,156 字符）。
4. **逐帧呈现** —— 运行时仅写入一个整数自定义属性，遮罩按整格位移显示对应画面。

```css
/* 每个动画帧只改变一个整数，不产生任何变换 */
mask-size:     100% 2400%;                                     /* 一格宽，24 格高 */
mask-position: 0 calc(var(--dsh-whale-frame, 0) / 23 * 100%);   /* 整格位移 */
```

帧索引由相位积分得出：`phase += dt / period(rate)`，`index = ⌊phase × 24⌋`。

## 速率映射

客户端插件 API 不提供 token 计数（客户端事件目录仅含连接、语言、插槽、主题四类），因此速率以可感知的等价量测量：会话文本每秒新增字符数除以每 token 字符数，并经指数移动平均平滑。该指标与真实 tok/s 单调相关。

| 吞吐量 | 摆动周期 | 表现 |
| --- | --- | --- |
| 0 tok/s（等待工具） | 1500 ms | 缓慢摆动 |
| 9 tok/s | 750 ms | 明显摆动 |
| 45 tok/s | 250 ms | 快速摆动 |
| ≥ 160 tok/s | 190 ms | 达到周期下限 |

周期公式：`clamp(1500 / (1 + rate / 9), 190, 1500)` ms。

## 运动规格

以下数据由独立验证器在交付的帧带上重算，长度单位为 CSS 显示像素（16 px 画框 ÷ 305 px 裁剪边长）：

| 指标 | 数值 |
| --- | --- |
| 尾鳍质心摆动跨度 | 3.20 px（欧氏跨度 3.28 px） |
| 尾鳍单帧最大步进 | 0.63 px |
| 尾鳍单周期累计行程 | 6.83 px |
| 根部（尾柄带）跨度 / 单帧步进 | 0.045 px / 0.014 px |
| 帧序列互异度 | 24 / 24（最小汉明距离 152） |
| 帧格四边残留覆盖 | 0（24 / 24） |
| 裁剪安全留边 | ≥ 12 源像素 |
| 笔画显示宽度 | 0.885 px（出厂图标 0.875 px） |

单帧最大步进为 0.63 px，即每帧位移均落在一个像素以内，逐格切换在视觉上呈现为连续运动。根部 0.045 px 的跨度源自帧序列自身的原始运动；构建期未做配准、冻结或幅度归一化（帧带与源素材的运动比值为 1.0117 ~ 1.0176，处于 ±15% 容差内）。

## 安装

一条指令完成（无需克隆仓库、无需编辑任何配置、无需构建）：

```powershell
dsh plugin --profile desktop add github:asdnmy123/dsh-whale-sway#v0.2.0
```

`--profile` 填要装入的 profile 名（桌面版为 `desktop`）。该命令把本包登记为该 profile 的依赖，并把本插件追加进 `dsh.profile.bundles`；profile 不存在时自动初始化。执行后刷新页面或重启 DSH 即生效。

卸载同样一条指令：`dsh plugin --profile desktop remove dsh-whale-sway`。

| 目的 | 把 spec 换成 |
| --- | --- |
| 固定版本（推荐，供应链安全） | `github:asdnmy123/dsh-whale-sway#v0.2.0` |
| 跟随 `main` 最新提交 | `github:asdnmy123/dsh-whale-sway` |
| 装本地检出（改完即生效，开发用） | `link:D:/dsh-plugins/dsh-icon` |

图形界面：设置 → 插件 页面可启用、停用、卸载已安装的 bundle；安装新的 spec 用上面那条命令，或在会话中直接要求执行。

本包随仓库即产物：`client.js` 已内联帧带与样式表，包内没有 `prepare`/`build` 脚本，因此 git 安装不需要任何 pnpm 构建许可，安装期也不会执行包内代码（实测无提示、无 allowlist）。若本包发布到 npm 注册表，命令可再缩短为 `dsh plugin --profile desktop add dsh-whale-sway`。

## 配置

`client.js` 顶部的 `TUNING`：

| 键 | 含义 | 默认值 |
| --- | --- | --- |
| `minPeriodMs` | 周期下限（满速） | `190` |
| `maxPeriodMs` | 周期上限（空闲） | `1500` |
| `rateRef` | 使周期减半的 tok/s | `9` |
| `charsPerToken` | 每 token 字符数（中文 1.7，英文约 4） | `1.7` |
| `sampleMs` | 采样窗口 | `200` |
| `smooth` | EMA 权重 | `0.4` |

摆幅不提供运行时参数：其数值即帧序列的原始幅度。

## 兼容性与降级

- `@media (prefers-reduced-motion: no-preference)` —— 启用「减少动效」的环境保持出厂静止图标。
- `@supports (mask-mode: alpha) and (mask-image: url(""))` —— 不支持 CSS 遮罩的浏览器保持出厂渲染，不会出现实心色块。
- 帧带未内联时（构建产物缺失）不注入任何规则，出厂图标原样保留。
- 运行时另设 `forced-colors: active` 限流；全流程 `try/catch`，任一异常均回退出厂渲染。

## 构建与复现

帧带由构建期生成，输入为随仓库提供的帧序列素材 `preview/2C42C558D17C2745D1D47ED3DE000BD2.gif`（GIF89a，360×360，24 帧，20 ms/帧，白色背景，墨色 `#345ebb`）。

```powershell
node tools/build-frames.mjs      # 素材 -> preview/frames-sheet.png + tools/generated/frames.json
node tools/sync-sheet.mjs        # 将帧带内联至 client.js（幂等；--check 供 CI 使用）
node tools/test-motion.mjs       # 离线测试：运动数学、样式表、VM 内的换帧循环
node tools/verify-frames.mjs     # 独立复核：帧带来源、背景剔除、裁剪与幅度
node tools/verify-motion.mjs     # 独立复核：零变换、整数帧号、速率缩放
node tools/make-gif.mjs          # 重新生成预览动图（逐像素回读校验）
node tools/engine-shot.mjs       # 真实渲染引擎截图
node tools/check-pack.mjs        # 校验发布包只含运行时文件（执行真实 npm pack）
```

构建为确定性过程：重复执行产出逐字节一致，CI 通过重新生成并比对持续校验。真实引擎截图：[高速输出](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/engine-fast.png) · [空闲等待](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/engine-slow.png)。

**发布包边界**：npm 包只含运行时文件（`index.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`）；`tools/`（构建与验证脚本）与 `preview/`（素材与预览图）仅存在于仓库，由 CI 使用，不进入发布包。`client.js` 已内联帧带与样式表，运行时不读取仓库内任何文件。

## 质量验证

| 检查 | 结果 |
| --- | --- |
| 离线测试 `tools/test-motion.mjs` | 21 / 21 通过 |
| 帧序列独立验证 `tools/verify-frames.mjs` | 8 / 8 通过（确定性检查 9 / 9） |
| 运行时独立验证 `tools/verify-motion.mjs` | 7 / 7 通过 |
| 发布包边界 `tools/check-pack.mjs` | 通过（真实 `npm pack`：仅 6 个运行时文件） |
| 持续集成（ubuntu，Node 20） | 全部通过 |

两个独立验证器均自带解码与重采样实现，并通过注入缺陷（变换声明、小数帧号、属性未清理、空帧带、错序帧、白底板、过小裁剪、错误素材路径与摘要）确认其检查确实会失败。

## 与其他鲸鱼插件的区别

- `dsh-whale-animation`、`dsh-whale-pet` 等为装饰性常驻动画。
- 本插件为遥测驱动：摆动速度是当前会话吞吐量的函数。
- 运动方式为帧序列组合，而非对单一矢量图形整体旋转。

## License

MIT © 2026 [asdnmy123](https://github.com/asdnmy123)
