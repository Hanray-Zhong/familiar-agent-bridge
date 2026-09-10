# 开发环境与命令

[开发手册目录](README.md) · [用户手册](../user-manual/README.md)

使用 Node.js **22.12+** 和 npm，按 `package-lock.json` 安装。当前协议适配 `codex-cli 0.153.4`，Foundry 模块适配 Foundry 14；已有验证环境为 Foundry 14.367 / Familiar 2.25.0。

```bash
npm ci
npm test
npm run check
```

| 命令 | 作用 |
| --- | --- |
| `npm run desktop` | 启动 Electron 开发版，自动准备运行时和资源 |
| `npm run desktop:preview` | 启动浏览器界面预览，只用演示数据，不连接游戏 |
| `npm test` | 运行全部单元和集成测试，包含桌面组件与 ZIP 解压测试 |
| `npm run check` | 检查语法、源码行数、文档链接和手册中的配置项 |
| `npm run dist:foundry` | 生成 Foundry 模块 ZIP，可用 `-- --output /路径/module.zip` 指定目标 |
| `npm run dist:mac` | 在 Mac 构建 Apple Silicon 的应用、DMG 和 ZIP，最多等待 5 分钟 |
| `npm run check:package` | 检查已构建的 macOS 应用是否漏文件、包含私有数据或使用旧资源 |
| `npm run probe-security -- "桌面应用数据目录"` | 使用已有桌面配置做真实只读注入探针；先停止 Bridge，会使用 Codex 额度 |

游戏运行、配对和模型选择统一在 Desktop 操作，见用户手册。`predesktop` 与 `predist:mac` 是 npm 自动钩子，无需手动调用。单独检查一个测试文件可运行 `node --test --test-timeout=20000 test/文件名.test.mjs`。

测试和打包命令是开发工具，不是另一个跑团入口。本项目不安装全局 npm 包或系统服务。Windows 的进程树清理与桌面发行尚未适配。
