// 保持持久化命名空间不变，以复用重命名前的配对、待发消息和设置。
export const MODULE_ID = 'familiar-codex-bridge';
export const PROTOCOL_VERSION = 1;
export const ROUTES = Object.freeze({ events: '/v1/events', status: '/v1/status' });
export const SIGNING_HEADERS = ['content-type', 'x-bridge-timestamp', 'x-bridge-nonce', 'x-bridge-signature'];
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const isId = value => typeof value === 'string' && ID_PATTERN.test(value);

export function signingText(path, timestamp, nonce, body) {
  return `POST\n${path}\n${timestamp}\n${nonce}\n${body}`;
}

export function responseSigningText(status, nonce, body) { return `RESPONSE\n${status}\n${nonce}\n${body}`; }

export function validatePairing(value) {
  if (!value || value.protocol !== PROTOCOL_VERSION || !isId(value.worldId) ||
      !isId(value.relayUserId) || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value.secret) ||
      !Number.isSafeInteger(value.captureSince) || value.captureSince <= 0) {
    throw new Error('配对文件无效，请重新运行 setup:foundry');
  }
  const url = new URL(value.bridgeUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/' || !url.port) {
    throw new Error('当前版本只支持 http://127.0.0.1:端口 的本机 Bridge');
  }
  if (!Array.isArray(value.allowedOrigins) || !value.allowedOrigins.length || value.allowedOrigins.some(origin => {
    try { const parsed = new URL(origin); return !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin; }
    catch { return true; }
  })) throw new Error('配对文件必须包含准确的 Foundry 页面 Origin');
  return { protocol: PROTOCOL_VERSION, worldId: value.worldId, relayUserId: value.relayUserId,
    secret: value.secret, bridgeUrl: url.origin, allowedOrigins: [...value.allowedOrigins], captureSince: value.captureSince };
}
