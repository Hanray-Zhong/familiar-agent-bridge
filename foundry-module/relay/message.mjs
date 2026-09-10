import { MODULE_ID, isId } from '../shared/protocol.mjs';

// v14 服务端创建时覆盖 _stats.createdTime；聊天显示 timestamp 可以由作者指定。
export function messageTime(message) { return Number.isSafeInteger(message._stats?.createdTime) ? message._stats.createdTime : 0; }

export function htmlToText(html, document) {
  const template = document.createElement('template');
  template.innerHTML = html.replace(/<(?:br\b[^>]*|\/p|\/div|\/li)>/gi, '\n');
  for (const element of template.content.querySelectorAll('script,style,template,noscript,iframe,object,embed,[hidden]')) element.remove();
  return template.content.textContent ?? '';
}

export function extractRequest(text) {
  const match = text.trim().match(/^@familiar(?=$|[\s:：,，])(?:[\s:：,，]*)([\s\S]*)$/iu);
  return match?.[1].trim() || null;
}

export function canRelay(game, pairing) {
  if (!game.user?.isGM || !pairing || game.user.id !== pairing.relayUserId || game.world.id !== pairing.worldId) return false;
  if (!game.settings.get(MODULE_ID, 'enabled') || game.settings.get(MODULE_ID, 'relayUserId') !== game.user.id) return false;
  if (!game.modules.get('familiar')?.active || game.settings.get('familiar', 'tableChatEnabled')) return false;
  return true;
}

export function buildFoundryEvent(message, game, pairing, { text = htmlToText(message.content ?? '', globalThis.document), creatorId } = {}) {
  const author = message.author;
  if (!isId(message.id) || !author || !game.users.get(author.id) || !isId(author.id)) return null;
  if (creatorId && creatorId !== author.id) return null;
  if (message.visible === false || message.isContentVisible === false || message.blind || message.isRoll || message.rolls?.length) return null;
  if (author.isGM && !game.settings.get(MODULE_ID, 'allowGmRequests')) return null;
  if (Object.keys(message.flags?.familiar ?? {}).length || message.flags?.[MODULE_ID]?.isAgentReply) return null;
  if (/^(?:familiar|codex)$/i.test(message.speaker?.alias?.trim() ?? '')) return null;
  const request = extractRequest(text);
  if (!request) return null;
  if (request.length > 16000) throw new Error('玩家请求超过 16000 字符，未转发');
  const createdTime = messageTime(message);
  if (createdTime < pairing.captureSince || createdTime > Date.now() + 60000) return null;
  const recipients = [...new Set(message.whisper ?? [])];
  const privateMessage = recipients.length > 0;
  if (privateMessage && !recipients.includes(pairing.relayUserId)) return null;
  if (privateMessage && !recipients.includes(author.id)) recipients.push(author.id);
  const names = recipients.map(id => {
    const user = game.users.get(id);
    if (!user || game.users.contents.filter(candidate => candidate.name === user.name).length !== 1) {
      throw new Error('密语接收者不存在或同名，无法安全回复；请 GM 检查用户名称');
    }
    return user.name;
  });
  const actor = message.speakerActor ?? author.character;
  const ownsActor = actor && (author.isGM || actor.testUserPermission(author, 'OWNER'));
  return {
    id: `${pairing.worldId}:${message.id}`, type: 'player-message', player: author.name, text: request,
    timestamp: new Date(createdTime).toISOString(),
    metadata: { source: 'foundry', origin: 'player', worldId: pairing.worldId, messageId: message.id,
      relayUserId: pairing.relayUserId, playerId: author.id, playerIsGM: Boolean(author.isGM),
      actorId: ownsActor ? actor.id : null, visibility: privateMessage ? 'whisper' : 'public',
      whisperUserIds: recipients, whisperTo: names },
  };
}
