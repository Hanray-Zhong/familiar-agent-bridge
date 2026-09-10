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
