import { renderConnections } from './connections.mjs';
export const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const phases = { stopped: '尚未启动', starting: '正在连接', checking: '只读检查中', running: '正在运行', paused: '等待恢复', stopping: '正在停止' };
const conversationSignatures = new WeakMap();

export function buildFields(fields) {
  for (const field of fields.filter(field => field.group !== 'agent')) {
    const label = document.createElement('label'); label.textContent = field.label;
    const input = document.createElement(field.type === 'select' ? 'select' : 'input');
    input.dataset.config = field.key;
    if (field.type === 'select') for (const value of ['info', 'debug', 'warn', 'error']) input.add(new Option(value, value));
    else input.type = field.type;
    if (field.min !== undefined) { input.min = field.min; input.max = field.max; input.step = 1; }
    const hint = document.createElement('small'); hint.textContent = field.hint;
    let container = label;
    if (field.key === 'CODEX_COMMAND') {
      input.id = 'codex-command'; label.htmlFor = input.id;
      hint.className = 'hint';
      const row = document.createElement('div'); row.className = 'codex-program-row';
      row.append(input, $('codex-program-actions'));
      container = document.createElement('div'); container.append(label, row, hint);
    } else label.append(input, hint);
    $(field.group === 'connection' ? 'connection-fields' : 'advanced-fields').append(container);
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
  const { status, profile, busy, pairing } = state;
  const phase = status.phase || 'stopped', active = phase !== 'stopped';
  $('preview-badge').hidden = !globalThis.bridge.preview;
  $('status-badge').className = `status-badge ${phase}`;
  $('status-badge').querySelector('span').textContent = phases[phase] || phase;
  $('operation').hidden = !busy;
  text('operation-text', busy ? `${busy}…` : '');
  $('notice').hidden = !state.notice; text('notice', state.notice || '');
  text('service-hint', { stopped: '准备好后，启动本场跑团。', starting: '正在检查 Codex 与世界连接。', checking: '本次检查只读取世界，不发送聊天。',
    running: '已就绪，玩家请求将按顺序处理。', paused: status.pauseReason || '队列已暂停；核对原因后恢复连接。', stopping: '正在停止服务并保存尚未处理的请求。' }[phase]);
  renderConnections(state);
  text('world-name', status.world?.name || '等待你的世界');
  text('world-subtitle', status.world?.id ? `世界 · ${status.world.id}` : '启动后读取当前 Foundry 世界，继续上次的故事。');
  text('current-model', status.model || profile.values.CODEX_MODEL || '跟随 Codex 设置');
  text('current-effort', status.reasoningEffort || profile.values.CODEX_REASONING_EFFORT || '跟随 Codex 设置');
  text('current-thread', status.threadId || profile.values.CODEX_THREAD_ID || '启动后创建或恢复');
  text('queued', status.queued ?? 0); text('active', status.inFlight ? '1' : '—'); text('uncertain', status.uncertain ?? 0);
  text('review-entry-count', status.uncertain ?? 0); $('review-entry-count').classList.toggle('has-items', status.uncertain > 0);
  $('review-banner').classList.toggle('has-items', status.uncertain > 0);
  text('review-banner-title', status.uncertain > 0 ? `${status.uncertain} 项结果需要核对` : '当前没有待审核结果');
  text('review-banner-hint', status.uncertain > 0 ? '打开审核记录，与 AI 确认已执行的操作和下一步。' : '可查看历史审核记录，或重新打开需要继续核对的项目。');
  text('review-open-count', `${status.uncertain ?? 0} 项待处理`);
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
  for (const button of document.querySelectorAll('.save-settings, #detect-codex, #choose-codex, #check-environment, #import-project, #export-module, #save-pairing, #import-pairing, #load-models, #load-threads, #reset-session, #save-rules, [data-test-connection]')) button.disabled = active || Boolean(busy);
  $('test-world').disabled = active || Boolean(busy) || !pairing;
  $('reveal-pairing').disabled = !pairing;
}

function displayTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function renderConversationMessages(id, entries, emptyText, context) {
  const messages = $(id);
  const signature = JSON.stringify([context, entries]);
  if (conversationSignatures.get(messages) === signature) return;
  conversationSignatures.set(messages, signature);
  messages.replaceChildren();
  if (!entries.length) {
    const hint = document.createElement('p'); hint.className = 'review-message-hint'; hint.textContent = emptyText; messages.append(hint);
  } else for (const message of entries) {
    const role = ['gm', 'assistant', 'system'].includes(message.role) ? message.role : 'system';
    const article = document.createElement('article'); article.className = `review-message ${role}`;
    const meta = document.createElement('span'); meta.textContent = `${{ gm: 'GM', assistant: 'AI DM', system: 'Bridge' }[role]} · ${displayTime(message.at)}`;
    const body = document.createElement('p'); body.textContent = message.text;
    article.append(meta, body); messages.append(article);
  }
  messages.scrollTop = messages.scrollHeight;
}

export function renderGmConversation(state) {
  text('gm-world', state.status.world?.name || '尚未连接世界');
  text('gm-thread', state.status.threadId || '尚未连接对话');
  renderConversationMessages('gm-messages', state.gmMessages ?? [], '启动 Bridge 后，可以直接告诉 AI 需要核对或调整什么。', 'gm');
  const available = state.status.phase === 'running' && state.status.healthy === true && !state.busy;
  $('gm-message').disabled = !available; $('gm-send').disabled = !available;
  $('gm-message').placeholder = available ? '例如：当前场景切换错了。请先核对冒险进度，再切回正确场景，并重新布置应在场的 Token。' :
    '启动并恢复 Bridge 后，可以向 AI 下达 GM 要求。';
}

export function renderReviews(state, selectedId, onSelect) {
  const issues = [...(state.reviewIssues ?? [])].sort((left, right) =>
    Number(Boolean(left.resolvedAt)) - Number(Boolean(right.resolvedAt)) || String(right.at).localeCompare(String(left.at)));
  const list = $('review-list'); list.replaceChildren();
  if (!issues.length) {
    const empty = document.createElement('p'); empty.className = 'empty-text'; empty.textContent = '目前没有待审核记录。'; list.append(empty);
    $('review-empty').hidden = false; $('review-detail').hidden = true;
    return null;
  }
  const selected = issues.find(issue => issue.id === selectedId) ?? issues.find(issue => !issue.resolvedAt) ?? issues[0];
  for (const issue of issues) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'review-item';
    button.classList.toggle('selected', issue.id === selected.id); button.classList.toggle('resolved', Boolean(issue.resolvedAt));
    const heading = document.createElement('span'); heading.className = 'review-item-heading';
    const player = document.createElement('strong'); player.textContent = issue.request?.player || '旧版请求';
    const badge = document.createElement('em'); badge.textContent = issue.resolvedAt ? '已解决' : '待处理';
    const request = document.createElement('span'); request.textContent = issue.request?.text || `请求 ${issue.id}`;
    const time = document.createElement('small'); time.textContent = displayTime(issue.at);
    heading.append(player, badge); button.append(heading, request, time);
    button.addEventListener('click', () => onSelect(issue.id)); list.append(button);
  }
  $('review-empty').hidden = true; $('review-detail').hidden = false;
  text('review-state', selected.resolvedAt ? '已解决' : '待处理');
  $('review-state').classList.toggle('resolved', Boolean(selected.resolvedAt));
  text('review-title', selected.request?.player ? `${selected.request.player} 的请求` : `旧版请求 ${selected.id}`);
  text('review-request', selected.request ? `${displayTime(selected.request.timestamp)}\n${selected.request.text}` : '旧版状态未保存原请求正文；AI 会根据同一跑团对话和当前世界尽量核对。');
  text('review-failure', selected.failure ? `${selected.failure.code || 'TURN_FAILED'} · ${selected.failure.message || '没有错误详情'}` : '旧版状态未保存失败详情。');
  renderConversationMessages('review-messages', selected.messages, '还没有审核对话。可以先让 AI 核对原请求是否已经生效。', selected.id);
  const available = state.status.phase === 'running' && state.status.healthy === true && !state.busy && !selected.resolvedAt;
  $('review-message').disabled = !available; $('review-send').disabled = !available;
  $('review-message').placeholder = selected.resolvedAt ? '该记录已解决；重新打开后可以继续对话。' :
    state.status.phase !== 'running' ? '启动并恢复 Bridge 后，可以让 AI 读取当前世界进行核对。' :
      '例如：请读取当前角色资源和最近聊天，确认刚才的检定与消耗是否已经生效。';
  $('review-resolve').disabled = Boolean(state.busy);
  text('review-resolve', selected.resolvedAt ? '重新打开' : '标记为已解决');
  return selected.id;
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
