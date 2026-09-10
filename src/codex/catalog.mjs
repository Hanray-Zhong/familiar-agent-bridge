export async function listModels(client, { includeHidden = true } = {}) {
  const models = [], cursors = new Set();
  let cursor;
  do {
    const page = await client.request('model/list', { limit: 100, includeHidden, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error('Codex 未返回有效模型列表');
    models.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Codex 模型列表分页异常');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return models;
}

export function listThreads(client, { limit = 100, archived = false, searchTerm } = {}) {
  return client.request('thread/list', { limit, archived, ...(searchTerm ? { searchTerm } : {}), modelProviders: [],
    sourceKinds: ['cli', 'vscode', 'appServer'], sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true });
}

export function modelConfigurationError(message) {
  return Object.assign(new Error(message), { code: 'MODEL_CONFIGURATION' });
}

// effort 是当前协议的字符串类型，按本机模型目录校验，不能写死一个全局枚举。
export function validateModelSelection(models, { model, reasoningEffort }) {
  if (!model) return;
  const selected = models.find(entry => entry.model === model);
  if (!selected) throw modelConfigurationError(`模型 ${model} 不在本机可用目录中；请在“对话与模型”刷新可用模型`);
  if (reasoningEffort && !selected.supportedReasoningEfforts.some(option => option.reasoningEffort === reasoningEffort)) {
    throw modelConfigurationError(`模型 ${model} 不支持 effort ${reasoningEffort}；请在“对话与模型”选择该模型支持的值`);
  }
}

export function modelThreadOptions({ model, reasoningEffort }, options = {}) {
  return {
    ...(model ? { model } : {}), ...options,
    ...(reasoningEffort ? { config: { ...options.config, model_reasoning_effort: reasoningEffort } } : {}),
  };
}
