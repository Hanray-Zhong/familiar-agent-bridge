import { redact } from '../logger.mjs';
import { resultFailed } from '../familiar-health.mjs';

const maxResponseLength = 64000;

function responseContent(item, familiarServer) {
  if (item.type === 'agentMessage' && (item.phase == null || item.phase === 'final_answer')) {
    return { source: 'codex', text: item.text };
  }
  if (item.type === 'mcpToolCall' && item.server === familiarServer && item.tool?.replaceAll('_', '-') === 'send-chat-message' &&
      item.status === 'completed' && item.result && !item.error && !resultFailed(item.result, { tool: item.tool })) {
    return { source: 'foundry', text: item.arguments?.content };
  }
  return null;
}

// 只收集当前玩家请求的完整回答；逐项通知和 Turn 汇总使用同一份去重记录。
export function createResponseCollector({ event, threadId, familiarServer }, publish) {
  const seen = new Set();
  return (item, method = 'item/completed') => {
    if (method !== 'item/completed' || !item?.id || seen.has(item.id)) return;
    const response = responseContent(item, familiarServer);
    if (typeof response?.text !== 'string' || !response.text.trim()) return;
    const cleaned = response.text.split(/\r\n|\r|\n/).map(line => redact(line)).join('\n');
    const text = cleaned.length > maxResponseLength ? `${cleaned.slice(0, maxResponseLength)}\n[回答过长，已截断]` : cleaned;
    seen.add(item.id);
    publish({ id: item.id, eventId: event.id, threadId, player: redact(event.player),
      timestamp: new Date().toISOString(), source: response.source, text });
  };
}
