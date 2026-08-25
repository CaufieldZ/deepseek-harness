# Agent Note：VSCode webview 面板启动

Status: implemented

[English](2026-08-25-vscode-webview-panel-boot.md) | 中文

## 问题

扩展宿主经 MessagePort 载体中继 harness API，但 webview 需要完整的交互式客户端应用——装配后的插件图、bundle 传输、启动协议、按面板的会话深链——而且必须在没有 HTTP 的条件下工作：webview 的 origin 永远过不了 /api 信任栅栏，CSP 必须保持 `connect-src 'none'`。

## 决策

每个会话面板渲染一份 HTML 文档，复刻已部署 web 应用的启动协议：内联队列 facade（`bootInjections`）、`__DSH_BOOT__` 图、深链全局变量，然后按图序为每个精选 bundle 放一个阻塞式经典 `<script>`。因为所有 bundle 都已预注册，模块系统从不按需拉取——`loadBundle` 保持缺失，按需路径（对着 webview URI 注入 script 元素）不可达；这正是 assembled snapshot 所钉住的不可变量。bundle 集精选为 22 项（`CURATED_CLIENT_IDS` 加扩展自带的 shell bundle，由 `webview/build.ts` 构建为 closure-factory 格式）：完整客户端 UI 去掉纯 web 表面——侧边栏由活动栏会话树替代，`ui-trajectory` 保留，因为它拥有 `conversation.view` 槽位。webview 传输把 `__DSH_TRANSPORT__` 设为 MessagePort 客户端；connection 插件的 `?fixture` URL 模式仍然优先，给快照车道一个免 key 的浏览器内宿主。按面板的会话深链走宿主注入的 `__DSH_SESSION_ID__` 全局变量（webview URL 没有查询串），shell 插件在调用 `open` 之前先从会话列表退订——`open` 同步变更列表 store，仍订阅着的监听器会永久重入。窗口重载后的面板恢复重新应用 webview options，并从 webview 持久化状态（`acquireVsCodeApi().setState`）重读会话 id。

## 备选方案

**直接内置完整 web bundle 集（37 个包）。** 本里程碑拒绝：侧边栏与纯 web 设置表面让面板载荷翻倍，且与活动栏树重复；精选集只有一个文件（`CURATED_CLIENT_IDS`），条目缺失或服务未满足时 assembled snapshot 会响亮失败。

**给 webview 一个经 postMessage 的按需 `loadBundle` seam。** 拒绝：script 标签预加载正是已部署应用模块系统已有的保证，CSP 因而无需 bundle 拉取通道，且全预加载不可变量可被快照测试。

**用 `location.search` 做会话深链。** 拒绝：webview 文档 URL 没有查询串，会话 id 必须作为注入全局变量送达。

## 影响

面板 HTML 是纯函数（`buildPanelHtml`），带严格 CSP（`default-src 'none'`、script nonce、`connect-src 'none'`，保留内联样式以支持运行时注入的 `<style>` 标签）——单测覆盖 nonce 覆盖、转义与注入顺序。`ui-trajectory` 的虚拟化让 DOM 窗口保持很小，因此快照断言针对行存在性而非靠前的轮次。根 `pnpm run build` 现在产出 `webview-dist/`（织入为 `build:vscode-webview`），快照车道与 F5 流程都依赖它。后续变更将加入 diff 应用/接受、Automode 与 `vscode` IDE 上下文 profile。
