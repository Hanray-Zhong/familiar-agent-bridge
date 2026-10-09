# familiar-agent-bridge

让 Codex 通过 Familiar 担任 Foundry VTT 的 AI DM。玩家发送 `@familiar` 后，Bridge 将请求放入队列，再由 Codex 调用 Familiar 读取世界、执行操作并回复。

```text
Foundry 玩家聊天 → Bridge 队列 → Codex App Server → Familiar MCP → Foundry
```

Desktop 是唯一跑团入口。一场跑团持续使用同一个 Codex 对话，请求按顺序执行。桌面应用提供连接设置、对话与模型选择、主持规则编辑、运行日志、跑团控制台内的异常结果审核，以及可直接要求 AI 调整场景和世界状态的“GM 控制台”。

- [用户手册](docs/user-manual/README.md)：安装、连接、所有配置项和日常使用。
- [开发手册](docs/development/README.md)：按主题查阅目录结构、开发命令、协议与测试。
- [AGENTS.md](AGENTS.md)：维护项目时的约定。
- [AI DM 规则](agents/dm/AGENTS.md)：实际发送给跑团 Agent 的长期指令。

## 开始使用

先安装并登录 Codex CLI，在 Codex 中配置 Familiar MCP。当前适配 Codex CLI **0.153.4**、Foundry **14**；桌面安装包面向 macOS Apple Silicon。

源码运行需要 Node.js **22.12+**：

```bash
npm ci
npm run desktop
```

在“连接设置”中关联 Codex、导出 Foundry 模块、生成配对文件并执行只读测试。连接设置与跑团控制台共用检测结果；各步骤只有验证通过后才打勾。后续步骤见用户手册。

开发版和安装包都使用同一套桌面功能。旧版跑团可在“连接设置 → 接管旧版跑团数据”中继续使用。

## 生成安装包

```bash
npm run dist:foundry
npm run dist:mac
```

Foundry 模块 ZIP 输出到 `dist/foundry/`；macOS 应用输出到 `dist/`。打包不会安装或更新 Foundry 中的文件。

## 检查项目

```bash
npm test
npm run check
```

项目不包含 Codex 登录信息、Familiar 密钥或 Foundry 世界数据。Desktop 沿用本机已有 Codex 配置；Codex CLI 是运行依赖。
