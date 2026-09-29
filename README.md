# dsh-whale-sway

[![CI](https://github.com/asdnmy123/dsh-whale-sway/actions/workflows/ci.yml/badge.svg)](https://github.com/asdnmy123/dsh-whale-sway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#)

> DSH「深度求索中」状态行左边那枚鲸尾，会**跟着模型的吐字速度摆尾巴**。
> The whale tail in DSH's running indicator wags as fast as the model generates.

| 高速吐字 · 约 47 tok/s | 空闲 / 等工具 · 约 7 tok/s |
|---|---|
| ![快速摆动](preview/sway-fast.gif) | ![慢速摆动](preview/sway-slow.gif) |
| 周期 241 ms · 摆幅 ±23° | 周期 839 ms · 摆幅 ±16.3° |

原版是烘焙在 APNG 里的固定循环：幅度小、节奏固定，而且 **CSS 改不了 APNG 的播放速率**。这个插件只接管**运动**——图形一点没改，还是同一条 `REST_PATH`、同样的描边与 `currentColor`。

## 映射

| tok/s | 周期 | 半幅 |
|---|---|---|
| 0（空闲 / 等工具） | 1500 ms | ±15° |
| 9 | 750 ms | ±16.6° |
| 20 | 466 ms | ±18.6° |
| 45 及以上 | 190 ms | ±23° |

## 安装

```powershell
dsh plugin --profile <你的 profile> add dsh-whale-sway
```

也可以在 **Web UI → 设置 → 插件** 里安装。装完**刷新页面**（若你的 DSH 版本在启动时构建客户端模块表，则重启 DSH）。

## 调参

改 [client.js](client.js) 顶部的 `TUNING`，刷新即生效：

| 字段 | 作用 | 默认 |
|---|---|---|
| `amplitudeDeg` / `amplitudeGainDeg` | 空闲摆幅 / 高速时额外增加的摆幅 | `15` / `8` |
| `minPeriodMs` / `maxPeriodMs` | 最快 / 最慢周期 | `190` / `1500` |
| `rateRef` | 使周期减半的 tok/s | `9` |
| `charsPerToken` | 每 token 字符数（中文 1.7，英文可调到 4） | `1.7` |
| `liftPx` | 纵向点头幅度，`0` 关闭 | `0.6` |

## 设计要点

- **为什么不用 CSS keyframes**：原版动画帧烘焙在 APNG 里，帧率由浏览器决定，CSS 缩放不了；而且 `animation-duration` 一变就会重置相位。这里隐藏原版 mask，用同一条路径重画 `::after` mask，由 `requestAnimationFrame` **积分相位**驱动——速度变化是连续加速，永不跳相位。
- **速率从哪来**：客户端插件 API 拿不到 token 计数（客户端事件只有 4 个，`sessions.binding()` 需要拿不到的 session id），所以按「用户感知」测量——会话每秒新增字符数 ÷ `charsPerToken`。它与真实 tok/s 单调相关。
- **失效安全**：不支持 CSS mask、`prefers-reduced-motion`、强制颜色模式下，原版渲染原样保留。0 依赖、无构建、单个 client 文件。
- **边界**：速率是字符率折算值；多会话共享同一相位；满幅时鳍尖会超出图标盒约 1.5px，已放开 `contain` / `overflow` 让它自然探出。

## 和别的鲸鱼插件有什么不同

同类插件大多是**固定循环**（换素材、换帧序列、换时长），动画本身和模型在干什么无关。这个把摆动**接进了遥测**。

## 验证

```powershell
node tools/test-motion.mjs   # 14 项离线测试：加载契约、速率映射、速率估计、样式生成、生命周期
node tools/make-gif.mjs      # 重渲染上面两个 GIF（内置 GIF 解码回读，逐像素校验）
```

真实 Chromium 引擎里的截图（带页面自身的读数）：[快流](preview/engine-fast.png) · [慢流](preview/engine-slow.png)

## License

MIT
