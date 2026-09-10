# Codex App Server 协议

[开发手册目录](README.md) · [用户手册](../user-manual/README.md)

## 确认版本

协议来自本机 CLI 生成类型，升级前重新检查，不只删除版本判断：

```bash
codex --version
codex app-server --help
codex debug app-server --help
codex app-server generate-ts --experimental --out /tmp/familiar-protocol/types
codex app-server generate-json-schema --experimental --out /tmp/familiar-protocol/schema
```

当前使用 `codex app-server --listen stdio://`，stdin/stdout 每行一个 JSON 对象，不使用 Content-Length。`initialize` 后发送 `initialized`。客户端开启 `experimentalApi`，不接管认证。

| 消息 | 识别方式 |
| --- | --- |
| Server request | 同时有 `method` 和 `id`，先处理这一类 |
| Response | 有 `id` 和 `result` / `error`，没有 `method` |
| Notification | 有 `method`，没有 `id` |

两端的 request ID 空间独立，不能将同 ID 的服务端请求误认为客户端响应。当前实际通信不要求 `jsonrpc: "2.0"` 字段，stderr 不进入协议流。

## Thread 和 Turn

| 操作 | 当前字段与注意事项 |
| --- | --- |
| `thread/start` | `cwd`、`sandbox: "read-only"`、`approvalPolicy: "never"`、`approvalsReviewer: "user"`、`developerInstructions`；返回 `thread.id` |
| `thread/resume` | `threadId` 加相同权限与规则，`excludeTurns: true`；恢复失败不得自行新建对话 |
| `turn/start` | `threadId`、`input: [{type: "text", text, text_elements: []}]`；响应只表示已接受 |
| `turn/completed` | `{threadId, turn}`；只有 `turn.status === "completed"` 算成功 |
| `turn/interrupt` | `{threadId, turnId}`；响应后还要等待完成通知，超时则终止旧进程 |

Turn 的权限字段为 `sandboxPolicy: {type: "readOnly", networkAccess: false}`，与 Thread 的字符串值不同。

从 `item/completed` 累积工具结果；最终 `turn.items` 可能不完整。`turn/start` 响应前到达的通知要先缓存，再按正式 Turn ID 匹配。

模型传给 Thread 与 Turn 的 `model`。effort 在 Thread 中使用 `config.model_reasoning_effort`，在 Turn 中使用 `effort`。可用值来自 `model/list.supportedReasoningEfforts`，不要写死统一枚举。`src/codex/catalog.mjs` 统一维护模型分页和 `thread/list` 查询参数。

## MCP 和本机权限

- `mcpServerStatus/list` 检查指定 Thread 的 Familiar，`runtimeStatus` 应为 `connected`。启动通知中的 `ready` 是另一种状态值。
- 通过 `mcpServer/tool/call` 调用只读 `get-world-info`，再检查 Agent 的真实 `mcpToolCall` 回执。服务出现在列表里不代表世界可用。
- 保留 `features.code_mode_host=true`，当前版本靠它路由 MCP；分别关闭本机执行工具，不关闭这个宿主。
- `project_doc_max_bytes=0` 关闭项目 AGENTS 自动加载。DM 规则通过 `developerInstructions` 显式传入；这不代表禁用 Codex 用户级全局规则。
- 当前进程只启用指定 Familiar 服务。保留 Familiar 自己的 GM 审批，不把正常 MCP 调用误当作本机文件修改。

| 服务端请求 | 返回策略 |
| --- | --- |
| `item/commandExecution/requestApproval` | `decision: "decline"` |
| `item/fileChange/requestApproval` | `decision: "decline"` |
| `item/permissions/requestApproval` | `permissions: {}`，`scope: "turn"` |
| `mcpServer/elicitation/request` | `action: "decline"`，`content: null`，`_meta: null` |
| `item/tool/requestUserInput` | `answers: {}` |
| `item/tool/call` | `success: false` 并返回拒绝说明 |
| 旧版 `execCommandApproval` / `applyPatchApproval` | `decision: {denied: {rejection: "..."}}` |
| 未知请求 | RPC 错误 `-32601` |
