import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { serverRequestReply } from './server-requests.mjs';

export class JsonlConnection extends EventEmitter {
  constructor({ input, output, logger, timeoutMs = 30000 }) {
    super();
    Object.assign(this, { input, logger, timeoutMs });
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.lines = createInterface({ input: output, crlfDelay: Infinity });
    this.lines.on('line', line => this.receive(line));
    this.lines.on('close', () => this.close(new Error('App Server stdout 已关闭')));
    this.input.on('error', error => this.close(error));
    output.on('error', error => this.close(error));
  }

  send(message) {
    if (this.closed || this.input.destroyed) throw new Error('App Server 未连接');
    this.input.write(`${JSON.stringify(message)}\n`, error => { if (error) this.close(error); });
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('App Server 未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`App Server request 超时: ${method}`);
        error.code = 'REQUEST_TIMEOUT';
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }

  receive(line) {
    if (!line.trim() || this.closed) return;
    let message;
    try { message = JSON.parse(line); }
    catch { this.close(new Error('App Server 输出无效 JSON；原始内容已隐藏')); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.close(new Error('App Server 输出无效协议对象')); return;
    }
    const hasId = Object.hasOwn(message, 'id');
    // 两个方向的 id 空间独立。先检查 method，避免误吞同 id 的 server request。
    if (typeof message.method === 'string') {
      if (hasId) {
        const reply = serverRequestReply(message.method);
        this.logger?.warn('approval', 'server request 已安全拒绝', { method: message.method });
        try { this.send({ id: message.id, ...reply }); }
        catch (error) { this.close(error); }
        this.emit('serverRequest', message);
      } else this.emit('notification', message);
      return;
    }
    if (!hasId || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) {
      this.close(new Error('App Server 消息既不是 response 也不是 notification')); return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) { this.logger?.debug('codex', '忽略迟到的 response'); return; }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(`${pending.method}: ${message.error.message ?? 'RPC error'}`);
      error.code = message.error.code;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  close(error = new Error('App Server 连接已关闭')) {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.emit('disconnect', error);
  }
}
