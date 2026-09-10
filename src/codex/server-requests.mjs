// 根据 codex-cli 0.153.4 generate-ts --experimental 的 ServerRequest/Response。
export function serverRequestReply(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: { denied: { rejection: 'Bridge 禁止本机命令和文件修改。' } } } };
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } };
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null, _meta: null } };
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } };
    case 'item/tool/call':
      return { result: { success: false, contentItems: [{ type: 'inputText', text: 'Bridge 未注册动态工具。' }] } };
    default:
      return { error: { code: -32601, message: 'Client method is not supported by this bridge' } };
  }
}
