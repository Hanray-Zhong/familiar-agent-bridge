import { setTimeout as delay } from 'node:timers/promises';
import { TurnFailure } from '../codex/turn-runner.mjs';

export class FamiliarUnavailable extends Error {
  constructor(message) { super(message); this.code = 'FAMILIAR_UNAVAILABLE'; }
}

export function resultObjects(result) {
  const objects = [];
  if (result?.structuredContent) objects.push(result.structuredContent);
  for (const content of result?.content ?? []) {
    if (content.type !== 'text') continue;
    try { objects.push(JSON.parse(content.text)); } catch { /* 非结构化输出不作为健康凭据。 */ }
  }
  return objects;
}

export function resultFailed(result) {
  return Boolean(result?.isError || resultObjects(result).some(value => value &&
    (value.error || value.isError === true || value.success === false || value.connected === false)));
}

export function worldIdentity(result) {
  if (resultFailed(result)) throw new FamiliarUnavailable('Familiar 无法读取 Foundry 世界');
  for (const object of resultObjects(result)) {
    const world = object?.world ?? object;
    const id = world?.id ?? world?.worldId;
    const name = world?.name ?? world?.title ?? world?.worldName;
    if (typeof name === 'string' && name.length) return { id: typeof id === 'string' ? id : null, name };
  }
  throw new FamiliarUnavailable('get-world-info 未返回可识别的世界信息；拒绝把模型文字视为健康凭据');
}

export async function checkFamiliar(codex, threadId, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let server;
  do {
    let cursor = null;
    do {
      const page = await codex.request('mcpServerStatus/list', { threadId, cursor, limit: 100, detail: 'toolsAndAuthOnly' }, Math.max(1, deadline - Date.now()));
      server = page.data?.find(entry => entry.name === codex.familiarServer);
      cursor = page.nextCursor;
    } while (!server && cursor && Date.now() < deadline);
    if (server?.runtimeStatus === 'connected' && Object.keys(server.tools ?? {}).length) break;
    if (!server || ['failed', 'disabled', 'authenticationRequired', 'cancelled'].includes(server.runtimeStatus)) {
      const error = new FamiliarUnavailable(`Familiar MCP 不可用：${server?.runtimeStatus ?? '未发现服务'}`);
      error.restartRequired = ['failed', 'cancelled'].includes(server?.runtimeStatus);
      throw error;
    }
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  const tool = Object.values(server?.tools ?? {}).find(value => value.name?.replaceAll('_', '-') === 'get-world-info');
  if (!tool || server.runtimeStatus !== 'connected') throw new FamiliarUnavailable('Familiar 初始化超时或缺少 get-world-info');
  let result;
  try {
    result = await codex.request('mcpServer/tool/call', {
      threadId, server: codex.familiarServer, tool: tool.name, arguments: {},
    }, Math.max(1, deadline - Date.now()));
  } catch (cause) {
    const error = new FamiliarUnavailable('Familiar 只读调用失败；请检查 Foundry 连接和 MCP 服务');
    error.restartRequired = /transport|connection|closed|eof/i.test(cause.message);
    throw error;
  }
  const world = worldIdentity(result);
  return { world, tool: tool.name };
}

export function guardGameItem(codex, item, method) {
  if (['commandExecution', 'fileChange', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageView'].includes(item.type)) {
    throw new TurnFailure('检测到不允许的工具类型，已中断 Turn', 'SECURITY_VIOLATION');
  }
  if (item.type !== 'mcpToolCall') return;
  if (item.server !== codex.familiarServer) throw new TurnFailure('检测到非 Familiar MCP 调用', 'SECURITY_VIOLATION');
  if (method === 'item/completed' && (item.status === 'failed' || item.error || resultFailed(item.result))) {
    throw new FamiliarUnavailable('Familiar 工具失败，已中断当前 Turn 并暂停队列');
  }
}

export async function verifyAgent(codex, threadId, options = {}) {
  const probe = await checkFamiliar(codex, threadId, options);
  const result = await codex.runTurn(threadId,
    'HEALTH_CHECK（可信管理员只读检查）：仅通过 Familiar 调用 get-world-info，读取当前世界名称。不要发送 Chat、掷骰、播放音频或修改任何数据。不要执行本机命令。最后简短报告世界名称。',
    { ...options, onItem: (item, method) => {
      guardGameItem(codex, item, method);
      if (item.type === 'mcpToolCall' && item.tool !== probe.tool) throw new TurnFailure('只读健康检查调用了非预期工具', 'SECURITY_VIOLATION');
    } });
  const call = result.items.find(item => item.type === 'mcpToolCall' && item.server === codex.familiarServer && item.tool === probe.tool && item.status === 'completed');
  codex.logger?.debug('health', 'Agent 检查回执', { types: result.items.map(item => ({ type: item.type, name: item.name, namespace: item.namespace, tool: item.tool })), reply: result.items.filter(item => item.type === 'agentMessage').map(item => item.text.slice(0, 1000)) });
  if (!call) throw new FamiliarUnavailable('Agent 未实际调用 Familiar；仅有文字回复不能通过验证');
  return worldIdentity(call.result);
}
