# dsh-whale-sway

[![CI](https://github.com/asdnmy123/dsh-whale-sway/actions/workflows/ci.yml/badge.svg)](https://github.com/asdnmy123/dsh-whale-sway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#)

**为 DeepSeek Harness 运行状态行提供帧序列驱动的鲸尾动画：摆动速度实时跟随模型 token 输出速率。**

> A frame-composed whale-tail sway for the DeepSeek Harness running indicator, driven by the live token rate.

仓库随附三种摆动素材，各自从一张 24 帧手绘 GIF 预处理而来，运行时按整帧切换：

| 原始幅度 · `sway` | 小幅 · `sway-gentle` | 大幅 · `sway-vivid` |
| --- | --- | --- |
| ![原始幅度](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/sway-preview.gif) | ![小幅](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/sway-gentle-preview.gif) | ![大幅](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/sway-vivid-preview.gif) |

同一素材的两种速度（速率映射实拍）——摆动节奏由实时 tok/s 决定，与上表的幅度选择相互独立：

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

周期公式：`clamp(maxPeriodMs / (1 + rate / rateRef), minPeriodMs, maxPeriodMs)` ms。上表为出厂默认值，公式中的四个量与取样参数都可在插件配置界面按部署调整。

## 运动规格

以下数据由构建报告与独立验证器在交付的帧带上重算，长度单位为 CSS 显示像素（16 px 画框 ÷ 该模式自己的裁剪边长）：

| 指标 | `sway`（305 px 裁剪） | `sway-gentle`（239 px） | `sway-vivid`（282 px） |
| --- | --- | --- | --- |
| 素材 SHA-256（前 8） | `0583b5c6` | `46b2d977` | `ce8603ad` |
| 尾鳍质心单周期累计行程 | 6.83 px | 3.69 px | 4.45 px |
| 尾鳍质心最大位移 | 2.28 px | 0.63 px | 1.46 px |
| 根部（尾柄带）质心最大漂移 | 0.032 px | 0.039 px | 1.49 px |
| 互异帧数（32 px 栅格） | 24 / 24 | 12 / 24 | 13 / 24 |
| 帧格四边残留覆盖 | 0（24 / 24） | 0（24 / 24） | 0（24 / 24） |
| 裁剪安全留边 | 12 源像素 | 12 源像素 | 12 源像素 |
| 单帧最大质心步进 | 0.63 px | 0.13 px | 0.42 px |

`sway` 的单帧最大步进为 0.63 px，即每帧位移均落在一个像素以内，逐格切换在视觉上呈现为连续运动。根部漂移源自帧序列自身的原始运动；构建期未做配准、冻结或幅度归一化（帧带与源素材的运动比值为 1.0117 ~ 1.0176，处于 ±15% 容差内）。

`sway-gentle` 与 `sway-vivid` 的素材是**往返摆动**：后 12 帧是前 12 帧的镜像回放，因此 24 帧在 32 px 栅格上只有 12（或 13）个互异画面，运行时仍逐格播放全部 24 格。这是素材本身的时长结构，构建期原样保留，只在 `tools/modes.mjs` 的 `expectDistinct` 中记录真值，并由 `tools/verify-frames.mjs` 逐模式核对。

## 安装

一条指令完成（无需克隆仓库、无需编辑任何配置、无需构建）：

```powershell
dsh plugin --profile desktop add github:asdnmy123/dsh-whale-sway#v0.3.0
```

`--profile` 不是固定值：桌面版是 `desktop`，其他组合（`web`、`tui`、自建 profile）换成对应名称即可。该命令把本包登记为该 profile 的依赖，并把本插件追加进 `dsh.profile.bundles`；profile 不存在时自动初始化。执行后刷新页面或重启 DSH 即生效。

卸载同样一条指令：`dsh plugin --profile desktop remove dsh-whale-sway`。

| 目的 | 把 spec 换成 |
| --- | --- |
| 固定版本（推荐，供应链安全） | `github:asdnmy123/dsh-whale-sway#v0.3.0` |
| 跟随 `main` 最新提交 | `github:asdnmy123/dsh-whale-sway` |
| 装本地检出（改完即生效，开发用） | `link:<本目录绝对路径>`（例 `link:D:/path/to/dsh-whale-sway`、`link:/home/you/dsh-whale-sway`） |
| 无网络 / 内网环境 | `./dsh-whale-sway-0.3.0.tgz`（`npm pack` 产物约 75.4 KiB，在调用目录解析相对路径，不经过 git，也不需要访问 GitHub） |

图形界面：设置 → 插件 页面可启用、停用、卸载已安装的 bundle；安装新的 spec 用上面那条命令，或在会话中直接要求执行。

本包随仓库即产物：`client.js` 已内联帧带与样式表，包内没有 `prepare`/`build` 脚本，因此 git 安装不需要任何 pnpm 构建许可，安装期也不会执行包内代码（实测无提示、无 allowlist）。若本包发布到 npm 注册表，命令可再缩短为 `dsh plugin --profile desktop add dsh-whale-sway`。

## 插件配置界面

本插件在 DSH 的「设置 → 插件」页面提供配置界面。改动写入该 Loader 条目的 `config`，由 DSH 的 settings 域持久化到当前 profile 的 `cordis.patch.yml`，因此跨重启保留，并在保存后立即作用于正在运行的动画（`patchReload: live`）。

入口有两处，指向同一个表单：

- 插件 bundle 详情页（插件列表中的 `dsh-whale-sway` 卡片）内嵌的配置区；
- 该 bundle 下 `dsh-whale-sway` 条目页的配置区。

| 参数 | 含义 | 默认值 | 取值范围 |
| --- | --- | --- | --- |
| 摆动方式 | 动画使用的素材与摆幅：原生 / 轻摆 / 大摆 | `sway`（原生） | 三选一 |
| 启用动画 | 关闭后恢复出厂运行指示器画面 | 开启 | 开关 |
| 最快周期（毫秒） | 峰值速率下整轮摆动的时长 | `190` | 60 – 5000 |
| 最慢周期（毫秒） | 空闲或等待工具调用时的整轮时长 | `1500` | 120 – 10000 |
| 参考速率（tok/s） | 速率达到该值时整轮时长减半 | `9` | 1 – 400 |
| 速率上限（tok/s） | 估算速率的上限，避免批量重排把摆动拉到极端 | `160` | 1 – 100000 |
| 每 token 字符数 | 由文本增量估算 token 速率的换算系数 | `1.7` | 0.1 – 20 |
| 取样间隔（毫秒） | 两次文本长度观测之间的间隔 | `200` | 20 – 5000 |
| 平滑系数 | 每次新观测计入当前速率的权重 | `0.4` | 0.05 – 1 |

摆幅本身不是参数：三种摆动的幅度都是素材原生值，界面只选择使用哪一份素材。

页面的控件、校验、保存与「恢复默认」由 `@deepseek-ai/dsh-client-ui-primitives` 的共享设置表单渲染。参数表、取值范围与中英文文案集中在 `tools/settings.mjs`，由 `node tools/sync-settings.mjs` 同时写入 `index.js`（Host 侧 Config schema）与 `client.js`（界面与运行时取值），`--check` 在两者漂移时报错。

## 摆动方式的实现

三种素材同时内联在 `client.js` 的 `MODE_PANELS` 中。样式表只含**一条与模式无关**的遮罩规则，读三个自定义属性：帧带 `--dsh-whale-sheet`、格数 `--dsh-whale-cells`、帧内偏移 `--dsh-whale-pos`。运行时把当前模式的帧带与格数以**内联样式**写在图标元素上（内联优先于样式表），此后每个换帧只更新 `--dsh-whale-frame`（整数帧号）与 `--dsh-whale-pos`（百分比）。因此切换摆动方式不改样式表、不重采样、不重新布局，动画循环也不必知道模式的存在。样式表内联了缺省摆动（`sway`）的帧带，作为配置尚未读出时的首帧兜底。可用的模式 id 见 `tools/generated/manifest.json` 的 `modeIds`。

## 兼容性与降级

- `@media (prefers-reduced-motion: no-preference)` —— 启用「减少动效」的环境保持出厂静止图标。
- `@supports (mask-mode: alpha) and (mask-image: url(""))` —— 不支持 CSS 遮罩的浏览器保持出厂渲染，不会出现实心色块。
- 帧带未内联时（构建产物缺失）不注入任何规则，出厂图标原样保留。
- 运行时另设 `forced-colors: active` 限流；全流程 `try/catch`，任一异常均回退出厂渲染。
- **结构改名诊断（一次性）**：插件依赖三个 DSH 内部标记 —— 宿主 `data-chat-running`、图标类名后缀 `_runningIcon`、滚动容器 `data-conversation-scroll`。上游若改了其中任何一个，本插件会静默失效（出厂图标照常显示），因此每种失配都会在持续 1.5 秒后发出**一次** `console.warn`（不重复、不影响界面）：① 运行指示器在屏但内部找不到 `_runningIcon`；② 对话仍在增长却始终找不到 `data-chat-running` 宿主。空闲状态不会误报。

## 构建与复现

帧带由构建期生成，输入为随仓库提供的三张帧序列素材（均为 GIF89a、360×360、24 帧、30 ms/帧、白色背景、墨色 `#345ebb`）：`preview/sway.gif`、`preview/sway-gentle.gif`、`preview/sway-vivid.gif`。三者的素材身份（sha256）钉在 `tools/modes.mjs`，构建与独立验证都会在磁盘字节对不上时报错。

```powershell
node tools/build-assets.mjs      # 三种素材 -> 各自的帧带 / 接触版 / JSON + tools/generated/manifest.json
node tools/sync-sheet.mjs        # 将每种摆动的帧带内联至 client.js（幂等；--check 供 CI 使用）
node tools/build-assets.mjs --check  # 等价于「重新生成并比对」，CI 用于判定产物是否最新
node tools/sync-settings.mjs     # 将参数表同时写入 index.js 与 client.js（幂等；--check 供 CI 使用）
node tools/test-motion.mjs       # 离线测试：运动数学、模式无关样式表、配置契约与界面注册、VM 内的换帧循环、一次性诊断
node tools/verify-frames.mjs --mode sway          # 独立复核：帧带来源、背景剔除、裁剪与幅度
node tools/verify-frames.mjs --mode sway-gentle   # 其余两种摆动同样各自复核
node tools/verify-frames.mjs --mode sway-vivid
node tools/verify-motion.mjs     # 独立复核：零变换、整数帧号、速率缩放、三种帧带各自的字节一致性
node tools/verify-settings.mjs   # 独立复核：以部署自带的 DSH 设置域投影 Host Config，核对参数、默认值与校验（无部署时跳过）
node tools/make-gif.mjs          # 重新生成预览动图（逐像素回读校验）
node tools/engine-shot.mjs       # 真实渲染引擎截图
node tools/check-pack.mjs        # 校验发布包只含运行时文件（执行真实 npm pack）
node tools/check-release.mjs     # 发版一致性：pin 版本、tarball 名、仓库 URL、离线测试计数
```

构建为确定性过程：重复执行产出逐字节一致，CI 通过重新生成并比对持续校验。真实引擎截图：[高速输出](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/engine-fast.png) · [空闲等待](https://raw.githubusercontent.com/asdnmy123/dsh-whale-sway/main/preview/engine-slow.png)。

**发布包边界**：npm 包只含运行时文件（`index.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`）；`tools/`（构建与验证脚本）与 `preview/`（素材与预览图）仅存在于仓库，由 CI 使用，不进入发布包。`client.js` 已内联帧带与样式表，运行时不读取仓库内任何文件。

## 质量验证

| 检查 | 结果 |
| --- | --- |
| 离线测试 `tools/test-motion.mjs` | 29 / 29 通过 |
| 帧序列独立验证 `tools/verify-frames.mjs` | 8 / 8 通过（确定性检查 9 / 9） |
| 运行时独立验证 `tools/verify-motion.mjs` | 7 / 7 通过 |
| 设置页独立验证 `tools/verify-settings.mjs` | 通过（64 / 64；用部署自带的 `@deepseek-ai/dsh-settings` 投影 Host Config，无部署可解析时跳过） |
| 发布包边界 `tools/check-pack.mjs` | 通过（真实 `npm pack`：仅 6 个运行时文件） |
| 发版一致性 `tools/check-release.mjs` | 通过（pin 版本、tarball 名、仓库 URL、离线计数） |
| 持续集成（ubuntu，Node 20） | 10 步全部通过（设置域复核在无部署的环境按跳过处理） |

两个独立验证器均自带解码与重采样实现，并通过注入缺陷（变换声明、小数帧号、属性未清理、空帧带、错序帧、白底板、过小裁剪、错误素材路径与摘要）确认其检查确实会失败。

## 与其他鲸鱼插件的区别

- `dsh-whale-animation`、`dsh-whale-pet` 等为装饰性常驻动画。
- 本插件为遥测驱动：摆动速度是当前会话吞吐量的函数。
- 运动方式为帧序列组合，而非对单一矢量图形整体旋转。

## License

MIT © 2026 [asdnmy123](https://github.com/asdnmy123)
