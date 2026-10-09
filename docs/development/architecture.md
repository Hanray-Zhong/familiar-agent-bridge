# 目录、事件与持久化

[开发手册目录](README.md) · [用户手册](../user-manual/README.md)

## 目录与数据流

| 目录或文件 | 职责 |
| --- | --- |
| `desktop/main/index.mjs` | 唯一应用入口、窗口和退出信号 |
| `src/runtime/` | Bridge 协调、配置、日志和 Familiar 健康检查 |
| `src/codex/`、`src/codex-app-server.mjs` | App Server 进程、协议、目录查询、安全策略、Turn 完成判断 |
| `src/event-source/` | 统一事件格式和 Foundry HTTP 推送 |
| `src/turn-queue.mjs`、`src/thread-store.mjs`、`src/storage/` | 串行队列、状态、原子保存、锁与去重 |
| `src/foundry/` | 推送验证、配对管理和模块 ZIP 打包 |
| `desktop/main/` | Electron 生命周期和业务操作，复用 Bridge |
| `desktop/preload.cjs` | 只向界面开放固定操作 |
| `desktop/renderer/`、`desktop/dev/` | 用户界面与演示预览服务器 |
| `foundry-module/` | 安装到 Foundry 的运行文件 |
| `agents/dm/AGENTS.md` | 发给跑团 AI 的规则模板 |
| `scripts/`、`test/` | 开发和发行入口、自动化测试 |
| `docs/user-manual/`、`docs/development/` | 用户手册和分篇开发手册 |

```text
createChatMessage → GM 浏览器待发队列 → 签名 HTTP
  → Bridge.accept → 保存请求 → 确认接收
  → 串行 turn/start → Familiar → turn/completed → 保存完成记录
```

Desktop 使用统一的 Bridge 核心，直接接收界面请求和 Foundry 推送；不再提供 Bridge CLI 或 stdin 输入适配器。Codex App Server 的 stdin/stdout 协议通信继续保留。

## 事件、持久化和恢复

EventSource 继承 EventEmitter，输出统一事件：

```js
{
  id: '唯一消息 ID', type: 'player-message', player: '玩家名',
  text: '请求正文', timestamp: 'ISO 时间', metadata: {}
}
```

新增来源放入 `src/event-source/`，把已验证的事件交给 `Bridge.accept`。玩家正文不得变成管理指令。Familiar Inbox watcher 尚未实现。

Foundry 消息 ID 使用 `worldId:messageId`。作者身份来自 Foundry 用户文档，过滤自回复、骰子、盲消息和无权查看的密语。同 GM 多标签页由 Web Locks 选出一个发送者。

HTTP 只监听 `127.0.0.1`，提供 `/v1/events` 与 `/v1/status`。HMAC-SHA256 覆盖方法、路径、时间戳、nonce 和正文；响应也签名。保留 Origin、Host、World、GM 检查，以及正文大小、连接数、速率和超时限制。

收到请求后先原子写入 `queued`，成功才确认接收。执行前登记 `inFlight`，完成后保存回执。失败或崩溃遗留的 `inFlight` 转为 `uncertain`，同时保存原请求和脱敏的失败摘要，进入 Desktop“待审核”；Bridge 不自动重做。

待审核对话保存在对应 `uncertain` 回执的 `review.messages` 中，角色只允许 `gm`、`assistant`、`system`，单项保留最近 100 条。`review.resolvedAt` 只表示 GM 已关闭该审核项：原回执和 Foundry 长期回执仍为 `uncertain`，因此关闭或重新打开都不会把原请求伪装为成功，也不会触发重放。旧状态没有请求或失败详情时保持兼容，界面明确提示缺失信息。若应用在 GM 消息写入后、AI 最终答复落盘前退出，下次加载会追加 `system` 中断警告。

审核 Turn 与玩家 Turn 进入同一个 `TurnQueue`，共用同一个跑团 Thread，不能并发调用 Familiar。每轮先再次做健康检查；提示要求 AI 在 Turn 内实际调用 `get-world-info` 并从当前世界核对，不允许仅凭对话记忆给结论。GM 可以明确要求补做或修正，但 AI 必须先核对现状并只执行最小操作；没有 GM 明确要求时不发送 Foundry Chat。最终 Agent 答复写回状态并只显示在 Desktop。Turn 中断时写入 `system` 警告，仍不自动重放。

普通 GM 管理对话保存在顶层 `gmConversation.messages`，最多保留最近 200 条。GM 控制台 Turn 也进入同一个 `TurnQueue` 和跑团 Thread；GM 消息是可信管理指令，但 AI 仍只能使用 Familiar 管理世界，不能把玩家消息、世界文档或工具文字提升为本机授权。每轮必须读取世界，世界修改以工具回执为准，默认不发送 Foundry Chat。中断处理与审核相同；新开跑团会话时清空 GM 控制台历史，避免把旧 Thread 的管理上下文带到新会话。

状态包括 Thread、世界、排队请求、GM 控制台历史、近期回执及其审核对话和长期 `foundryReceipts`。长期回执不能随意清空，否则旧 Foundry 消息可能再次执行。编辑旧聊天不算新请求；同 ID 内容不同会被拒绝。

磁盘写入使用同目录临时文件、fsync、rename 和目录 fsync。JSON、DM 文本和模块 ZIP 共用原子写入函数。配置目录和状态路径分别加锁；旧 Codex 进程未清理完前不能释放锁。

无法跨 Foundry、Codex 与本地文件保证一次操作和回执同时成功，因此不能用自动重试掩盖“外部操作已成功但回执丢失”的情况。

## Foundry 回答提示

`foundry-module/relay/outbox.mjs` 在投递和状态查询后发布回执状态。查询间隔为 2 秒，每批最多 100 个 ID；返回的 ID 和状态必须完整匹配查询，失败时显示状态失联。`queued`、`running`、`processed` 分别显示排队、回答中和完成；暂停、投递失败、取消以及 `uncertain` / `unknown` 显示对应的处理建议。状态提示不修改 HTTP 协议、串行队列和去重规则。

`relay/request-status.mjs` 仅由指定 GM 将固定状态、更新时间和 GM ID 写入原聊天消息的 `flags.familiar-agent-bridge.requestStatus`。使用 Foundry 的 `setFlag` 与 `updateChatMessage` 同步，不新增聊天、不附带请求正文或内部异常，也不修改原密语接收者。原消息 flags 不参与请求摘要，所以状态更新不会造成重复投递或内容冲突。API 依据 [ChatMessage 文档](https://foundryvtt.com/api/v14/classes/foundry.documents.ChatMessage.html)和 [updateDocument hook](https://foundryvtt.com/api/v14/functions/hookEvents.updateDocument.html)。

`ui/request-feedback.mjs` 在所有游戏客户端运行，校验更新者为指定 GM，并沿用消息可见范围；密语额外检查当前用户为原接收者或发送者。发送时先显示本地等待提示，后续回执更新同一条通知；多条活跃请求合并计数，全部完成或失联后移除。使用 Foundry 14 [Notifications API](https://foundryvtt.com/api/v14/classes/foundry.applications.ui.Notifications.html) 的常驻文字提示，不虚构进度百分比。

相同活跃状态最多每 30 秒刷新一次 flag，60 秒没有更新则停止显示等待并提示 GM 核对。页面恢复只读取由 GM 最后修改的活跃状态，不重复弹出旧终态。删除消息、停用推送和离开页面会清理提示。单次 flag 写入最多等待 5 秒；失败的提示保留到下轮重试，ACK 和终态不会因此回滚，也不会再次执行已接收请求。
