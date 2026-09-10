// 桌面设置的默认值与表单定义；对象中不保存凭据。
export const configFields = [
  ['CODEX_COMMAND', 'codex', 'Codex 程序', 'connection', 'text', '已安装的 Codex 路径，或 PATH 中的 codex。'],
  ['CODEX_CWD', '.', '对话工作目录', 'advanced', 'text', '通常保持默认；相对于当前配置目录。'],
  ['CODEX_THREAD_ID', '', '固定对话 ID', 'agent', 'text', '留空自动恢复上次对话；填写 UUID 指定已有对话。'],
  ['CODEX_MODEL', '', '模型', 'agent', 'text', '留空沿用 Codex，为当前跑团单独指定模型。'],
  ['CODEX_REASONING_EFFORT', '', '思考投入', 'agent', 'text', '必须是所选模型支持的 effort。'],
  ['STATE_FILE', './data/state.json', '会话状态文件', 'advanced', 'text', '保存对话与消息记录；变更路径前完整备份。'],
  ['DM_INSTRUCTIONS_FILE', './agents/dm/AGENTS.md', '跑团规则文件', 'advanced', 'text', '独立的 AI DM 规则；不能指向开发用的根 AGENTS.md。'],
  ['FAMILIAR_MCP_SERVER', 'familiar', 'Familiar 服务名', 'connection', 'text', '与 Codex MCP 列表中的服务名称一致。'],
  ['FOUNDRY_PUSH_CONFIG', './data/foundry-push.json', '私有配对文件', 'advanced', 'text', '由连接设置生成，导入到指定 GM 的 Foundry 页面。'],
  ['TEST_PLAYER', '玩家', '测试玩家名称', 'advanced', 'text', '只用于桌面手工发送的请求，不改变 Foundry 作者身份。'],
  ['LOG_LEVEL', 'info', '日志级别', 'advanced', 'select', '日常使用 info，排查问题可用 debug。'],
  ['CODEX_TURN_TIMEOUT_MS', '300000', '单条请求超时（毫秒）', 'advanced', 'number', '默认 5 分钟；复杂战斗可延长。', 1],
  ['CODEX_REQUEST_TIMEOUT_MS', '30000', 'Codex 响应超时（毫秒）', 'advanced', 'number', '普通操作的响应等待时间。', 1],
  ['FAMILIAR_HEALTH_TIMEOUT_MS', '30000', '连接检查超时（毫秒）', 'advanced', 'number', '真实读取 Foundry 世界的时间预算。', 1],
  ['FAMILIAR_HEALTH_INTERVAL_MS', '30000', '空闲检查间隔（毫秒）', 'advanced', 'number', '连接恢复后继续处理队列。', 100],
  ['CODEX_MAX_RESTARTS', '3', 'Codex 自动重启次数', 'advanced', 'number', '0 表示不自动重启；人工恢复会重置计数。', 0],
  ['BRIDGE_SHUTDOWN_TIMEOUT_MS', '15000', '停止等待（毫秒）', 'advanced', 'number', '等待当前请求完成，再尝试中断。', 1],
  ['BRIDGE_QUEUE_LIMIT', '1000', '队列容量', 'advanced', 'number', '增加等待容量，不增加并行处理数量。', 1],
].map(([key, value, label, group, type, hint, min]) => ({ key, default: value, label, group, type, hint, ...(min !== undefined ? { min, max: 2147483647 } : {}) }));

export const configDefaults = Object.fromEntries(configFields.map(field => [field.key, field.default]));
