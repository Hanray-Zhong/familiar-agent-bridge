export const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const phases = { stopped: '尚未启动', starting: '正在连接', checking: '只读检查中', running: '正在运行', paused: '等待恢复', stopping: '正在停止' };

export function buildFields(fields) {
  for (const field of fields.filter(field => field.group !== 'agent')) {
    const label = document.createElement('label'); label.textContent = field.label;
    const input = document.createElement(field.type === 'select' ? 'select' : 'input');
    input.dataset.config = field.key;
    if (field.type === 'select') for (const value of ['info', 'debug', 'warn', 'error']) input.add(new Option(value, value));
    else input.type = field.type;
    if (field.min !== undefined) { input.min = field.min; input.max = field.max; input.step = 1; }
    const hint = document.createElement('small'); hint.textContent = field.hint;
    label.append(input, hint);
    $(field.group === 'connection' ? 'connection-fields' : 'advanced-fields').append(label);
  }
}

function options(select, entries, selected, fallback) {
  select.replaceChildren(new Option(fallback, ''));
  for (const [value, name] of entries) select.add(new Option(name, value));
  if (selected && !entries.some(([value]) => value === selected)) select.add(new Option(`${selected}（当前配置）`, selected));
  select.value = selected || '';
}

export function modelOptions(state, values) {
  options($('model'), state.models.filter(model => !model.hidden || model.model === values.CODEX_MODEL).map(model => [model.model, model.displayName || model.model]), values.CODEX_MODEL, '跟随 Codex 设置');
  effortOptions(state, values.CODEX_MODEL, values.CODEX_REASONING_EFFORT);
}
export function effortOptions(state, model, effort) {
  const selected = state.models.find(entry => entry.model === model) || state.models.find(entry => entry.isDefault);
  options($('effort'), (selected?.supportedReasoningEfforts || []).map(option => [option.reasoningEffort, option.reasoningEffort]), effort, '跟随 Codex 设置');
}

export function fillSettings(state) {
  modelOptions(state, state.profile.values);
  for (const input of document.querySelectorAll('[data-config]')) input.value = state.profile.values[input.dataset.config] ?? '';
}
export function formValues(state) {
  const values = { ...state.profile.values };
  for (const input of document.querySelectorAll('[data-config]')) values[input.dataset.config] = input.value;
  return values;
}
export function fillPairing(pairing) {
  if (!pairing) return;
  $('world-id').value = pairing.worldId;
  $('gm-id').value = pairing.relayUserId;
  $('port').value = new URL(pairing.bridgeUrl).port;
  $('origins').value = pairing.allowedOrigins.join('\n');
}

export function scrollLogsToBottom(ids = ['logs', 'ai-responses']) {
  for (const id of ids) {
    const panel = $(id);
    if (!panel.hidden) panel.scrollTop = panel.scrollHeight;
  }
}

export function selectLogTab(panelId) {
  if (!['logs', 'ai-responses'].includes(panelId)) return;
  for (const [id, panel] of [['system-log-tab', 'logs'], ['ai-log-tab', 'ai-responses']]) {
    const selected = panel === panelId;
    $(id).setAttribute('aria-selected', String(selected));
    $(id).tabIndex = selected ? 0 : -1;
    $(panel).hidden = !selected;
  }
  scrollLogsToBottom();
}

function renderLogText(id, content) {
  if ($(id).textContent === content) return;
  text(id, content);
  scrollLogsToBottom([id]);
}

function renderLogs(lines, responses) {
  renderLogText('logs', lines.length ? lines.map(line => line.text).join('\n') : '启动或检查连接后，日志会显示在这里。');
  renderLogText('ai-responses', responses.length ? responses.map(response => {
    const source = response.source === 'foundry' ? 'Foundry 聊天' : 'Codex 回答';
    return `${response.timestamp} · ${response.player} · ${source}\n${response.text}`;
  }).join('\n\n──────────\n\n') : '处理玩家请求后，AI 的实际回答会显示在这里。');
}

