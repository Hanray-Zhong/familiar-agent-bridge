# 桌面应用与打包

[开发手册目录](README.md) · [用户手册](../user-manual/README.md)

## 桌面隔离

主进程启动 Bridge；renderer 禁用 Node，并启用 sandbox、contextIsolation。IPC 校验窗口、主 frame 和精确 UI URL，拒绝导航、新窗口和任意文件操作。

桌面独立数据放在操作系统的应用数据目录。开发版默认使用 `data/desktop/`；可仅为开发设置 `FAMILIAR_BRIDGE_APP_DATA`。预览端口默认 `3361`，可用 `FAMILIAR_BRIDGE_PREVIEW_PORT` 修改。这两项不是用户 Bridge 配置。

项目和应用分别命名为 `familiar-agent-bridge`、Familiar Agent Bridge。安装版在新目录没有 `settings.json`、旧目录存在该配置时复用旧 Familiar Codex Bridge 目录，空缓存目录不阻止恢复。Foundry 的持久化模块 ID 保持 `familiar-codex-bridge`，只更新显示名称和安装包文件名。

旧版数据接管是保留的兼容入口：只在用户选择旧项目时读取其 `.env`，复用状态与锁，不复制配对密钥。正常启动仅加载桌面 `settings.json`，不自动读取 `.env` 或进程中的 Bridge 配置。旧 `STDIN_PLAYER` 自动映射到 `TEST_PLAYER`，下次保存才更新磁盘。关闭应用时等待 Bridge 与所有子进程退出；最小化保持运行。

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
