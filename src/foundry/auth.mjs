import { createHmac, timingSafeEqual } from 'node:crypto';
import { signingText } from '../../foundry-module/shared/protocol.mjs';

export class HttpFailure extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}

export class RequestAuth {
  constructor(secret, { clock = Date.now, windowMs = 60000, maxNonces = 4096 } = {}) {
    Object.assign(this, { secret, clock, windowMs, maxNonces });
    this.nonces = new Map();
    this.tokens = 60;
    this.refilledAt = clock();
  }

  rateLimit() {
    const now = this.clock();
    this.tokens = Math.min(60, this.tokens + (now - this.refilledAt) / 500);
    this.refilledAt = now;
    if (this.tokens < 1) throw new HttpFailure(429, 'RATE_LIMIT', '请求过于频繁，请稍后重试');
    this.tokens--;
  }

  verify(path, headers, body) {
    const timestamp = headers['x-bridge-timestamp'];
    const nonce = headers['x-bridge-nonce'];
    const signature = headers['x-bridge-signature'];
    const now = this.clock();
    if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > this.windowMs ||
        typeof nonce !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(nonce) ||
        typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
      throw new HttpFailure(401, 'AUTH_FAILED', '请求签名无效或已过期');
    }
    const expected = createHmac('sha256', this.secret).update(signingText(path, timestamp, nonce, body)).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new HttpFailure(401, 'AUTH_FAILED', '请求签名无效或已过期');
    for (const [key, expires] of this.nonces) if (expires < now) this.nonces.delete(key);
    if (this.nonces.has(nonce)) throw new HttpFailure(409, 'REPLAY', '重复签名，请使用新的 nonce 重试');
    if (this.nonces.size >= this.maxNonces) throw new HttpFailure(429, 'RATE_LIMIT', '认证窗口已满，请稍后重试');
    this.nonces.set(nonce, now + this.windowMs * 2);
  }
}
