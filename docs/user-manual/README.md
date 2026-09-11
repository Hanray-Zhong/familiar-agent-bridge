# 用户手册

Familiar Agent Bridge 把 Foundry 中的玩家请求交给 Codex，再由 Familiar 操作游戏。Desktop 是唯一跑团入口，可直接运行开发版，也可安装打包后的应用。

本手册统一保存在 `docs/user-manual/README.md`。桌面应用可通过“使用帮助 → 打开完整用户手册”阅读同一份说明。

## 1. 快速开始

### 准备好现有环境

- 已安装 Foundry，目标世界能正常打开，并启用了 Familiar。
- 已安装并登录 Codex CLI。当前 Bridge 适配 **0.153.4**。
- `codex mcp list` 中有已启用的 `familiar`，Codex 能通过它查询世界。
- 负责转发消息的 GM 浏览器与 Bridge 在同一台电脑。玩家和 Foundry 服务器可以在其他电脑。

若还没连接 Familiar：在 Familiar 设置的 **MCP / Subs** 页选择 **Codex CLI**，按该页面的连接说明配置。连接信息继续由 Codex 的 `~/.codex/config.toml` 管理，不用复制到 Bridge。

### 打开桌面应用

macOS Apple Silicon（M 系列芯片）使用 DMG 安装包，将应用拖到“应用程序”后打开。也可以解压桌面版 ZIP。应用内置 Node 运行时；Codex、Foundry 和 Familiar 仍需单独安装。

当前桌面包使用本地签名，尚未完成 Apple Developer ID 签名和公证。

第一次使用：

1. 在“连接设置”点击“自动查找”或“选择程序…”，指定已登录的 Codex，保存后点击“检查连接”。
2. 点击“导出模块安装包…”，按第 2 节安装 Foundry 模块。
3. 填写世界 ID、GM 用户 ID 和允许的 Foundry 页面地址，生成配对文件。填写方法见第 3 节。
4. 在 Foundry 中导入配对文件并启用推送。
5. 回到“跑团控制台”，选择 **Foundry @familiar**，点击“启动 Bridge”。
6. 用玩家账号发送：`@familiar 我环顾当前场景。`

成功时，控制台会显示请求处理进度，Foundry Chat 会收到 Familiar 发出的中文回复。

“只读检查完整链路”会实际读取世界，不发聊天、不掷骰。控制台的“发起一个测试请求”则是正常游戏请求，会产生 Foundry Chat 回复。

### 接着使用旧版跑团数据

先停止旧版 Bridge，再点击“连接设置 → 接管旧版跑团数据”，选择保留旧配置和状态的项目目录。

接管只读取旧项目 `.env` 中支持的设置，继续使用原状态、配对和 DM 规则文件。之后在桌面修改配置，保存到应用自己的 `settings.json`；不会改写原 `.env`，也不需要再运行旧版 CLI。

## 2. 生成并安装 Foundry 模块

**Familiar Agent Bridge 模块和 Familiar 是两个模块，两者都要启用。** 桥接模块只负责转发玩家请求。

### 获取 ZIP

桌面版在“连接设置”点击“导出模块安装包…”，选择保存位置。

源码版在项目目录执行：

```bash
npm run dist:foundry
```

生成 `dist/foundry/familiar-agent-bridge-module-0.2.0.zip`。文件名中的版本来自模块自己的 `module.json`，可与桌面应用版本不同。

模块显示名称已改为 Familiar Agent Bridge，但内部 ID 仍保留 `familiar-codex-bridge`，因此解压后的文件夹也使用旧名称。这样可以沿用已有设置、配对和待发消息。

需要指定输出位置时：

```bash
npm run dist:foundry -- --output "/你的目录/bridge-module.zip"
```

再次生成会替换同名 ZIP。该命令无需启动 Codex 或 Foundry，也不会复制文件到 Foundry 安装目录。

### 安装到 Foundry

1. 解压 ZIP，得到 `familiar-codex-bridge` 文件夹。
2. 将整个文件夹放到 **Foundry 用户数据目录的 `Data/modules/` 下**。
3. 确认文件位置为 `Data/modules/familiar-codex-bridge/module.json`，不要多嵌套一层文件夹。
4. 让 Foundry 重新发现模块；若列表里没有，在合适时机重启 Foundry。
5. 进入世界，在“管理模组 / Manage Modules”启用 **Familiar Agent Bridge**。

模块文件应放在运行 Foundry 服务器的电脑上。macOS 默认用户数据目录通常是 `~/Library/Application Support/FoundryVTT/`；以你在 Foundry 中选择的位置为准。

