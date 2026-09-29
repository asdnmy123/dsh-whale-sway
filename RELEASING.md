# 发版清单

本文件是发版的唯一权威步骤表。其中可离线判定的部分由 `node tools/check-release.mjs` 在 CI 里强制校验：**pin 版本、tarball 文件名、仓库 URL、离线测试计数**的一致性。任何一项忘了同步，CI 就红。

## 1. 升版本并同步文档

- 改 `package.json` 的 `version`。
- 同步 `README.md` 里所有复制了版本号的地方：
  - 安装段的 pin：`github:asdnmy123/dsh-whale-sway#vX.Y.Z`（标题处 + spec 对照表）；
  - 离线安装的 tarball 文件名：`dsh-whale-sway-X.Y.Z.tgz`；
  - 质量验证表里「离线测试 `tools/test-motion.mjs`」的 `N / N` 计数（等于 `tools/test-motion.mjs` 中 `test(` 的出现次数）。
- 帧带或运动规格变了，就一并同步「运动规格」表与正文数字。
- 改了安装或兼容性行为，同步「安装」「兼容性与降级」两节。

## 2. 本地跑完与 CI 同一套链

```powershell
node tools/build-frames.mjs
git diff --exit-code -- preview/frames-sheet.png preview/frames-contact-sheet.png tools/generated/frames.json
node tools/sync-sheet.mjs --check
node tools/test-motion.mjs
node tools/verify-frames.mjs
node tools/verify-motion.mjs
node tools/make-gif.mjs
node tools/check-pack.mjs
node tools/check-release.mjs
```

九条全绿才继续。

## 3. 提交并推送

```powershell
git add -A
git commit -m "release: vX.Y.Z"
git push origin main
```

等 CI 跑完（`gh run watch`），结论必须是 success。

## 4. 打标签

```powershell
git tag -a vX.Y.Z -m "vX.Y.Z — <一句话说明>"
git push origin vX.Y.Z
```

**标签一旦对外发布就不再移动。** v0.2.0 在首次 Release 之前移动过两次（补齐打包边界与安装文档），此后任何修正都走新版本号，不改已发布的标签。

## 5. 打包并挂到 GitHub Release

内网、墙内、无 git 的用户靠这个产物安装，所以 tarball 必须随 Release 一起发布：

```powershell
npm pack
gh release create vX.Y.Z ./dsh-whale-sway-X.Y.Z.tgz --title "vX.Y.Z" --notes-file RELEASE_NOTES.md
```

Release 说明至少覆盖四点：一条命令安装、运行机制（逐帧组合、运行时零旋转）、发布包边界（只含运行时文件）、离线安装方式。

## 6. 验证发布产物（必做，不许跳）

```powershell
gh release download vX.Y.Z --pattern "*.tgz" --dir .edge-tmp/rel
dsh plugin --profile scratch-verify add ./.edge-tmp/rel/dsh-whale-sway-X.Y.Z.tgz
dsh --profile scratch-verify --dump-config | Select-String dsh-whale-sway
```

`--dump-config` 必须出现 `# == dsh-whale-sway` 层。验证完删除 `scratch-verify` 这个临时 profile。

## 7. 可选：发布到 npm

```powershell
npm publish
```

发布成功后，README 的安装可缩短为 `dsh plugin --profile <profile> add dsh-whale-sway`；把这一行也纳入第 1 步的同步项。
