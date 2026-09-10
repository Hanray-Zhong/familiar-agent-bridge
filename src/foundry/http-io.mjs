import { HttpFailure } from './auth.mjs';
import { createHmac } from 'node:crypto';
import { responseSigningText } from '../../foundry-module/shared/protocol.mjs';

export function readBody(request, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, finished = false;
    const finish = (error, data) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      if (error) { request.pause(); reject(error); } else resolve(data);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) finish(new HttpFailure(413, 'TOO_LARGE', '请求超过 64 KiB'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(() => finish(new HttpFailure(408, 'REQUEST_TIMEOUT', '读取请求超时')), 5000);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', () => finish(new HttpFailure(400, 'ABORTED', '请求已中断')));
    request.once('error', () => finish(new HttpFailure(400, 'ABORTED', '请求已中断')));
  });
}

export function respond(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const raw = JSON.stringify(body);
  if (response.bridgeAuth) response.setHeader('X-Bridge-Response', createHmac('sha256', response.bridgeAuth.secret)
    .update(responseSigningText(status, response.bridgeAuth.nonce, raw)).digest('hex'));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Connection': 'close', ...(status === 429 ? { 'Retry-After': '5' } : {}) });
  response.end(raw);
}
