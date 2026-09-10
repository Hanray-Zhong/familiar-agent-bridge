import { normalizeEvent } from '../event-source/base.mjs';
import { isId, PROTOCOL_VERSION } from '../../foundry-module/shared/protocol.mjs';
import { HttpFailure } from './auth.mjs';

const invalid = message => new HttpFailure(400, 'INVALID_EVENT', message);
const string = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;

export function validateEnvelope(body, pairing) {
  if (!body || body.protocol !== PROTOCOL_VERSION) throw invalid('不支持的推送协议');
  if (body.worldId !== pairing.worldId || body.relayUserId !== pairing.relayUserId) {
    throw new HttpFailure(403, 'IDENTITY_MISMATCH', 'World 或 GM 中继身份不匹配');
  }
}

export function validateFoundryEvent(input, pairing) {
  const metadata = input?.metadata;
  if (!metadata || !isId(metadata.messageId) || !isId(metadata.playerId) ||
      input.id !== `${pairing.worldId}:${metadata.messageId}` || metadata.worldId !== pairing.worldId ||
      metadata.relayUserId !== pairing.relayUserId || metadata.source !== 'foundry' || metadata.origin !== 'player' ||
      !['public', 'whisper'].includes(metadata.visibility) || typeof metadata.playerIsGM !== 'boolean') {
    throw invalid('Foundry 事件标识或来源无效');
  }
  const eventTime = Date.parse(input.timestamp);
  if (!Number.isFinite(eventTime) || eventTime < pairing.captureSince || eventTime > Date.now() + 60000) {
    throw invalid('消息不在当前配对的采集时间范围内');
  }
  const ids = metadata.whisperUserIds;
  const names = metadata.whisperTo;
  if (metadata.visibility === 'whisper') {
    if (!Array.isArray(ids) || !Array.isArray(names) || !ids.length || ids.length > 64 || ids.length !== names.length ||
        !ids.every(isId) || !names.every(name => string(name, 200)) ||
        !ids.includes(metadata.playerId) || !ids.includes(pairing.relayUserId) ||
        new Set(ids).size !== ids.length || new Set(names).size !== names.length) throw invalid('密语接收范围不完整');
  } else if ((ids !== undefined && (!Array.isArray(ids) || ids.length)) ||
      (names !== undefined && (!Array.isArray(names) || names.length))) throw invalid('公开消息不能携带密语路由');
  if (metadata.actorId !== null && metadata.actorId !== undefined && !isId(metadata.actorId)) throw invalid('角色 ID 无效');
  try {
    const event = normalizeEvent({ id: input.id, type: input.type, player: input.player, text: input.text, timestamp: input.timestamp,
      metadata: { source: 'foundry', origin: 'player', worldId: pairing.worldId, relayUserId: pairing.relayUserId,
        messageId: metadata.messageId, playerId: metadata.playerId, playerIsGM: metadata.playerIsGM,
        actorId: metadata.actorId ?? null, visibility: metadata.visibility,
        whisperUserIds: ids ?? [], whisperTo: names ?? [] } });
    if (!event) throw invalid('不接受 Agent 自回复');
    return event;
  } catch (error) { throw invalid(error.message); }
}
