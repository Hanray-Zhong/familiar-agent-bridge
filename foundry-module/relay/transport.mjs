import { signingText, responseSigningText, PROTOCOL_VERSION } from '../shared/protocol.mjs';

export async function signedPost(pairing, path, payload, { fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto, timeoutMs = 10000 } = {}) {
  if (!cryptoImpl?.subtle) throw Object.assign(new Error('需要在 localhost 或 HTTPS 的 Foundry 页面使用安全连接'), { retryable: false });
  const body = JSON.stringify({ protocol: PROTOCOL_VERSION, worldId: pairing.worldId, relayUserId: pairing.relayUserId, ...payload });
  const timestamp = String(Date.now());
  const nonce = cryptoImpl.randomUUID();
  const encoder = new TextEncoder();
  const key = await cryptoImpl.subtle.importKey('raw', encoder.encode(pairing.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signed = await cryptoImpl.subtle.sign('HMAC', key, encoder.encode(signingText(path, timestamp, nonce, body)));
  const signature = [...new Uint8Array(signed)].map(value => value.toString(16).padStart(2, '0')).join('');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${pairing.bridgeUrl}${path}`, { method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Timestamp': timestamp, 'X-Bridge-Nonce': nonce, 'X-Bridge-Signature': signature },
      body, signal: controller.signal });
    const raw = await response.text();
    const responseSignature = response.headers.get('x-bridge-response');
    if (responseSignature && /^[a-f0-9]{64}$/.test(responseSignature)) {
      const bytes = Uint8Array.from(responseSignature.match(/../g), value => parseInt(value, 16));
      if (!await cryptoImpl.subtle.verify('HMAC', key, bytes, encoder.encode(responseSigningText(response.status, nonce, raw)))) {
        throw Object.assign(new Error('Bridge 响应签名错误，未确认接收'), { retryable: false });
      }
    } else if (response.ok) throw Object.assign(new Error('Bridge 响应缺少签名，未确认接收'), { retryable: false });
    let result;
    try { result = JSON.parse(raw); } catch { throw Object.assign(new Error('Bridge 响应不是有效 JSON'), { retryable: true }); }
    if (!response.ok) {
      const code = typeof result.error === 'string' && /^[A-Z_]{1,64}$/.test(result.error) ? result.error : 'UNKNOWN';
      const error = new Error(`Bridge 返回 ${response.status}（${code}）`);
      error.retryable = response.status >= 500 || [408, 429].includes(response.status) || result.error === 'REPLAY';
      throw error;
    }
    if (result.protocol !== PROTOCOL_VERSION) throw Object.assign(new Error('Bridge 响应协议不匹配'), { retryable: false });
    return result;
  } catch (error) {
    if (error.retryable !== undefined) throw error;
    throw Object.assign(new Error('无法连接本机 Bridge；检查服务、Foundry 页面 Origin 和浏览器本地网络权限'), { retryable: true });
  } finally { clearTimeout(timer); }
}
