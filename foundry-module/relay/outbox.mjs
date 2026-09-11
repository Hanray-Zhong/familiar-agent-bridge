import { ROUTES } from '../shared/protocol.mjs';

const terminal = new Set(['processed', 'uncertain', 'cancelled']);
export const emptyOutbox = () => ({ version: 1, cursor: 0, pending: [], watching: [], recent: [], blocked: false, gapSince: null, gapVersion: 0 });

export class Outbox {
  constructor({ read, write, post, notify = () => {}, onStatus = async () => {}, clock = Date.now, maxPending = 500 }) {
    Object.assign(this, { read, write, post, notify, onStatus, clock, maxPending });
    this.tail = Promise.resolve();
    this.stopped = false;
    this.nextStatusAt = 0;
    this.statusOffset = 0;
    this.statusUpdates = new Map();
  }

  async load() {
    this.state = structuredClone(await this.read() ?? emptyOutbox());
    if (this.state.version !== 1 || !Number.isFinite(this.state.cursor) || this.state.cursor < 0 ||
        !['pending', 'watching', 'recent'].every(key => Array.isArray(this.state[key]))) throw new Error('本客户端待发记录损坏，已停止推送');
    for (const { event } of this.state.pending) this.report(event.id, this.state.blocked ? 'delivery-failed' : 'sending');
  }

  mutate(fn) {
    const operation = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const result = fn(next);
      await this.write(next);
      this.state = next;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async observe(event, timestamp) {
    const full = await this.mutate(state => {
      if (event && !state.pending.some(item => item.event.id === event.id) && !state.watching.includes(event.id) && !state.recent.includes(event.id)) {
        if (state.pending.length >= this.maxPending) {
          state.gapSince = Math.min(state.gapSince ?? timestamp, timestamp);
          state.gapVersion = (state.gapVersion ?? 0) + 1;
          return true;
        }
        state.pending.push({ event, attempts: 0, nextAt: 0 });
        state.pending.sort((a, b) => Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp) || a.event.id.localeCompare(b.event.id));
      }
      state.cursor = Math.max(state.cursor, timestamp);
      return false;
    });
    if (event && (full || this.state.pending.some(item => item.event.id === event.id))) {
      this.report(event.id, full ? 'delayed' : this.state.blocked ? 'delivery-failed' : 'sending');
    }
    if (full) throw Object.assign(new Error('本客户端待发队列已满；消息仍在 Foundry，将在有空位后补投'), { code: 'OUTBOX_FULL' });
  }

  report(id, status) { this.statusUpdates.set(id, status); }

  async flushStatus() {
    for (const [id, status] of [...this.statusUpdates]) {
      try {
        await this.onStatus(id, status);
        if (this.statusUpdates.get(id) === status) this.statusUpdates.delete(id);
      } catch {
        this.notify('无法更新玩家的回答提示，将稍后重试；请求仍按原回执处理');
        break;
      }
    }
  }

  clearGap(version) { return this.mutate(state => { if (state.gapVersion === version) state.gapSince = null; }); }

  async pump() {
    if (this.stopped || this.pumping) return;
    this.pumping = (async () => { try { await this.runPump(); } finally { await this.flushStatus(); } })();
    try { await this.pumping; } finally { this.pumping = null; }
  }

  async runPump() {
    await this.tail;
    for (const { event, attempts } of this.state.pending) {
      this.report(event.id, this.state.blocked ? 'delivery-failed' : attempts ? 'retrying' : 'sending');
    }
    const first = this.state.pending[0];
    if (first && !this.state.blocked && first.nextAt <= this.clock()) {
      try {
        const result = await this.post(ROUTES.events, { event: first.event });
        if (result.id !== first.event.id || !['queued', 'running', ...terminal].includes(result.status)) {
          throw Object.assign(new Error('Bridge 没有返回有效持久化回执'), { retryable: false });
        }
        await this.mutate(state => {
          state.pending = state.pending.filter(item => item.event.id !== first.event.id);
          if (terminal.has(result.status)) state.recent.push(result.id);
          else state.watching.push(result.id);
          state.recent = state.recent.slice(-500);
        });
        this.report(result.id, result.status);
        if (result.status === 'uncertain') this.notify('存在结果待核对的请求，不会自动重发');
      } catch (error) {
        await this.mutate(state => {
          const current = state.pending.find(item => item.event.id === first.event.id);
          if (!current) return;
          current.attempts++;
          current.nextAt = this.clock() + Math.min(60000, 1000 * 2 ** current.attempts);
          state.blocked = error.retryable === false || current.attempts >= 8;
        });
        this.report(first.event.id, this.state.blocked ? 'delivery-failed' : 'retrying');
        if (this.state.blocked) for (const { event } of this.state.pending) this.report(event.id, 'delivery-failed');
        if (this.state.blocked || first.attempts === 0) this.notify(error.message);
      }
    }
    if (!this.stopped && this.state.watching.length && this.clock() >= this.nextStatusAt) {
      this.nextStatusAt = this.clock() + 2000;
      const ids = this.state.watching.slice(this.statusOffset, this.statusOffset + 100);
      this.statusOffset = (this.statusOffset + 100) % this.state.watching.length;
      try {
        const result = await this.post(ROUTES.status, { ids });
        if (!Array.isArray(result.receipts) || result.receipts.length !== ids.length ||
            new Set(result.receipts.map(receipt => receipt?.id)).size !== ids.length ||
            result.receipts.some(receipt => !ids.includes(receipt?.id) || !['queued', 'running', 'unknown', ...terminal].includes(receipt.status))) {
          throw new Error('状态回执无效');
        }
        const finished = result.receipts.filter(receipt => terminal.has(receipt.status));
        await this.mutate(state => {
          for (const receipt of finished) { state.watching = state.watching.filter(id => id !== receipt.id); state.recent.push(receipt.id); }
          state.recent = state.recent.slice(-500);
        });
        for (const receipt of result.receipts) {
          this.report(receipt.id, receipt.status === 'queued' && (result.paused || result.ready === false) ? 'paused' : receipt.status);
        }
        if (finished.some(receipt => receipt.status === 'uncertain')) this.notify('有请求的执行结果不确定，请 GM 核对；不会自动重发');
        if (result.receipts.some(receipt => receipt.status === 'unknown')) this.notify('Bridge 缺少已接收请求的记录，请 GM 核对状态文件；不会自动重放');
      } catch {
        for (const id of ids) this.report(id, 'disconnected');
        // 只查询状态，不重新发送已经 ACK 的事件。
      }
    }
  }

  retry() { return this.mutate(state => { state.blocked = false; for (const item of state.pending) { item.attempts = 0; item.nextAt = 0; } }); }
  async stop() { this.stopped = true; await this.pumping; await this.tail; }
}
