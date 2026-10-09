import { createServer } from 'node:http';
import { EventSource } from './base.mjs';
import { RequestAuth, HttpFailure } from '../foundry/auth.mjs';
import { readBody, respond } from '../foundry/http-io.mjs';
import { validateEnvelope, validateFoundryEvent } from '../foundry/event-validation.mjs';
import { ROUTES, SIGNING_HEADERS, validatePairing } from '../../foundry-module/shared/protocol.mjs';

export class FoundryEventSource extends EventSource {
  constructor({ pairing, accept, status, receipts, logger }) {
    super();
    Object.assign(this, { pairing: validatePairing(pairing), accept, status, receipts, logger });
    this.auth = new RequestAuth(pairing.secret);
    this.inFlight = new Set();
    this.closing = false;
  }

  async start() {
    const url = new URL(this.pairing.bridgeUrl);
    this.server = createServer((request, response) => {
      const operation = this.handle(request, response).catch(() => respond(response, 500, { error: 'INTERNAL_ERROR' }));
      this.inFlight.add(operation);
      void operation.finally(() => this.inFlight.delete(operation));
    });
    Object.assign(this.server, { requestTimeout: 10000, headersTimeout: 10000, keepAliveTimeout: 1000, maxHeadersCount: 24 });
    this.server.maxRequestsPerSocket = 10;
    this.server.maxConnections = 64;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(Number(url.port), '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.server.on('error', error => this.emit('failure', error));
    this.logger?.info('foundry', 'HTTP 推送已启动', { host: '127.0.0.1', port: Number(url.port), worldId: this.pairing.worldId });
  }

  async handle(request, response) {
    try {
      this.auth.rateLimit();
      if (this.closing) throw new HttpFailure(503, 'SHUTTING_DOWN', 'Bridge 正在关闭');
      const expectedHost = new URL(this.pairing.bridgeUrl).host;
      if (request.headers.host !== expectedHost) throw new HttpFailure(403, 'HOST_DENIED', 'Host 不匹配');
      const origin = request.headers.origin;
      if (origin && !this.pairing.allowedOrigins.includes(origin)) throw new HttpFailure(403, 'ORIGIN_DENIED', 'Origin 未授权');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Expose-Headers', 'X-Bridge-Response');
      }
      if (!Object.values(ROUTES).includes(request.url)) throw new HttpFailure(404, 'NOT_FOUND', '未知接口');
      if (request.method === 'OPTIONS') {
        const headers = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!origin || request.headers['access-control-request-method'] !== 'POST' || headers.some(header => !SIGNING_HEADERS.includes(header))) {
          throw new HttpFailure(403, 'PREFLIGHT_DENIED', '不支持的跨域请求');
        }
        response.setHeader('Access-Control-Allow-Methods', 'POST');
        response.setHeader('Access-Control-Allow-Headers', SIGNING_HEADERS.join(', '));
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.writeHead(204); response.end(); return;
      }
      if (request.method !== 'POST') throw new HttpFailure(405, 'METHOD_DENIED', '只接受 POST');
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpFailure(415, 'JSON_REQUIRED', '需要 JSON 请求');
      const raw = await readBody(request);
      this.auth.verify(request.url, request.headers, raw);
      response.bridgeAuth = { secret: this.pairing.secret, nonce: request.headers['x-bridge-nonce'] };
      let body;
      try { body = JSON.parse(raw); } catch { throw new HttpFailure(400, 'INVALID_JSON', 'JSON 无效'); }
      validateEnvelope(body, this.pairing);
      if (request.url === ROUTES.status) {
        if (!Array.isArray(body.ids) || body.ids.length > 100 || !body.ids.every(id => typeof id === 'string' && id.startsWith(`${this.pairing.worldId}:`) && id.length < 260)) {
          throw new HttpFailure(400, 'INVALID_IDS', '状态查询 ID 无效');
        }
        const state = this.status();
        respond(response, 200, { protocol: 1, ready: state.healthy, paused: state.paused, queued: state.queued,
          receipts: this.receipts(body.ids) });
        this.emit('verified');
        return;
      }
      const event = validateFoundryEvent(body.event, this.pairing);
      // HTTP ACK 必须等 Bridge 原子落盘成功，不能只 emit 然后立即返回 202。
      const result = await this.accept(event);
      const receipt = this.receipts([event.id])[0];
      respond(response, result.accepted ? 202 : 200, { protocol: 1, id: event.id, accepted: result.accepted,
        status: receipt?.status ?? 'queued' });
      this.emit('accepted', { id: event.id, accepted: result.accepted });
      this.emit('verified');
    } catch (error) {
      const status = error.status ?? (error.code === 'EVENT_CONFLICT' ? 409 : error.code === 'QUEUE_FULL' ? 429 : error.code === 'WORLD_CHANGED' ? 409 : 503);
      const code = error.code ?? 'TEMPORARILY_UNAVAILABLE';
      // 不打印认证头、请求体或 GM/玩家文本。
      this.logger?.warn('foundry', '推送请求未接收', { status, code });
      respond(response, status, { error: code, message: error.status ? error.message : 'Bridge 未接收该事件，请检查本机日志' });
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.closing = true;
    this.stopPromise = (async () => {
      if (!this.server) return;
      let timer;
      try {
        await new Promise(resolve => {
          this.server.close(resolve);
          timer = setTimeout(() => this.server.closeAllConnections(), 6000);
        });
      } finally { clearTimeout(timer); }
      await Promise.allSettled([...this.inFlight]);
    })();
    return this.stopPromise;
  }
}
