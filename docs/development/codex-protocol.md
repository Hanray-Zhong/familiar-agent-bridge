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

`thread/resume` 返回 `thread <id> already has an active writer` 时，表示另一个 Codex 进程仍持有该对话的写入锁。客户端将其归类为 `THREAD_IN_USE`：Bridge 停止自动恢复尝试，关闭本次 App Server，保留原 Thread 和全部待办；控制台通过 `status.pauseReason` 显示脱敏后的原因。占用方释放对话后，由管理员点击“恢复连接”，成功完成健康检查才清除提示并继续队列。

当前生成的 `ThreadResumeParams` 没有跨进程强制接管字段。不要删除 Codex 写入锁或自动 fork / 新建替代对话。同一 App Server 中重新加入已加载的 Thread，不代表另一个进程能接管它。Codex 桌面即使没有正在生成，也可能保持对话加载；[官方协议](https://learn.chatgpt.com/docs/app-server#api-overview)说明取消订阅只影响当前连接，最后一个订阅者离开后仍需等待卸载宽限期。必要时完全退出占用方应用后再恢复。

Turn 的权限字段为 `sandboxPolicy: {type: "readOnly", networkAccess: false}`，与 Thread 的字符串值不同。

从 `item/completed` 累积工具结果；最终 `turn.items` 可能不完整。`turn/start` 响应前到达的通知要先缓存，再按正式 Turn ID 匹配。

桌面回答页复用玩家 Turn 的 `onItem` 与完成后的 Item 集合，不解析系统日志。`agentMessage.text` 在 `phase === "final_answer"` 时展示，`phase` 缺失或为 `null` 时兼容展示；显式 `commentary` 和 `reasoning` 不收集。Familiar 的 `send-chat-message` / `send_chat_message` 仅在 `status === "completed"`、存在结果且无失败标记时，展示 `arguments.content` 并标为“Foundry 聊天”。两种来源分别保留，不能用模型最终文本推断已发送玩家聊天。只有完整 Item 进入回答页，不收集文本 delta；同一请求按 Item ID 去重，隔离其他 Thread 和旧 Turn 的通知。

Desktop 审核同样通过 `turn/start` 写入原跑团 Thread，但 `clientUserMessageId` 使用审核消息自己的 UUID。审核提示把原玩家请求标为不可信数据，只把 `role=gm` 的 Desktop 消息作为当前 GM 指令；任意事件 metadata 不进入提示。审核必须在本轮 Item 中出现成功的 Familiar `get-world-info` 回执，最终只采用 `final_answer`（兼容缺失 phase）并写回审核记录。它不要求 `send-chat-message`，也不进入普通“AI 回答”内存缓冲。

GM 控制台使用相同的 `turn/start`、独立消息 UUID 和 Item 守卫。它允许可信 GM 明确要求 Familiar 执行场景切换、Token 布置或资源修正，但仍要求本轮出现成功的 `get-world-info`，并禁止本机工具、非 Familiar MCP 和默认玩家 Chat。玩家 Turn、审核 Turn 与 GM 控制台 Turn 全部由同一 `TurnQueue` 串行化；不能直接绕过 Queue 调用 `runTurn`。

模型传给 Thread 与 Turn 的 `model`。effort 在 Thread 中使用 `config.model_reasoning_effort`，在 Turn 中使用 `effort`。可用值来自 `model/list.supportedReasoningEfforts`，不要写死统一枚举。`src/codex/catalog.mjs` 统一维护模型分页和 `thread/list` 查询参数。

## MCP 和本机权限

- `mcpServerStatus/list` 检查指定 Thread 的 Familiar，`runtimeStatus` 应为 `connected`。启动通知中的 `ready` 是另一种状态值。
- 通过 `mcpServer/tool/call` 调用只读 `get-world-info`，再检查 Agent 的真实 `mcpToolCall` 回执。服务出现在列表里不代表世界可用。
- 保留 `features.code_mode_host=true`，当前版本靠它路由 MCP；分别关闭本机执行工具，不关闭这个宿主。
- `project_doc_max_bytes=0` 关闭项目 AGENTS 自动加载。DM 规则通过 `developerInstructions` 显式传入；这不代表禁用 Codex 用户级全局规则。
- 当前进程只启用指定 Familiar 服务。保留 Familiar 自己的 GM 审批，不把正常 MCP 调用误当作本机文件修改。

`resolve-ability-check` 和 `resolve-saving-throw` 的 `success` 表示是否通过检定或豁免。回执包含数值 `roll.total` 和 `dc` 时，`success: false` 是正常游戏结果，必须让当前 Turn 继续处理并发送叙述。例如总值 14、DC 15 表示检定未通过，不能据此中断 Turn 或标记 `uncertain`。显式 MCP 失败状态、`error`、`isError`、断线和缺少有效回执的失败结果仍会中断；其他工具及世界健康检查继续使用严格的成功判断。

切换场景的 `activated: true` 回执不代表画布已完成加载。每个玩家 Turn 使用独立的 `createGameItemGuard`：本回合已确认切换成功并取得场景 ID 后，允许一次带 `readOnlyHint: true` 的 `get-screenshot` 返回明确的 `Canvas is not ready — scene may be loading or no scene is active` 错误而不中断。错误仍返回给模型，Bridge 记录警告，由模型重新读取当前场景或再次请求只读截图；Bridge 不重试场景切换或玩家行动。同一失败 Item 的重复通知不消耗额外次数。第二次失败、任何其他错误或断线照常中断；管理只读检查不采用这个例外。中断日志包含工具名称与最多 400 字符的脱敏错误摘要，不记录参数或完整工具回执。

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
