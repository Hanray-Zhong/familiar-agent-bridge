# 桌面应用与打包

[开发手册目录](README.md) · [用户手册](../user-manual/README.md)

## 桌面隔离

主进程启动 Bridge；renderer 禁用 Node，并启用 sandbox、contextIsolation。IPC 校验窗口、主 frame 和精确 UI URL，拒绝导航、新窗口和任意文件操作。

主进程入口先设置数据目录、获取单实例锁，再通过 `app.whenReady().then(...)` 初始化配置与窗口。不能在入口模块顶层 `await app.whenReady()`：Electron 等 ES Module 完成求值后才触发 `ready`，两边等待会导致进程常驻却没有窗口。异步初始化失败沿用错误对话框和关闭流程。加载页面并显示窗口后，终端输出“桌面窗口已打开”。ESM 时序见 [Electron 官方说明](https://www.electronjs.org/docs/latest/tutorial/esm)。

桌面独立数据放在操作系统的应用数据目录。开发版默认使用 `data/desktop/`；可仅为开发设置 `FAMILIAR_BRIDGE_APP_DATA`。预览端口默认 `3361`，可用 `FAMILIAR_BRIDGE_PREVIEW_PORT` 修改。这两项不是用户 Bridge 配置。

项目和 Foundry 模块 ID 统一为 `familiar-agent-bridge`，应用显示名称为 Familiar Agent Bridge。安装版使用系统应用数据目录下的 `Familiar Agent Bridge/`，不再回退到旧名称目录。Foundry 设置、配对、待发消息和浏览器锁统一使用当前模块 ID，不迁移旧名称的命名空间。

旧版数据接管只接受 `package.json` 中 `name` 为 `familiar-agent-bridge` 的项目：只在用户选择项目时读取其 `.env`，复用状态与锁，不复制配对密钥。正常启动仅加载桌面 `settings.json`，不自动读取 `.env` 或进程中的 Bridge 配置。旧 `STDIN_PLAYER` 自动映射到 `TEST_PLAYER`，下次保存才更新磁盘。关闭应用时等待 Bridge 与所有子进程退出；最小化保持运行。

## 连接检测与准备步骤

`desktop/main/connection-checks.mjs` 保存本次应用的 Codex、世界、推送检测结果，包含待测试、测试中、通过、失败和验证时间。`snapshot.connections` 是控制台步骤、准备清单和连接设置的唯一结果来源；renderer 的 `connections.mjs` 统一生成文字与完成标记，不能用配对文件存在、旧世界记录、版本兼容字段或端口监听替代验证。

Codex 的“检查连接”在版本和指定 Familiar 服务均通过后才发布成功；失败清除旧环境结果和后续步骤。世界只读测试的两个按钮复用 `doctor` IPC，保留原有只读 Probe、锁、暂停队列和子进程清理，再核对 Agent 回执中的世界 ID。没有配对时允许读取世界，但世界步骤仍为待测试。renderer 有未保存设置、配对或规则时不启动只读测试。

正常运行的健康检查也更新 Codex 和配对世界结果；暂停时撤销世界通过状态。FoundryEventSource 仅在签名、协议、世界 / GM 身份、状态 ID 或玩家事件均验证成功并返回正常响应后发出内部 `verified` 事件。DesktopSession 将其转为 `relayVerifiedAt`，通知控制器更新推送步骤。它不新增 HTTP 接口、不发送聊天、不修改玩家请求，也不把单纯监听视为 GM 已连接。只读 Probe 不启动推送监听，GM 身份测试仍在 Foundry 页面执行。

停止服务保留内存中的最近结果，页面注明“上次测试通过”；重启应用清空。保存 Bridge 设置、更换 Codex、接管项目或重置会话清空检测；更新、轮换或导入配对清空世界和推送结果。每次启动重新检测，避免把前次 GM 请求当成本次监听的连接凭据。预览只模拟 Codex 和世界结果，不伪造 GM 签名验证。

## 运行日志与 AI 回答

运行日志提供“系统日志”和“AI 回答”两个标签页，默认显示系统日志。标签支持点击、左右方向键和 Home / End；状态刷新保留当前选择。当前页内容变化后自动滚动到底部，展开日志、切换标签或切回控制台时也定位最新记录。另一页的更新和无新内容的状态刷新不改变当前阅读位置。只滚动日志区域，不移动整个页面。

两个正文面板统一使用 `.log-card pre` 样式：继承界面字体、14px 字号、1.8 行距与相同文字颜色，保留换行、长行折行及独立滚动。

系统日志保留原有级别过滤和最近 300 条上限。AI 回答通过 `src/runtime/responses/collector.mjs` 从玩家 Turn 的完整 Item 收集：`agentMessage` 的最终回答，以及 Familiar `send-chat-message` 成功回执对应的 `arguments.content`。未标记阶段的旧模型文本兼容展示；思考过程、进度说明、健康检查和失败的聊天发送不进入回答页。Item 通知和 Turn 汇总按 Item ID 去重；后续 Turn 失败不抹掉已收到的回答，也不改变原来的 `uncertain` 判定。

Bridge 的 `response` 事件经 DesktopSession 回调进入 DesktopController 的独立 `aiResponses` 缓冲，随已有 `snapshot` IPC 返回。最近 100 条回答保留来源、玩家、请求和 Thread ID；正文脱敏并保留换行，超过 64000 字符时明确标记截断。回答不受 `LOG_LEVEL` 过滤，只保存在本次应用内存中，停止 Bridge 后仍可查看。renderer 使用 `textContent` 显示正文，HTML 和 Markdown 均作为文本展示。

`test/desktop-log-scroll.test.mjs` 覆盖双标签选择、独立刷新、滚动和键盘操作。`test/response-collector.test.mjs`、Bridge 与桌面会话 / 控制器测试覆盖回答来源、去重、脱敏、失败保留、级别隔离和容量。演示预览的手工请求会生成明确标注“演示”的两种回答，不能作为真实游戏验证。

## 待审核工作区

`DesktopController.snapshot` 从状态回执生成 `reviewIssues`，只返回界面需要的玩家、正文、时间、来源、失败摘要和审核消息；不把任意事件 metadata 暴露给 renderer。跑团控制台“处理待审核”入口和“需要核对”指标只统计没有 `resolvedAt` 的记录，已解决记录仍保留并可重新打开。审核页是跑团控制台的子页面，不占用左侧一级导航；返回按钮回到控制台，左侧也保持控制台选中。

入口放在步骤条下方、会话卡片上方的独立提示条。有待处理项时使用暖色底和实色按钮，同时显示数量；归零后保留历史入口并恢复普通样式。

`review-message` IPC 只接受记录 ID 和不超过 16000 字符的 GM 消息。Bridge 必须处于健康运行状态；审核任务由核心队列串行执行，并将最终 `agentMessage` 脱敏后持久化。界面用 `textContent` 构建列表和消息，不解析审核文本中的 HTML。`review-resolved` 是可逆状态更新；停止时由控制器在取得状态锁后写入，运行时复用 Bridge 已持有的 Store。

浏览器演示提供一条明确标注的模拟待审核记录，并在内存中模拟 AI 答复和关闭/重新打开操作；不连接 Codex 或 Foundry，不能作为真实核对凭据。

## GM 控制台

`DesktopController.snapshot` 同时返回持久化的 `gmMessages`。`gm-message` IPC 只接受不超过 16000 字符的字符串，并要求当前 DesktopSession 已激活；renderer 使用与审核页相同的纯文本消息组件显示 GM、AI DM 和 Bridge 系统记录。相同消息快照不会重建 DOM，因此普通状态刷新不会把 GM 正在翻阅的历史强制滚回底部。

Bridge 在 GM 消息落盘后发送 `change` 事件，DesktopSession 转交给 renderer，使正在执行时也能先看到 GM 消息。最终 Agent 答复或中断警告写入后再次刷新。GM 控制台不提供任意 IPC、文件或命令入口；它只创建受既有只读本机沙箱、`approvalPolicy: never` 和 Familiar 工具守卫约束的 Turn。浏览器预览只在内存中模拟场景修正答复。

## Foundry ZIP

`src/foundry/module-package.mjs` 从 `module.json` 的入口收集静态相对依赖，打包为带 `familiar-agent-bridge/` 顶层目录的 ZIP。版本来自模块清单。新增资源类型或动态加载文件时，要扩展收集逻辑并增加解压测试，不能直接扫描整个项目打包。

ZIP 使用 Node 原生 Deflate，不依赖系统压缩命令或新增 npm 包。文件排序与时间固定，同一份输入可重复生成相同文件。打包拒绝越界路径和符号链接，限制单文件 4 MiB、总计 16 MiB 和 256 个文件。

开发打包命令默认输出到 `dist/foundry/`。桌面通过原生保存对话框选择输出位置，取消不写文件；renderer 不能提交任意写入路径。导出只创建 ZIP，不检测或更新本机 Foundry 目录。

模块目录和清单规范见 [Foundry 官方模块开发说明](https://foundryvtt.com/article/module-development/)。当前不生成虚构的在线 manifest/download 地址；如需在线分发，应先准备真实托管地址。

## macOS 应用

`electron-builder.json` 维护文件白名单。准备脚本复制 `agents/dm/`、`foundry-module/` 和 `docs/user-manual/` 到 `build/bridge-resources/`，保留相对目录，再作为 extraResources 打包。`docs/development/` 不进入安装包。

桌面“打开完整用户手册”从资源目录的 `docs/user-manual/README.md` 打开文档。移动文档时要同时更新此入口、准备脚本与安装包检查。

不要让 extraResources 直接引用 `foundry-module/`：electron-builder 可能把核心依赖的共享协议从 ASAR 排除。包检查必须核对所有相对 import、资源和当前源码。

安装包不包含 `.env`、data、开发文档或根 AGENTS.md。当前使用本地 ad-hoc 签名，未做 Developer ID 签名和 Apple 公证；不自动发布。
