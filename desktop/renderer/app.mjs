import { $, buildFields, fillSettings, fillPairing, formValues, render, modelOptions, effortOptions, renderThreads } from './render.mjs';
const api = globalThis.bridge;
let state, built = false, dirty = false, pairDirty = false, rulesDirty = false, rulesLoaded = false, refreshing, pendingRefresh = false;
let lastProfile, lastPairing, lastModels, lastThreads, toastTimer;
const pages = { overview: ['跑团控制台', '连接你的世界，让每一次冒险有序展开。'], connection: ['连接设置', '关联已有环境，完成世界与中继 GM 的配对。'],
  agent: ['对话与模型', '为这一场冒险选择合适的 AI DM。'], rules: ['主持规则', '把桌规和叙事偏好，交给你的 AI 主持。'], help: ['使用帮助', '几步准备，让故事开始。'] };

function toast(message, error = false) {
  clearTimeout(toastTimer); $('toast').hidden = false; $('toast').classList.toggle('error', error); $('toast').textContent = message;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 4000);
}
function markDirty() { dirty = true; $('page-title').classList.add('is-dirty'); }
function selectThread(id) { $('thread-id').value = id; markDirty(); renderThreads(state, selectThread); }

async function refresh() {
  if (refreshing) { pendingRefresh = true; return refreshing; }
  refreshing = (async () => {
    state = await api.snapshot();
    if (!built) {
      buildFields(state.profile.fields); built = true;
      for (const input of document.querySelectorAll('[data-config]')) input.addEventListener('input', markDirty);
    }
    const signature = JSON.stringify(state.profile.values);
    if (!dirty && signature !== lastProfile) { fillSettings(state); lastProfile = signature; }
    const modelsSignature = JSON.stringify(state.models);
    if (modelsSignature !== lastModels) { modelOptions(state, formValues(state)); lastModels = modelsSignature; }
    const pairingSignature = JSON.stringify(state.pairing);
    if (!pairDirty && pairingSignature !== lastPairing) { fillPairing(state.pairing); lastPairing = pairingSignature; }
    render(state);
    const threadsSignature = JSON.stringify([state.threads, state.busy, state.status.phase]);
    if (threadsSignature !== lastThreads) { renderThreads(state, selectThread); lastThreads = threadsSignature; }
  })();
  try { await refreshing; }
  catch (error) { $('notice').hidden = false; $('notice').textContent = error.message; }
  finally { refreshing = null; if (pendingRefresh) { pendingRefresh = false; void refresh(); } }
}

async function act(operation, success) {
  try { const result = await operation(); if (success && result !== null) toast(success); return result; }
  catch (error) { toast(error.message, true); }
  finally { await refresh(); }
}

async function navigate(page) {
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== `page-${page}`;
  for (const button of document.querySelectorAll('.nav-item')) button.classList.toggle('active', button.dataset.page === page);
  $('page-title').textContent = pages[page][0]; $('page-description').textContent = pages[page][1];
  window.scrollTo(0, 0);
  if (page === 'rules' && !rulesLoaded) await act(async () => { $('rules-editor').value = await api.rules(); rulesLoaded = true; });
}

for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => { void navigate(button.dataset.page); });
for (const button of document.querySelectorAll('.save-settings')) button.addEventListener('click', () => act(async () => {
  const values = formValues(state);
  await api.saveSettings(values); dirty = false; lastProfile = null; $('page-title').classList.remove('is-dirty'); rulesLoaded = false;
}, '设置已保存，下一次启动使用新设置。'));
$('model').addEventListener('change', () => { effortOptions(state, $('model').value, ''); markDirty(); });
$('start').addEventListener('click', () => act(async () => {
  if (dirty || rulesDirty || pairDirty) throw new Error('还有未保存的设置，请先保存或重新打开应用后再启动。');
  await api.start($('mode').value);
}));
$('stop').addEventListener('click', () => act(() => api.stop(), 'Bridge 已停止，待办已保存。'));
$('recover').addEventListener('click', () => act(() => api.recover()));
$('doctor').addEventListener('click', () => act(async () => {
  const result = await api.doctor(); if (result) toast(`只读验证通过：${result.name}`);
}));
$('detect-codex').addEventListener('click', () => act(async () => { const command = await api.detectCodex(); document.querySelector('[data-config="CODEX_COMMAND"]').value = command; lastProfile = null; }, '已找到并保存 Codex 程序路径。'));
$('choose-codex').addEventListener('click', () => act(async () => { const result = await api.choose('codex'); if (result) { document.querySelector('[data-config="CODEX_COMMAND"]').value = result; lastProfile = null; } return result; }));
$('check-environment').addEventListener('click', () => act(async () => {
  if (dirty) throw new Error('请先保存 Bridge 设置，再检查连接。');
  await api.checkEnvironment();
}, 'Codex 版本与 Familiar 服务配置正常。'));
$('import-project').addEventListener('click', () => act(async () => {
  const result = await api.choose('project');
  if (result) { dirty = pairDirty = rulesDirty = rulesLoaded = false; lastProfile = lastPairing = null; $('page-title').classList.remove('is-dirty'); }
  return result;
}, '已接管原项目配置；请核对连接和对话后启动。'));
$('export-module').addEventListener('click', () => act(() => api.exportModule(), '安装包已保存。解压后将模块文件夹放入 Foundry 的 Data/modules。'));
$('import-pairing').addEventListener('click', () => act(async () => {
  const result = await api.choose('pairing'); if (result) { pairDirty = false; document.querySelector('[data-config="FOUNDRY_PUSH_CONFIG"]').value = result; lastProfile = lastPairing = null; } return result;
}, '已选择已有配对文件。'));
for (const input of document.querySelectorAll('#pairing-form input, #pairing-form textarea')) input.addEventListener('input', () => { pairDirty = true; });
$('pairing-form').addEventListener('submit', event => { event.preventDefault(); void act(async () => {
  if (dirty) throw new Error('请先保存 Bridge 设置，再生成配对。');
  const result = await api.pairing({ worldId: $('world-id').value, relayUserId: $('gm-id').value, port: Number($('port').value), origins: $('origins').value, rotate: $('rotate').checked });
  if (result) { pairDirty = false; lastPairing = null; $('rotate').checked = false; } return result;
}, '配对已生成；请在 Foundry 中导入并保存启用。'); });
$('reveal-pairing').addEventListener('click', () => act(() => api.reveal('pairing')));
$('load-models').addEventListener('click', () => act(() => api.models(), '可用模型列表已更新。'));
$('load-threads').addEventListener('click', () => act(() => api.threads({ search: $('thread-search').value })));
$('reset-session').addEventListener('click', () => act(async () => { if (await api.reset()) { $('thread-id').value = ''; lastProfile = null; } }));
$('rules-editor').addEventListener('input', () => { rulesDirty = true; $('page-title').classList.add('is-dirty'); });
$('save-rules').addEventListener('click', () => act(async () => {
  await api.saveRules($('rules-editor').value); rulesDirty = false; $('page-title').classList.toggle('is-dirty', dirty);
}, '主持规则已保存，下一次启动生效。'));
$('message-form').addEventListener('submit', event => { event.preventDefault(); void act(async () => {
  await api.sendMessage($('message').value); $('message').value = '';
}, '请求已进入队列。'); });
$('open-manual').addEventListener('click', () => act(() => api.reveal('manual')));
$('open-data').addEventListener('click', () => act(() => api.reveal('data')));

if (!api) { $('notice').hidden = false; $('notice').textContent = '桌面接口未加载，请重新启动应用。'; $('start').disabled = true; }
else { await refresh(); api.onChange(() => { void refresh(); }); }
