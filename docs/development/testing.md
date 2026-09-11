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

`test/foundry-feedback.test.mjs` 覆盖玩家通知生命周期、并发合并、密语可见性、GM 来源校验、断线过期、刷新恢复和 flag 写入。`test/foundry-outbox.test.mjs` 覆盖回执驱动提示、暂停恢复、异常重试建议、无效状态回执和提示失败后不重放；ZIP 测试校验新增提示文件实际进入安装包。真实世界验收时更新模块并刷新 GM 与玩家页面，分别检查公开请求、密语、正常完成和断线异常；自动化模拟不代表已完成这项人工检查。

`test/desktop-startup.test.mjs` 在独立 Node 子进程中加载真实桌面入口，以模拟 Electron 等入口求值结束后才触发 `ready` 的时序。覆盖窗口加载与显示、损坏配置退出和重复实例退出；子进程有启动期限和外层硬超时。启动流程修改后还应以临时 `FAMILIAR_BRIDGE_APP_DATA` 实际运行 `npm run desktop`，确认窗口打开并正常退出；无需连接 Codex 或 Foundry。
