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
