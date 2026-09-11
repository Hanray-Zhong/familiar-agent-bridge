# 桌面应用与打包

[开发手册目录](README.md) · [用户手册](../user-manual/README.md)

## 桌面隔离

主进程启动 Bridge；renderer 禁用 Node，并启用 sandbox、contextIsolation。IPC 校验窗口、主 frame 和精确 UI URL，拒绝导航、新窗口和任意文件操作。

桌面独立数据放在操作系统的应用数据目录。开发版默认使用 `data/desktop/`；可仅为开发设置 `FAMILIAR_BRIDGE_APP_DATA`。预览端口默认 `3361`，可用 `FAMILIAR_BRIDGE_PREVIEW_PORT` 修改。这两项不是用户 Bridge 配置。

项目和应用分别命名为 `familiar-agent-bridge`、Familiar Agent Bridge。安装版在新目录没有 `settings.json`、旧目录存在该配置时复用旧 Familiar Codex Bridge 目录，空缓存目录不阻止恢复。Foundry 的持久化模块 ID 保持 `familiar-codex-bridge`，只更新显示名称和安装包文件名。

旧版数据接管是保留的兼容入口：只在用户选择旧项目时读取其 `.env`，复用状态与锁，不复制配对密钥。正常启动仅加载桌面 `settings.json`，不自动读取 `.env` 或进程中的 Bridge 配置。旧 `STDIN_PLAYER` 自动映射到 `TEST_PLAYER`，下次保存才更新磁盘。关闭应用时等待 Bridge 与所有子进程退出；最小化保持运行。

## 运行日志与 AI 回答

运行日志提供“系统日志”和“AI 回答”两个标签页，默认显示系统日志。标签支持点击、左右方向键和 Home / End；状态刷新保留当前选择。当前页内容变化后自动滚动到底部，展开日志、切换标签或切回控制台时也定位最新记录。另一页的更新和无新内容的状态刷新不改变当前阅读位置。只滚动日志区域，不移动整个页面。

系统日志保留原有级别过滤和最近 300 条上限。AI 回答通过 `src/runtime/responses/collector.mjs` 从玩家 Turn 的完整 Item 收集：`agentMessage` 的最终回答，以及 Familiar `send-chat-message` 成功回执对应的 `arguments.content`。未标记阶段的旧模型文本兼容展示；思考过程、进度说明、健康检查和失败的聊天发送不进入回答页。Item 通知和 Turn 汇总按 Item ID 去重；后续 Turn 失败不抹掉已收到的回答，也不改变原来的 `uncertain` 判定。

Bridge 的 `response` 事件经 DesktopSession 回调进入 DesktopController 的独立 `aiResponses` 缓冲，随已有 `snapshot` IPC 返回。最近 100 条回答保留来源、玩家、请求和 Thread ID；正文脱敏并保留换行，超过 64000 字符时明确标记截断。回答不受 `LOG_LEVEL` 过滤，只保存在本次应用内存中，停止 Bridge 后仍可查看。renderer 使用 `textContent` 显示正文，HTML 和 Markdown 均作为文本展示。

`test/desktop-log-scroll.test.mjs` 覆盖双标签选择、独立刷新、滚动和键盘操作。`test/response-collector.test.mjs`、Bridge 与桌面会话 / 控制器测试覆盖回答来源、去重、脱敏、失败保留、级别隔离和容量。演示预览的手工请求会生成明确标注“演示”的两种回答，不能作为真实游戏验证。

## Foundry ZIP

`src/foundry/module-package.mjs` 从 `module.json` 的入口收集静态相对依赖，打包为带 `familiar-codex-bridge/` 顶层目录的 ZIP。版本来自模块清单。新增资源类型或动态加载文件时，要扩展收集逻辑并增加解压测试，不能直接扫描整个项目打包。

ZIP 使用 Node 原生 Deflate，不依赖系统压缩命令或新增 npm 包。文件排序与时间固定，同一份输入可重复生成相同文件。打包拒绝越界路径和符号链接，限制单文件 4 MiB、总计 16 MiB 和 256 个文件。

开发打包命令默认输出到 `dist/foundry/`。桌面通过原生保存对话框选择输出位置，取消不写文件；renderer 不能提交任意写入路径。导出只创建 ZIP，不检测或更新本机 Foundry 目录。

模块目录和清单规范见 [Foundry 官方模块开发说明](https://foundryvtt.com/article/module-development/)。当前不生成虚构的在线 manifest/download 地址；如需在线分发，应先准备真实托管地址。

## macOS 应用

`electron-builder.json` 维护文件白名单。准备脚本复制 `agents/dm/`、`foundry-module/` 和 `docs/user-manual/` 到 `build/bridge-resources/`，保留相对目录，再作为 extraResources 打包。`docs/development/` 不进入安装包。

桌面“打开完整用户手册”从资源目录的 `docs/user-manual/README.md` 打开文档。移动文档时要同时更新此入口、准备脚本与安装包检查。

不要让 extraResources 直接引用 `foundry-module/`：electron-builder 可能把核心依赖的共享协议从 ASAR 排除。包检查必须核对所有相对 import、资源和当前源码。

安装包不包含 `.env`、data、开发文档或根 AGENTS.md。当前使用本地 ad-hoc 签名，未做 Developer ID 签名和 Apple 公证；不自动发布。
