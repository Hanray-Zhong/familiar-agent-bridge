import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults } from './config-fields.mjs';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function loadConfig(settings = {}, { root = projectRoot } = {}) {
  const values = { ...configDefaults, ...settings };
  const optional = key => values[key]?.trim() || undefined;
  const threadId = optional('CODEX_THREAD_ID');
  const model = optional('CODEX_MODEL');
  const reasoningEffort = optional('CODEX_REASONING_EFFORT');
  if (threadId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) throw new Error('CODEX_THREAD_ID 必须是 Codex 对话 ID（UUID），不能填写标题或网址');
  if (model && (model.length > 200 || /\s|[\x00-\x1f\x7f]/u.test(model))) throw new Error('CODEX_MODEL 必须是模型标识符；请在“对话与模型”刷新可用模型');
  if (reasoningEffort && !/^[a-z][a-z0-9_-]{0,63}$/.test(reasoningEffort)) throw new Error('CODEX_REASONING_EFFORT 必须是小写 effort 标识符；请在“对话与模型”选择可用值');
  const positive = (key, fallback, minimum = 1) => {
    const value = Number(values[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) throw new Error(`${key} 必须是 >= ${minimum} 的有效整数`);
    return value;
  };
  const cwd = await realpath(resolve(root, values.CODEX_CWD || '.'));
  const instructionsFile = resolve(root, values.DM_INSTRUCTIONS_FILE || configDefaults.DM_INSTRUCTIONS_FILE);
  const canonical = async path => { try { return await realpath(path); } catch (error) { if (error.code === 'ENOENT') return path; throw error; } };
  const [dmPath, developmentPath] = await Promise.all([canonical(instructionsFile), canonical(resolve(root, 'AGENTS.md'))]);
  if (dmPath === developmentPath) throw new Error('DM_INSTRUCTIONS_FILE 不能指向开发用的根 AGENTS.md，请使用独立的跑团规则');
  if (!['debug', 'info', 'warn', 'error'].includes(values.LOG_LEVEL || 'info')) throw new Error('LOG_LEVEL 必须是 debug、info、warn 或 error');
  return {
    command: values.CODEX_COMMAND || 'codex', cwd,
    threadId: threadId?.toLowerCase(), model, reasoningEffort,
    stateFile: resolve(root, values.STATE_FILE || './data/state.json'),
    lockFile: resolve(root, 'data/bridge.lock'),
    instructionsFile,
    foundryPairingFile: resolve(root, values.FOUNDRY_PUSH_CONFIG || './data/foundry-push.json'),
    familiarServer: values.FAMILIAR_MCP_SERVER || 'familiar',
    player: values.TEST_PLAYER || '玩家',
    logLevel: values.LOG_LEVEL || 'info',
    turnTimeoutMs: positive('CODEX_TURN_TIMEOUT_MS', 300000),
    requestTimeoutMs: positive('CODEX_REQUEST_TIMEOUT_MS', 30000),
    healthTimeoutMs: positive('FAMILIAR_HEALTH_TIMEOUT_MS', 30000),
    healthIntervalMs: positive('FAMILIAR_HEALTH_INTERVAL_MS', 30000, 100),
    shutdownTimeoutMs: positive('BRIDGE_SHUTDOWN_TIMEOUT_MS', 15000),
    maxRestarts: positive('CODEX_MAX_RESTARTS', 3, 0),
    queueLimit: positive('BRIDGE_QUEUE_LIMIT', 1000),
  };
}
