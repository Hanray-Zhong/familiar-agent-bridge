import { MODULE_ID, isId } from '../shared/protocol.mjs';

export const REQUEST_STATUS_FLAG = 'requestStatus';
export const ACTIVE_REQUEST_STATUSES = new Set(['sending', 'queued', 'running']);
export const STATUS_STALE_MS = 60000;

// 只写原消息的模块 flag；由 Foundry 同步给各客户端，不发送额外聊天。
export function createStatusPublisher({ game, clock = Date.now }) {
  return async (id, status) => {
    const [worldId, messageId, extra] = id.split(':');
    if (extra || worldId !== game.world.id || !isId(messageId) || !game.user.isGM ||
        game.user.id !== game.settings.get(MODULE_ID, 'relayUserId')) return;
    const message = game.messages.get(messageId);
    if (!message) return;
    const previous = message.flags?.[MODULE_ID]?.[REQUEST_STATUS_FLAG];
    const updatedAt = clock();
    if (previous?.status === status && previous.relayUserId === game.user.id &&
        (!ACTIVE_REQUEST_STATUSES.has(status) || updatedAt - previous.updatedAt < 30000)) return;
    let timer;
    try {
      await Promise.race([
        message.setFlag(MODULE_ID, REQUEST_STATUS_FLAG, { status, updatedAt, relayUserId: game.user.id }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('回答状态同步超时')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
}
