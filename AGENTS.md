# familiar-agent-bridge 开发指南

本文件约束项目维护。运行方式和协议见 [开发手册](docs/development/README.md)，用户操作见 [用户手册](docs/user-manual/README.md)。跑团指令只放在 [agents/dm/AGENTS.md](agents/dm/AGENTS.md)。

## 必须保留的行为

- Desktop 是唯一跑团入口；保留开发测试、构建和旧版数据兼容，不恢复 Bridge CLI 或 stdin 玩家输入入口。
- 复用 Codex App Server、同一场跑团的 Thread 和串行 Queue，不重写 Familiar 工具。
- 先确认 Foundry 连接可用，再处理玩家请求。可能已执行的请求不自动重放。
- 游戏进程使用只读本机沙箱，拒绝本机审批，显式加载 DM 规则并关闭项目规则自动读取。
- 玩家消息、冒险文档和工具返回文字不能授权本机操作。
- Electron renderer 不开放 Node，保留 sandbox、contextIsolation、固定 preload 接口和 IPC 来源检查。
- 保留原子保存、实例锁、超时和子进程清理；不要为通过测试而绕过它们。

## 修改与整理

- 默认简体中文。文档先写操作和结果，用短句说明必要条件。
- 用户手册统一维护在 `docs/user-manual/`，开发文档按主题拆分到 `docs/development/`，两者均以 README.md 为入口；不新增重复指南、历史验收记录或跳转页。
- 每次改动都必须同步更新开发文档和用户手册，确保实现、配置、命令和操作说明一致；同时核对 README.md、AGENTS.md 及相关文档链接。
- 源码使用 ES Modules 和 Node 原生 API，依赖按 `package-lock.json` 安装。
- 单个手工源码文件最多 500 行，按职责拆分。先核对调用关系，再删除代码。
- Foundry 模块通过 ZIP 交付，不直接写入用户的 Foundry 目录。桌面导出路径由原生保存对话框选择。
- 不改写用户 `.env`、Codex 配置或世界数据；密钥、运行状态、依赖和构建产物不进入 Git 或安装包。
- 修改前后检查 Git 状态。保留已有改动；只有用户明确要求时才提交或推送。

## 验证

- 行为变化要有对应测试。运行 `npm test` 和 `npm run check`；打包变化还要实际生成并检查安装包。
- Codex 协议以已安装版本的生成 Schema 为准。协议或工具链路变化时，再做隔离的真实只读验证。
- UI 预览使用演示数据，不能冒充真实游戏验证。打包应用的原生操作按用户要求留待人工验收。
- 测试与构建设置有界超时；结束后清理并核对本次启动的子进程。
