# Agent Note：VSCode vsix 打包与打包冒烟测试

Status: implemented

[English](2026-08-25-vscode-vsix-packaging.md) | 中文

## 问题

扩展从源码运行（F5），但用户安装的是 vsix。打包后的扩展没有 node_modules，于是两个运行时假设被打破：tsdown 的 ESM 入口不是扩展宿主加载的 CJS 模块；`loadCuratedBundles` 经 `require.resolve` 解析 22 个客户端 bundle。工作区包名（`@deepseek-ai/dsh-vscode`）也违反 vsce 强制要求的扩展 manifest name 语法。

## 决策

`scripts/bundle.ts` 用 esbuild 把 tsc 产物（`lib/types/src/extension.js`）打成单个自包含 CJS 文件——`vscode` 是唯一的外部模块（由宿主注入），`import.meta.url` 被定义为 bundle 位置（manifest 的 `createRequire` 因此仍拿到真实路径），ws 的可选原生 require 留在其 try/catch 内（纯 JS 回退）。同一脚本把 22 个精选客户端 bundle 暂存到 `curated/<id>/client.js` 下，并写一份 `curated/manifest.json` 携带每个包的 `dsh.client` 元数据（inject/version/immediately），还把打包冒烟测试打成 `lib/e2e/smoke.cjs`。`loadCuratedBundles` 保持两层：开发时用 `require.resolve`，node_modules 缺失时用暂存副本 + 暂存元数据——解析失败落到暂存层，任何缺失都失败响亮。

`scripts/package.ts` 从暂存副本组装 vsix：vsce 校验 manifest，而工作区名在那里不合法，所以脚本在暂存 `package.json` 里把 `name` 改写为 `dsh-vscode`（工作区 manifest 保持 `@deepseek-ai/dsh-vscode`——工作区约束要求如此）。`package.json` 以空 `dependencies` 发布——扩展运行时所需的一切都在 `extension.cjs` 或暂存资产内——`files` 钉住载荷（`lib/extension.cjs`、`webview-dist`、`curated`、`media`、`README.md`），工作区约束的 `appPackageFiles` 表与之镜像。

打包冒烟（`scripts/smoke.ts` + `tests/e2e/smoke.ts`）经 `@vscode/test-electron` 在下载的 VS Code 构建内运行，包根放在开发路径上——宿主加载的正是打包入口（`lib/extension.cjs` 加暂存 curated 兜底）——并断言激活与命令面；vsix 本身经内容断言验证（`unzip -Z1` 必须列出打包入口、暂存 curated manifest 与 webview 构建）。两个环境事实塑造了它：下载固定 `1.100.0`（engines 下限；较新的 stable macOS 构建把 Electron 入口换成了启动器），且测试宿主经应用自带的 CLI shim（`Resources/app/bin/code`）运行——因为 macOS 上 Electron 二进制拒绝所有 VS Code CLI 旗标，包括 `--install-extension`，所以安装用断言验证而非宿主侧执行。CI 新增专职 `vscode-package` job——typecheck、webview 构建、bundle、打包、冒烟、vsix artifact——并入 `all-checks-passed` 裁决。

## 备选方案

**把 `node_modules` 装进 vsix。** 拒绝：vsce 经包管理器解析生产依赖，`workspace:^` 协议依赖没有可安装的 registry 版本；bundle 移除了整类问题。

**把工作区包改名为合法扩展名。** 拒绝：工作区约束要求 app 包带 `@deepseek-ai/` 前缀，monorepo 的约束与夹具也引用该名。

**冒烟用最新 stable VS Code。** 拒绝：当前 stable 的 macOS 启动器拒绝 `--install-extension`/测试宿主旗标；固定 engines 下限是确定性的且匹配受支持的最低版本。

## 后果

`pnpm --filter @deepseek-ai/dsh-vscode run build:bundle && pnpm --dir apps/vscode exec tsx scripts/package.ts` 产出 `apps/vscode/dsh-vscode-<version>.vsix`，可经 `code --install-extension` 安装。bundle 在扩展内复制了客户端包的代码（约 770KB）而非共享存储；暂存 bundle 只在 `build:bundle` 时刷新，因此 dev 面板读 node_modules、打包面板读暂存副本——两层解析让各自生命周期内都保持新鲜。后续工作：把暂存 manifest 与 bundle 构建版本化；用 `vsce ls` 输出驱动冒烟而非重新列举。
