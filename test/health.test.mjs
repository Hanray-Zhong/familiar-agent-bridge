import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFamiliar, worldIdentity, guardGameItem } from '../src/runtime/familiar-health.mjs';
import { serverArgs } from '../src/codex/policy.mjs';

test('成功工具回执可解析世界，业务错误与伪文字不可通过健康检查', () => {
  assert.deepEqual(worldIdentity({ content: [{ type: 'text', text: '{"world":{"id":"w","name":"世界"}}' }] }), { id: 'w', name: '世界' });
  assert.throws(() => worldIdentity({ isError: true, structuredContent: { name: 'cached' } }));
  assert.throws(() => worldIdentity({ structuredContent: { connected: false, name: 'cached' } }));
  assert.throws(() => worldIdentity({ content: [{ type: 'text', text: '我已经连接 Foundry' }] }));
});

test('健康检查分页发现 Familiar 后实际调用只读工具', async () => {
  const calls = [];
  const codex = { familiarServer: 'familiar', request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'mcpServer/tool/call') return { structuredContent: { world: { id: 'w', name: '世界' } } };
    if (!params.cursor) return { data: [], nextCursor: 'page-2' };
    return { data: [{ name: 'familiar', runtimeStatus: 'connected', tools: { one: { name: 'get-world-info' } } }], nextCursor: null };
  } };
  assert.equal((await checkFamiliar(codex, 'thread')).world.id, 'w');
  assert.equal(calls[2].method, 'mcpServer/tool/call');
  assert.equal(calls[2].params.threadId, 'thread');
});

test('配置隔离保留 Familiar 和路由宿主，关闭本机工具；不把正常 MCP 调用当审批', () => {
  const args = serverArgs([{ name: 'familiar', enabled: true }, { name: 'node_repl', enabled: true }], 'familiar');
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('features.code_mode_host=true'));
  assert.ok(args.includes('mcp_servers.node_repl.enabled=false'));
  assert.ok(args.includes('mcp_servers.familiar.required=true'));
  assert.ok(!args.some(arg => arg.includes('familiar.enabled=false')));
  const item = { type: 'mcpToolCall', server: 'familiar', tool: 'roll-dice', status: 'completed', result: { content: [] } };
  assert.doesNotThrow(() => guardGameItem({ familiarServer: 'familiar' }, item, 'item/completed'));
  assert.throws(() => guardGameItem({ familiarServer: 'familiar' }, { ...item, status: 'failed' }, 'item/completed'), { code: 'FAMILIAR_UNAVAILABLE' });
  assert.throws(() => guardGameItem({}, { type: 'commandExecution' }, 'item/started'), { code: 'SECURITY_VIOLATION' });
});

const failedCheck = { success: false, roll: { total: 14, natural: 11, modifier: 3 }, dc: 15, ability: 'wis', skill: 'prc' };
const checkItem = result => ({ type: 'mcpToolCall', server: 'familiar', tool: 'resolve-ability-check', status: 'completed', result });
const guard = item => guardGameItem({ familiarServer: 'familiar' }, item, 'item/completed');

test('实际检定未通过回执是正常游戏结果，文本/结构化结果与豁免均继续执行', () => {
  for (const tool of ['resolve-ability-check', 'resolve-saving-throw', 'resolve_ability_check', 'resolve_saving_throw']) {
    for (const success of [false, true]) {
      const outcome = { ...failedCheck, success };
      for (const result of [{ content: [{ type: 'text', text: JSON.stringify(outcome) }] }, { structuredContent: outcome }]) {
        assert.doesNotThrow(() => guard({ ...checkItem(result), tool }));
      }
    }
  }
});

test('正常检定字段不能掩盖 MCP 错误、断线或业务错误', () => {
  const item = checkItem({ structuredContent: failedCheck });
  for (const invalid of [
    { ...item, status: 'failed' },
    { ...item, error: { message: '连接中断' } },
    checkItem({ isError: true, structuredContent: failedCheck }),
    ...[{ error: '角色不存在' }, { isError: true }, { connected: false }].map(failure =>
      checkItem({ structuredContent: { ...failedCheck, ...failure } })),
    checkItem({ structuredContent: failedCheck, content: [{ type: 'text', text: '{"error":"连接断开"}' }] }),
  ]) assert.throws(() => guard(invalid), { code: 'FAMILIAR_UNAVAILABLE' });
});

test('缺少有效检定回执或其他工具的 success=false 仍按失败处理，健康检查保持严格', () => {
  for (const outcome of [{ success: false }, { ...failedCheck, roll: null }, { ...failedCheck, dc: null },
    { ...failedCheck, roll: { total: '14' } }]) {
    assert.throws(() => guard(checkItem({ structuredContent: outcome })), { code: 'FAMILIAR_UNAVAILABLE' });
  }
  assert.throws(() => guard({ ...checkItem({ structuredContent: failedCheck }), tool: 'send-chat-message' }), { code: 'FAMILIAR_UNAVAILABLE' });
  assert.throws(() => worldIdentity({ structuredContent: { ...failedCheck, name: '缓存世界' } }), { code: 'FAMILIAR_UNAVAILABLE' });
});
