import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { configFields, configDefaults } from '../../src/runtime/config-fields.mjs';
import { validatePairing } from '../../foundry-module/shared/protocol.mjs';
import { ConnectionChecks } from '../main/connection-checks.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.FAMILIAR_BRIDGE_PREVIEW_PORT || 3361);
const base = `http://127.0.0.1:${port}`;
const checks = new ConnectionChecks();
let rules = await readFile(join(root, 'agents/dm/AGENTS.md'), 'utf8');
const state = { profile: { directory: '界面演示 · 数据只保存在内存', root: '演示配置', fields: configFields, values: { ...configDefaults } },
  pairing: null, status: { phase: 'stopped', queued: 0, uncertain: 1, healthy: false }, environment: null, busy: null, logs: [], aiResponses: [], models: [], threads: [], notice: '',
  gmMessages: [],
  reviewIssues: [{ id: 'demo-review', at: new Date().toISOString(), turnId: 'demo-turn', resolvedAt: null,
    request: { player: 'Alice', text: '我尝试撬开上锁的箱子。', timestamp: new Date().toISOString(), source: 'foundry' },
    failure: { code: 'DISCONNECTED', message: 'Familiar 连接中断，工具结果无法确认' }, messages: [] }] };
const log = text => { state.logs.push({ id: String(Date.now()), text: `[演示] ${text}` }); state.logs = state.logs.slice(-300); };
const models = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'].map((model, i) => ({ model, displayName: model, hidden: false, isDefault: i === 0, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) }));
const actions = {
  snapshot: () => ({ ...state, connections: checks.snapshot() }),
  saveSettings: values => {
    if (Object.keys(values).some(key => !Object.hasOwn(configDefaults, key))) throw new Error('未知设置');
    for (const field of configFields.filter(field => field.type === 'number')) if (!Number.isInteger(Number(values[field.key])) || Number(values[field.key]) < field.min) throw new Error(`${field.label} 无效`);
    state.profile.values = values; state.environment = null; checks.reset(); log('设置已保存');
  },
  detectCodex: () => { checks.reset(); state.environment = null; state.profile.values.CODEX_COMMAND = '/opt/homebrew/bin/codex'; return state.profile.values.CODEX_COMMAND; },
  checkEnvironment: () => {
    if (state.profile.values.FAMILIAR_MCP_SERVER !== 'familiar') {
      checks.set('codex', 'failed', '演示环境只提供 familiar 服务'); checks.reset(['world', 'push']); throw new Error('演示环境只提供 familiar 服务');
    }
    state.environment = { compatible: true, version: 'codex-cli 0.153.4（演示）', servers: [{ name: 'familiar', enabled: true }] };
    checks.set('codex', 'passed', 'Codex 与 Familiar 服务配置已验证（演示）'); return state.environment;
  },
  models: () => state.models = models,
  threads: () => state.threads = [{ id: '00000000-0000-4000-8000-000000000001', name: '暮色边境 · 演示对话', updatedAt: 0 }],
  start: mode => {
    if (mode === 'foundry' && !state.pairing) throw new Error('请先在连接设置中生成演示配对，或使用手工测试模式');
    checks.reset();
    state.status = { ...state.status, mode, phase: 'running', healthy: true, listening: mode === 'foundry', world: { id: state.pairing?.worldId || 'demo-world', name: '暮色边境 · 演示世界' },
      threadId: state.profile.values.CODEX_THREAD_ID || '00000000-0000-4000-8000-000000000002', model: state.profile.values.CODEX_MODEL || 'gpt-6-astra', reasoningEffort: state.profile.values.CODEX_REASONING_EFFORT || 'medium' }; log('Bridge 已启动，未连接真实游戏');
    checks.observe(state.status);
  },
  stop: () => { state.status.phase = 'stopped'; state.status.healthy = state.status.listening = false; log('Bridge 已停止'); },
  recover: () => { state.status.phase = 'running'; state.status.healthy = true; checks.observe(state.status); },
  doctor: () => {
    actions.checkEnvironment();
    const world = { id: state.pairing?.worldId || 'demo-world', name: '演示世界（未调用真实工具）' };
    checks.worldResult(world, Boolean(state.pairing)); log('演示链路检查通过'); return world;
  },
  sendMessage: text => {
    if (!text?.trim()) throw new Error('请输入请求');
    const id = String(Date.now()), timestamp = new Date().toISOString(), player = state.profile.values.TEST_PLAYER || '玩家';
    state.aiResponses.push({ id: `${id}-chat`, timestamp, player, source: 'foundry', text: '[演示] 你环顾四周，石墙上的火把微微摇晃。\n远处的走廊传来脚步声。你打算怎么做？' },
      { id: `${id}-answer`, timestamp, player, source: 'codex', text: '[演示] 已完成场景观察并等待玩家决定。\n此处仅模拟回答，没有调用 AI 或发送 Foundry Chat。' });
    state.aiResponses = state.aiResponses.slice(-100);
    log('请求已处理（仅模拟，没有发送 Foundry Chat）');
  },
  reviewMessage: ({ id, text }) => {
    if (state.status.phase !== 'running') throw new Error('请先启动 Bridge');
    const issue = state.reviewIssues.find(item => item.id === id);
    if (!issue || issue.resolvedAt) throw new Error('待审核项不存在或已经解决');
    issue.messages.push({ id: `${Date.now()}-gm`, role: 'gm', text, at: new Date().toISOString() },
      { id: `${Date.now()}-ai`, role: 'assistant', text: '[演示] 已读取当前世界：箱子仍为上锁状态，Alice 的物品与资源没有变化；未发现撬锁检定结果。本轮没有执行游戏操作。建议 GM 让玩家重新发起撬锁行动。', at: new Date().toISOString(), turnId: 'demo-review-turn' });
    log('AI 已完成待审核项核对（仅演示）');
  },
  reviewResolved: ({ id, resolved }) => {
    const issue = state.reviewIssues.find(item => item.id === id);
    if (!issue) throw new Error('待审核项不存在');
    issue.resolvedAt = resolved ? new Date().toISOString() : null;
    state.status.uncertain = state.reviewIssues.filter(item => !item.resolvedAt).length;
  },
  gmMessage: text => {
    if (state.status.phase !== 'running') throw new Error('请先启动 Bridge');
    const at = new Date().toISOString();
    state.gmMessages.push({ id: `${Date.now()}-gm`, role: 'gm', text, at },
      { id: `${Date.now()}-ai`, role: 'assistant', text: '[演示] 已读取当前世界并核对冒险进度。当前应使用“废弃礼拜堂”场景；已切换场景并将 Alice 与 Bob 的 Token 重新放到入口区域。本演示没有调用 AI，也没有修改真实 Foundry 世界。', at, turnId: 'demo-gm-turn' });
    log('AI 已完成 GM 要求（仅演示）');
  },
  pairing: value => {
    if (state.pairing && !value.rotate) throw new Error('配对已存在，修改时请勾选重新生成');
    if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('端口应为 1024–65535');
    const pair = validatePairing({ protocol: 1, secret: 'x'.repeat(43), captureSince: Date.now(), worldId: value.worldId, relayUserId: value.relayUserId,
      bridgeUrl: `http://127.0.0.1:${value.port}`, allowedOrigins: value.origins.split('\n').map(s => s.trim()).filter(Boolean) });
    state.pairing = { worldId: pair.worldId, relayUserId: pair.relayUserId, bridgeUrl: pair.bridgeUrl, allowedOrigins: pair.allowedOrigins };
    checks.reset(['world', 'push']); return state.pairing;
  },
  rules: () => rules, saveRules: text => { if (!text?.trim()) throw new Error('规则不能为空'); rules = text; },
  reset: () => { checks.reset(); state.status.threadId = null; state.profile.values.CODEX_THREAD_ID = ''; state.gmMessages = []; return true; },
  choose: () => { throw new Error('目录和文件选择需要在桌面应用中完成；当前只是浏览器界面预览。'); },
  exportModule: () => { throw new Error('请在桌面应用中导出安装包；浏览器预览不会写入本机文件。'); },
  reveal: () => { throw new Error('演示模式不会打开本机文件。'); },
};
const files = ['index.html', 'styles.css', 'theme.css', 'layout.css', 'dashboard.css', 'forms.css', 'app.mjs', 'render.mjs', 'connections.mjs'];
const types = { html: 'text/html', css: 'text/css', mjs: 'text/javascript', js: 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== base)) { res.writeHead(403); res.end(); return; }
    if (req.url === '/api' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 70000) throw new Error('请求过大'); }
      const { method, value } = JSON.parse(raw);
      if (!Object.hasOwn(actions, method)) throw new Error('未知操作');
      const result = await actions[method](value);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, value: result })); return;
    }
    if (req.url === '/preview-api.js') {
      res.setHeader('Content-Type', types.js);
      res.end(`window.bridge={preview:true,onChange:callback=>{const timer=setInterval(callback,500);return()=>clearInterval(timer)}};for(const method of ${JSON.stringify(Object.keys(actions))})window.bridge[method]=async value=>{const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,value})});const data=await response.json();if(!data.ok)throw new Error(data.error);return data.value;};`); return;
    }
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!files.includes(file)) { res.writeHead(404); res.end(); return; }
    let text = await readFile(join(root, 'desktop/renderer', file), 'utf8');
    if (file === 'index.html') text = text.replace('<script type="module"', '<script src="/preview-api.js"></script><script type="module"');
    res.setHeader('Content-Type', `${types[file.split('.').pop()]}; charset=utf-8`); res.end(text);
  } catch (error) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: error.message })); }
});
server.requestTimeout = server.headersTimeout = 10000;
server.listen(port, '127.0.0.1', () => console.log(`界面预览 ${base} · PID=${process.pid} · 仅演示数据，不连接 Codex / Foundry`));
const stop = () => { server.close(); server.closeAllConnections(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
