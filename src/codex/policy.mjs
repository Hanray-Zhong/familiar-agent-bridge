export const disabledFeatures = [
  'shell_tool', 'unified_exec', 'shell_snapshot',
  'apps', 'plugins', 'browser_use', 'computer_use', 'in_app_browser',
  'multi_agent', 'multi_agent_v2', 'hooks', 'image_generation', 'view_image',
  'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install',
  'request_permissions_tool', 'memories',
];

export function serverArgs(servers, familiarServer, { readOnlyProbe = false } = {}) {
  if (servers.some(server => !/^[A-Za-z0-9_-]+$/.test(server.name))) {
    throw new Error('MCP 名称含不支持的配置路径字符，无法安全隔离服务');
  }
  if (!servers.some(server => server.name === familiarServer && server.enabled)) {
    throw new Error(`Codex 配置中未启用 ${familiarServer}，请由管理员检查 codex mcp list`);
  }
  const overrides = [
    'sandbox_mode="read-only"', 'approval_policy="never"', 'approvals_reviewer="user"',
    'web_search="disabled"', 'agents.enabled=false',
    'notify=[]',
    'project_doc_max_bytes=0',
    'features.code_mode_host=true',
    ...disabledFeatures.map(name => `features.${name}=false`),
    ...servers.filter(server => server.name !== familiarServer)
      .map(server => `mcp_servers.${server.name}.enabled=false`),
    `mcp_servers.${familiarServer}.required=true`,
    ...(readOnlyProbe ? [`mcp_servers.${familiarServer}.enabled_tools=["get-world-info"]`] : []),
  ];
  return ['app-server', '--listen', 'stdio://', ...overrides.flatMap(value => ['-c', value])];
}

export function threadOptions(cwd, instructions) {
  return { cwd, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
    config: { project_doc_max_bytes: 0 }, developerInstructions: instructions };
}

export const turnPolicy = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