更新时先停止 Bridge、备份旧模块目录，再替换模块文件并刷新 GM 页面。已有私有配对文件可以继续使用。

Foundry 的“安装模组 → Manifest URL”需要在线清单地址，不能填本机 ZIP 路径。当前项目提供离线 ZIP，安装方式以上述解压步骤为准。模块目录结构依据 [Foundry 官方说明](https://foundryvtt.com/article/module-development/)。

## 3. 配对世界、GM 和浏览器

### 找到两个 ID

世界 ID 不是世界标题；GM 用户 ID 不是昵称或角色 ID。

可以让已连接 Familiar 的 Codex 只读查询这两个 ID。也可以在负责推送的 GM 游戏页面打开开发者工具 Console，运行：

```js
({ worldId: game.world.id, gmUserId: game.user.id, isGM: game.user.isGM })
```

确认 `isGM` 为 `true`，将另外两个值填入 Bridge“世界与 GM 配对”。

### 填写配对设置

| 设置 | 填什么 | 影响 |
| --- | --- | --- |
| 世界 ID | 目标世界的 ID | 只接收这个世界的玩家请求 |
| GM 用户 ID | 负责推送消息的 GM 的 ID | 由该 GM 的游戏页面转发请求 |
| Bridge 端口 | 默认 `3210`，可填未占用的 `1024–65535` 端口 | Bridge 接收推送的位置，与 Foundry 自己的端口不同 |
| 允许的 Foundry 页面地址 | 默认 `http://localhost:30000` 和 `http://127.0.0.1:30000`，每行一个 | 只接受来自这些页面的推送 |
| 重新生成配对 | 已有配对需要修改时勾选 | 生成新密钥；之后必须在 GM 浏览器重新导入文件 |

页面地址只保留协议、主机和端口。例如 `https://vtt.example.com/game` 应填 `https://vtt.example.com`，不带 `/game` 或末尾斜杠。`localhost` 与 `127.0.0.1` 是两个不同地址。

生成后点击“在文件夹中显示配对文件”，找到要导入的 JSON。已有配对可使用“导入已有配对…”。配对文件包含私有密钥，只交给指定 GM，不放进模块目录或发给玩家。

### 在 Foundry 启用推送

1. 用配对的 GM 登录对应世界，保持该游戏页面打开。
2. 在 Familiar 的 **Chat** 设置页关闭 **Table Chat** 自动回答，保留 Familiar 模块启用。
3. 打开“配置设置 → Familiar Agent Bridge → 配置 Bridge 推送”。
4. 选择配对 JSON。先启动 Bridge，再点击“测试连接”。
5. 显示就绪后，勾选“启用玩家消息推送”，点击“保存并应用”。

| Foundry 界面选项 | 作用 |
| --- | --- |
| 启用玩家消息推送 | 开始转发玩家 `@familiar`，默认关闭 |
| 也接受 GM 手工输入 | GM 用自己的账号发测试请求时开启，默认关闭 |
| 测试连接 | 检查是否就绪，不保存设置，也不发送游戏请求 |
| 重试待发消息 | 连接修复后重试尚未送达的请求 |
| 保存并应用 | 保存当前设置并开始按新设置工作 |

配对只保存在这个 GM 浏览器中。换浏览器、清除站点数据或重新生成配对后，需要重新导入。GM 页面使用 localhost 或 HTTPS；浏览器要求本地网络访问权限时，按连接需要允许。

## 4. 对话、模型与主持规则

### 继续或更换对话

一般将“固定对话 ID”留空，Bridge 首次创建对话，以后自动恢复。界面上打开了哪个 Codex 对话，不会影响 Bridge 的选择。

要指定已有对话：停止 Bridge，在“对话与模型”中查询并选择本场跑团的空闲对话，保存后启动。这里使用 Codex CLI / App Server 对话 ID，不是普通 ChatGPT 网页链接。

如果目标 ID 与当前状态中的 ID 不同，Bridge 会阻止直接切换。先备份状态，点击“新开跑团会话…”解除旧绑定，再选择目标 ID。新开会话会取消旧待办，不会删除 Codex 历史或回滚已执行的游戏动作。

### 选择 model 和 effort

在“对话与模型”点击“刷新可用模型”，选择模型和它支持的 effort，保存后重启 Bridge。

model 选择 AI 模型，effort 选择思考投入。可用值由当前 Codex 返回，不要把技术名称翻译成中文。留空表示由 Codex 决定；要固定组合就同时填写两项。控制台显示实际使用的值。

更换模型或 effort 不需要新开对话，也不需要修改 Familiar 自带 AI 的设置。

### 修改主持规则

停止 Bridge，在“主持规则”页面编辑并保存，下次启动生效。页面会显示实际的规则文件位置；应用自带的模板位于 `agents/dm/AGENTS.md`。

建议只调整桌规、叙事长度和表达偏好。保留玩家自主权、冒险资料优先、隐藏信息保护和实际操作必须调用 Familiar 的规则。冒险内容仍保存在 Foundry 的 Adventure / Journal 中。

## 5. Bridge 的全部配置

在桌面界面修改配置，保存到应用数据目录的 `settings.json`。下表的键名用于对照备份文件，日常不需要手工编辑 JSON。不要把 Familiar 密钥填入这些设置。

配置修改后需要停止并重新启动 Bridge。默认的相对路径以应用数据目录的 `runtime/` 为起点；接管旧版数据后以原项目为起点。

### Codex 与连接

| 配置项 | 默认值 | 影响 |
| --- | --- | --- |
| `CODEX_COMMAND` | `codex` | Codex 程序名称或完整路径，只填程序，不带命令参数 |
| `CODEX_CWD` | `.` | 对话的工作目录；不会切换对话或状态文件 |
| `CODEX_THREAD_ID` | 留空 | 固定已有对话 ID；留空自动恢复已保存的对话 |
| `CODEX_MODEL` | 留空 | 指定模型；留空由 Codex 决定 |
| `CODEX_REASONING_EFFORT` | 留空 | 指定该模型支持的思考投入 |
| `FAMILIAR_MCP_SERVER` | `familiar` | 使用 `codex mcp list` 中哪个 Familiar 服务 |
| `FOUNDRY_PUSH_CONFIG` | `./data/foundry-push.json` | 私有配对文件路径，供指定 GM 导入 |
| `TEST_PLAYER` | `玩家` | 桌面手工测试时的玩家名称，不改变 Foundry 消息作者 |

### 时间与恢复

单位均为毫秒，`1000` 是 1 秒。

| 配置项 | 默认值 | 影响 |
| --- | --- | --- |
| `CODEX_TURN_TIMEOUT_MS` | `300000` | 单条请求开始执行后最多等待 5 分钟；复杂战斗可增加到 `600000` |
| `CODEX_REQUEST_TIMEOUT_MS` | `30000` | 普通 Codex 请求等待响应的时间 |
| `FAMILIAR_HEALTH_TIMEOUT_MS` | `30000` | 一次世界读取和连接检查的等待时间 |
| `FAMILIAR_HEALTH_INTERVAL_MS` | `30000` | 空闲时检查连接或尝试恢复的间隔 |
| `CODEX_MAX_RESTARTS` | `3` | Codex 故障后的自动重启次数；`0` 关闭自动重启 |
| `BRIDGE_SHUTDOWN_TIMEOUT_MS` | `15000` | 停止时先等待当前请求完成，再尝试中断 |

### 文件、容量与日志

| 配置项 | 默认值 | 影响 |
| --- | --- | --- |
| `STATE_FILE` | `./data/state.json` | 保存对话、世界、待办和处理记录；搬迁时保留完整文件 |
| `DM_INSTRUCTIONS_FILE` | `./agents/dm/AGENTS.md` | 跑团长期规则路径，不能指向开发用根 AGENTS.md |
| `BRIDGE_QUEUE_LIMIT` | `1000` | 最多保留多少待处理请求；调大仍是逐条执行 |
| `LOG_LEVEL` | `info` | `debug` 更详细，`info` 日常使用，`warn` 仅警告和错误，`error` 仅错误 |

共 **18 项配置**。路径可以写完整绝对路径，包含空格时不需要额外加引号；界面不会展开 `~`、`$HOME` 或 `${变量}`。所有数值是整数，最大 `2147483647`；通常最小 `1`，检查间隔最小 `100`，重启次数最小 `0`。

Bridge 使用桌面保存的设置，系统环境变量和项目 `.env` 不会自动覆盖它们。Codex 仍读取自己的登录与 MCP 配置。旧配置中的 `STDIN_PLAYER` 会自动识别为 `TEST_PLAYER`，下次保存设置时更新文件。

## 6. 从源码运行 Desktop

开发版与安装包具有相同的跑团功能。在项目目录首次安装依赖，再打开桌面界面：

```bash
npm ci
npm run desktop
```

源码运行要求 Node.js 22.12+。`npm run desktop:preview` 只用于界面演示，不连接真实游戏。

开发版默认数据目录是项目的 `data/desktop/`。macOS 安装版默认位于 `~/Library/Application Support/Familiar Agent Bridge/`。通过“使用帮助 → 打开应用数据目录”可以找到当前实际位置。

升级前已使用旧名称的桌面版时，如果新目录尚未保存 `settings.json`，应用会继续使用 `~/Library/Application Support/Familiar Codex Bridge/` 中已有的配置与数据。不会合并或覆盖两份数据。

在桌面上完成原有管理操作：

| 需要做什么 | 桌面入口 |
| --- | --- |
| 检查 Familiar 是否能读取世界 | 跑团控制台 → 只读检查完整链路 |
| 配置配对、页面地址和端口 | 连接设置 → 世界与 GM 配对 |
| 查询和选择模型、effort 或已有对话 | 对话与模型 |
| 清除旧对话绑定并取消旧待办 | 对话与模型 → 新开跑团会话 |
| 核对异常后继续 | 跑团控制台 → 恢复连接 |
| 停止跑团 | 跑团控制台 → 停止，或关闭应用窗口 |

项目已移除原来的终端跑团入口和管理命令。新开发版与旧版 Bridge 不应同时处理同一场跑团。

## 7. 日常开关、备份与排错

每次开团打开同一世界、保持配对 GM 页面在线，再启动 Bridge。结束时点击“停止”或关闭应用窗口。最小化窗口会继续运行。

普通消息从正文开头写 `@familiar`，后面加空格或冒号。Familiar 自己的回复会被过滤。私聊只在配对 GM 有权看到时转发，回复不会扩大到公开聊天。

展开跑团控制台下方的“运行日志”，可以切换两个标签页：

- **系统日志**：查看连接、队列和工具执行状态，保留本次运行最近 300 条，受 `LOG_LEVEL` 控制。
- **AI 回答**：查看玩家请求的完整回答，分别标注“Foundry 聊天”和“Codex 回答”，并显示时间和玩家。保留最近 100 条，不受日志级别影响。回答保留换行，以文本显示；单条超过 64000 字符时标记截断。

新增内容时，当前标签页自动滚动到底部。切换标签、重新展开日志或切回控制台时，也会显示最新记录。没有新内容时，可以向上翻阅；另一标签页更新和普通状态刷新不会打断阅读，也不会切换标签。键盘可用左右方向键、Home / End 切换标签。

回答在收到完整记录后显示，开始使用前的旧回答不会补载。停止 Bridge 后仍可查看，关闭应用后清空。Codex 回答可能包含 GM 信息，仅在桌面查看；玩家实际收到的内容以 Foundry Chat 为准。回答出现不代表整条请求已成功，后续失败仍按“需要核对”处理。

断线后，尚未开始的请求保留排队。显示“需要核对”表示请求可能部分生效：先检查聊天、掷骰和资源消耗，再点击“恢复连接”。不要删除状态文件或反复重发同一行动。

### 备份

先停止 Bridge。桌面独立使用时，备份“使用帮助 → 打开应用数据目录”中的完整内容。接管过旧版数据时，还要备份原项目中的完整状态文件、配对文件和独立 DM 规则；自定义路径也要备份。

恢复时放回完整文件，再正常启动。只复制对话 ID 不能恢复消息处理记录。更新应用不会覆盖独立用户规则。

### 常见问题

| 情况 | 处理方法 |
| --- | --- |
| 找不到 Codex | 运行 `command -v codex` 找到程序路径，在连接设置中选择；未登录先运行 `codex login` |
| Codex 版本不兼容 | 使用项目当前支持的版本，或由开发者完成协议适配后再运行 |
| 找不到 Familiar 服务 | 检查 `codex mcp list` 和 Familiar 的 MCP / Subs 设置 |
| Familiar / Foundry 未就绪 | 打开正确世界，确认 Familiar 已连接，再做只读检查 |
| 玩家消息没触发 | 检查模块、推送开关、配对 GM 页面和正文前缀；GM 测试需单独开启接受 GM 消息 |
| 提示 Origin / GM / World 不匹配 | 核对第 3 节的地址与 ID；更新配对后重新导入 |
| 提示认证失败 | 检查是否导入最新配对文件，以及电脑时间是否正确 |
| 模块列表找不到 ZIP | 按第 2 节解压并放置模块文件夹，再让 Foundry 重新发现模块 |
| 端口占用 | 先停止重复实例；需要换端口时更新配对并重新导入 |
| 模型或 effort 不支持 | 刷新模型列表，使用该模型返回的值 |
| 对话绑定冲突 | 先备份、处理旧待办，再按第 4 节切换 |

当前不提供远程 Bridge 地址、自定义 `@familiar` 前缀、开机自启或 Windows 安装包。
