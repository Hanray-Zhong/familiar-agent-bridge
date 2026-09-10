import { EventEmitter } from 'node:events';

export function normalizeEvent(input) {
  if (!input || input.type !== 'player-message') throw new Error('只接受 player-message 事件');
  for (const [key, limit] of [['id', 256], ['player', 200], ['text', 16000]]) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > limit) throw new Error(`事件 ${key} 为空或超长`);
  }
  if (/[\x00-\x1f\x7f]/.test(input.id)) throw new Error('事件 id 含控制字符');
  if (typeof input.timestamp !== 'string' || !Number.isFinite(Date.parse(input.timestamp))) throw new Error('事件 timestamp 无效');
  const metadata = input.metadata ?? {};
  if (typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 8000) throw new Error('事件 metadata 无效或超长');
  if (metadata.origin === 'familiar' || metadata.origin === 'codex' || metadata.isAgentReply === true) return null;
  return structuredClone({ id: input.id, type: input.type, player: input.player, text: input.text, timestamp: input.timestamp, metadata });
}

export class EventSource extends EventEmitter {
  async start() { throw new Error('EventSource.start 必须由适配器实现'); }
  async stop() { throw new Error('EventSource.stop 必须由适配器实现'); }
  publish(event) {
    const normalized = normalizeEvent(event);
    if (normalized) this.emit('event', normalized);
    return normalized;
  }
}
