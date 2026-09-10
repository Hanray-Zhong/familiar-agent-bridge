import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels, validateModelSelection } from '../src/codex/catalog.mjs';
import { CodexAppServer } from '../src/codex-app-server.mjs';
import { threadOptions } from '../src/codex/policy.mjs';

const model = { model: 'test-model', supportedReasoningEfforts: ['low', 'high', 'future-effort'].map(reasoningEffort => ({ reasoningEffort })) };

test('模型目录遍历分页并拒绝循环游标', async () => {
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [model], nextCursor: null } : { data: [], nextCursor: 'second' };
  } };
  assert.deepEqual(await listModels(client), [model]);
  assert.ok(calls.every(call => call.method === 'model/list' && call.params.includeHidden));
  assert.equal(calls[1].params.cursor, 'second');
  await assert.rejects(listModels({ request: async () => ({ data: [], nextCursor: 'loop' }) }), /分页异常/);
});

test('model 与 effort 以具体模型目录为准，不静默降级或固定枚举', () => {
  validateModelSelection([model], { model: model.model, reasoningEffort: 'future-effort' });
  assert.throws(() => validateModelSelection([model], { model: 'unknown' }), { code: 'MODEL_CONFIGURATION' });
  assert.throws(() => validateModelSelection([model], { model: model.model, reasoningEffort: 'medium' }), /不支持/);
});

test('新建与恢复都写入真实协议字段，并保留只读权限和长期指令', async () => {
  const client = new CodexAppServer({ model: model.model, reasoningEffort: 'high' });
  client.models = [model];
  const calls = [];
  const response = { thread: { id: 'existing-thread' }, model: model.model, reasoningEffort: 'high' };
  client.request = async (method, params) => { calls.push({ method, params }); return response; };
  const options = threadOptions('/tmp', '长期指令');
  await client.startThread(options);
  await client.resumeThread('existing-thread', options);
  assert.deepEqual(calls.map(call => call.method), ['thread/start', 'thread/resume']);
  for (const { params } of calls) {
    assert.equal(params.model, model.model);
    assert.deepEqual(params.config, { project_doc_max_bytes: 0, model_reasoning_effort: 'high' });
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.developerInstructions, '长期指令');
  }
  assert.equal(calls[1].params.threadId, 'existing-thread');
  response.reasoningEffort = 'low';
  await assert.rejects(client.resumeThread('existing-thread', options), /未应用/);
});

test('只设 effort 按恢复后的实际模型验证；不设两项时不覆盖 Codex 默认', async () => {
  const client = new CodexAppServer({ reasoningEffort: 'high' });
  client.models = [model];
  client.request = async () => ({ model: model.model, reasoningEffort: 'high', thread: { id: 'x' } });
  await client.resumeThread('x');
  client.request = async () => ({ model: 'another-model', reasoningEffort: 'high', thread: { id: 'x' } });
  await assert.rejects(client.resumeThread('x'), { code: 'MODEL_CONFIGURATION' });
  client.request = async () => ({ reasoningEffort: 'high', thread: { id: 'x' } });
  await assert.rejects(client.resumeThread('x'), /未返回实际模型/);
  const unset = new CodexAppServer();
  unset.request = async (_method, params) => {
    assert.ok(!Object.hasOwn(params, 'model'));
    assert.ok(!Object.hasOwn(params, 'config'));
    return { thread: { id: 'x' } };
  };
  await unset.startThread();
});

test('每个 Turn 使用指定 model / effort，审批策略保持拒绝', async () => {
  const client = new CodexAppServer({ model: model.model, reasoningEffort: 'high' });
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    client.emit('notification', { method: 'turn/completed', params: { threadId: 'x', turn: { id: 't', status: 'completed', items: [] } } });
    return { turn: { id: 't' } };
  };
  await client.runTurn('x', '测试请求');
  const { params } = requests[0];
  assert.equal(params.model, model.model);
  assert.equal(params.effort, 'high');
  assert.ok(!Object.hasOwn(params, 'reasoningEffort'));
  assert.equal(params.approvalPolicy, 'never');
  assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
});
