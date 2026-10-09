# 测试与交付

[开发手册目录](README.md) · [用户手册](../user-manual/README.md)

1. 行为修改先运行相关测试，再运行全部 `npm test` 和 `npm run check`。ZIP 测试需要系统 `unzip`；进程清理测试需要允许执行 `ps`。受限环境缺少权限时应修正运行环境，不跳过断言；模拟进程另有 12 秒退出上限。
2. 模块打包变化运行 `npm run dist:foundry`，用 `unzip -t` 检查生成文件。不要把验证包安装到真实世界中。
3. 桌面打包变化运行 `npm run dist:mac`、`npm run check:package`。可用 `codesign --verify --deep --strict`、`hdiutil verify` 和 `unzip -t` 检查产物。
4. Codex 协议或 Familiar 链路变化时，先停止其他 Bridge，用隔离的桌面配置和只读工具验证。只读世界查询可在 Desktop 发起；注入验证可用带应用数据目录参数的 `probe-security` 开发工具。普通清理不重复触发真实模型调用。
5. 用户手动检查打包应用的启动、文件选择、ZIP 导出、配置恢复、真实 `@familiar` 和关闭行为。浏览器演示不能替代这些检查。
6. 每次改动同步更新 `docs/development/` 和 `docs/user-manual/` 中的说明，并检查 README 和 AGENTS.md 的链接。`npm run check` 会递归检查 `docs/` 下所有 Markdown 的本地链接和代码块。
7. 检查 Git diff，清理本次测试和构建子进程。将结果写在交付说明中，不另建历史验证文档。

保留持久化、网络错误和进程退出等故障测试。不要以绿色测试为目标删除有价值的断言或放宽安全策略。

`test/desktop-connections.test.mjs`、DesktopController / Session 与 HTTP 测试共同覆盖步骤共享、停止后保留结果、失败与配置变更撤销通过状态、配对世界不匹配、取消和清理失败，以及“已监听但尚未收到 GM 签名请求”不能完成推送步骤。浏览器预览可验证两页结果同步、程序选择按钮位置和日志字体；真实 GM 推送凭据由带签名的 HTTP 集成测试覆盖，演示页面不产生该凭据。

`test/foundry-feedback.test.mjs` 覆盖玩家通知生命周期、并发合并、密语可见性、GM 来源校验、断线过期、刷新恢复和 flag 写入。`test/foundry-outbox.test.mjs` 覆盖回执驱动提示、暂停恢复、异常重试建议、无效状态回执和提示失败后不重放；ZIP 测试校验新增提示文件实际进入安装包。真实世界验收时更新模块并刷新 GM 与玩家页面，分别检查公开请求、密语、正常完成和断线异常；自动化模拟不代表已完成这项人工检查。

`test/desktop-startup.test.mjs` 在独立 Node 子进程中加载真实桌面入口，以模拟 Electron 等入口求值结束后才触发 `ready` 的时序。覆盖窗口加载与显示、损坏配置退出和重复实例退出；子进程有启动期限和外层硬超时。启动流程修改后还应以临时 `FAMILIAR_BRIDGE_APP_DATA` 实际运行 `npm run desktop`，确认窗口打开并正常退出；无需连接 Codex 或 Foundry。

`test/reviews.test.mjs`、Store、Bridge、DesktopController 和 IPC 测试共同覆盖审核字段过滤、跨重启持久化、关闭与重新打开、同 Thread 执行、强制世界读取、模型猜测拒绝和固定 preload 接口。真实验收还应制造一条测试用 `uncertain` 记录，在 Desktop 连续追问一次并确认没有默认发送 Foundry Chat；只有 GM 明确要求时才验证最小修正操作。

同组测试还覆盖 GM 控制台历史、中断恢复、重新开会话清空、renderer 纯文本显示，以及与玩家 Turn 的串行执行。真实世界验收可要求 AI 先只读说明当前场景，再明确要求切换到一个测试场景并重新布置测试 Token；核对工具结果和最终世界状态后自行恢复，不能在生产跑团中随意试验。