export function render(state) {
  const { status, profile, busy, environment, pairing } = state;
  const phase = status.phase || 'stopped', active = phase !== 'stopped';
  const healthy = status.healthy === true;
  $('preview-badge').hidden = !globalThis.bridge.preview;
  $('status-badge').className = `status-badge ${phase}`;
  $('status-badge').querySelector('span').textContent = phases[phase] || phase;
  $('operation').hidden = !busy;
  text('operation-text', busy ? `${busy}…` : '');
  $('notice').hidden = !state.notice; text('notice', state.notice || '');
  text('service-hint', { stopped: '准备好后，启动本场跑团。', starting: '正在检查 Codex 与世界连接。', checking: '本次检查只读取世界，不发送聊天。',
    running: '已就绪，玩家请求将按顺序处理。', paused: status.pauseReason || '队列已暂停；核对原因后恢复连接。', stopping: '正在停止服务并保存尚未处理的请求。' }[phase]);
  const cliReady = environment?.compatible || healthy;
  text('codex-state', environment?.version || (healthy ? '已连接' : '等待检查'));
  text('world-state', healthy ? status.world?.name || '世界已连接' : '尚未连接世界');
  text('push-state', status.listening ? '已监听 @familiar 推送' : phase === 'running' ? '手工测试模式' : '等待开启推送');
  for (const [id, ok] of [['codex-dot', cliReady], ['world-dot', healthy], ['push-dot', status.listening]]) $(id).classList.toggle('ok', Boolean(ok));
  text('check-cli', cliReady ? '✓' : '1'); text('check-pair', pairing ? '✓' : '2');
  text('world-name', status.world?.name || '等待你的世界');
  text('world-subtitle', status.world?.id ? `世界 · ${status.world.id}` : '启动后读取当前 Foundry 世界，继续上次的故事。');
  text('current-model', status.model || profile.values.CODEX_MODEL || '跟随 Codex 设置');
  text('current-effort', status.reasoningEffort || profile.values.CODEX_REASONING_EFFORT || '跟随 Codex 设置');
  text('current-thread', status.threadId || profile.values.CODEX_THREAD_ID || '启动后创建或恢复');
  text('queued', status.queued ?? 0); text('active', status.inFlight ? '1' : '—'); text('uncertain', status.uncertain ?? 0);
  text('pairing-badge', pairing ? '已生成配对' : '未配对');
  text('module-path', state.modulePackage?.path || '选择保存位置后生成 ZIP 安装包');
  text('help-data-path', `应用设置：${profile.directory}\n跑团数据：${state.paths?.state || profile.root}`);
  text('rules-path', state.paths?.rules || profile.values.DM_INSTRUCTIONS_FILE);
  renderLogs(state.logs, state.aiResponses ?? []);
  $('start').disabled = active || Boolean(busy);
  $('stop').disabled = !active || phase === 'stopping';
  $('recover').disabled = phase !== 'paused' || Boolean(busy);
  $('mode').disabled = active || Boolean(busy);
  $('send').disabled = !['running', 'paused'].includes(phase);
  for (const input of document.querySelectorAll('[data-config], #pairing-form input, #pairing-form textarea, #rules-editor')) input.disabled = active || Boolean(busy);
  for (const button of document.querySelectorAll('.save-settings, #detect-codex, #choose-codex, #check-environment, #import-project, #export-module, #save-pairing, #import-pairing, #load-models, #load-threads, #reset-session, #save-rules, #doctor')) button.disabled = active || Boolean(busy);
  $('reveal-pairing').disabled = !pairing;
}

export function renderThreads(state, onSelect) {
  const list = $('thread-list'); list.replaceChildren();
  if (!state.threads.length) { const empty = document.createElement('p'); empty.className = 'empty-text'; empty.textContent = '没有可显示的对话。可更改关键词后查询，或留空自动创建。'; list.append(empty); return; }
  for (const thread of state.threads) {
    const button = document.createElement('button'); button.className = 'thread-option'; button.type = 'button';
    button.disabled = Boolean(state.busy) || state.status.phase !== 'stopped';
    button.classList.toggle('selected', $('thread-id').value === thread.id);
    const title = document.createElement('strong'); title.textContent = thread.name;
    const id = document.createElement('small'); id.textContent = thread.id;
    button.append(title, id); button.addEventListener('click', () => onSelect(thread.id)); list.append(button);
  }
}
