import { createHash } from 'node:crypto';
import { isId } from '../../foundry-module/shared/protocol.mjs';

export function eventDigest(event) { return createHash('sha256').update(JSON.stringify(event)).digest('hex'); }

export function recordFoundryStatus(state, id, status, turnId = null) {
  if (!Object.hasOwn(state.foundryReceipts ?? {}, id)) return;
  Object.assign(state.foundryReceipts[id], { status, turnId, at: new Date().toISOString() });
}

export function admitFoundryEvent(state, event) {
  if (event.metadata?.source !== 'foundry') return true;
  if (!isId(event.metadata.worldId) || !isId(event.metadata.messageId) ||
      event.id !== `${event.metadata.worldId}:${event.metadata.messageId}`) throw new Error('Foundry 消息必须使用 worldId:messageId');
  state.foundryReceipts ??= {};
  const digest = eventDigest(event);
  const previous = Object.hasOwn(state.foundryReceipts, event.id) ? state.foundryReceipts[event.id] : null;
  if (previous) {
    if (previous.digest !== digest) throw Object.assign(new Error('同一 Foundry 消息 ID 的内容已改变，拒绝重放'), { code: 'EVENT_CONFLICT' });
    return false;
  }
  const receipt = state.receipts.find(item => item.id === event.id);
  state.foundryReceipts[event.id] = { digest, status: receipt?.status ?? (state.inFlight?.event.id === event.id ? 'running' : 'queued'),
    at: new Date().toISOString(), turnId: receipt?.turnId ?? null };
  return true;
}
