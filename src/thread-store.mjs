import { readFile } from 'node:fs/promises';
import { writeAtomicJson } from './storage/atomic-json.mjs';
import { admitFoundryEvent, recordFoundryStatus } from './storage/foundry-receipts.mjs';

const now = () => new Date().toISOString();
const initialState = () => ({
  version: 1, threadId: null, sessionStartedAt: null, world: null,
  lastProcessedMessageId: null, receipts: [], queued: [], inFlight: null, foundryReceipts: {},
});

function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.queued) || !Array.isArray(state.receipts) ||
      (state.foundryReceipts !== undefined && (!state.foundryReceipts || typeof state.foundryReceipts !== 'object' || Array.isArray(state.foundryReceipts))) ||
      !(state.threadId === null || typeof state.threadId === 'string') ||
      !state.queued.every(event => typeof event?.id === 'string' && typeof event?.text === 'string') ||
      !state.receipts.every(receipt => typeof receipt?.id === 'string' && typeof receipt?.status === 'string') ||
      !(state.inFlight === null || typeof state.inFlight?.event?.id === 'string')) {
    throw new Error('state.json 格式错误；保留原文件，拒绝悄悄创建新 Session');
  }
}

export class ThreadStore {
  constructor(file, { historyLimit = 4096, maxQueued = 1000 } = {}) {
    Object.assign(this, { file, historyLimit, maxQueued });
    this.tail = Promise.resolve();
  }

  async load() {
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取 state.json；原文件已保留，请检查 JSON 与权限', { cause: error });
      this.state = initialState();
      await writeAtomicJson(this.file, this.state);
    }
    validate(this.state);
    this.state.foundryReceipts ??= {};
    if (this.state.inFlight) {
      await this.update(state => {
        this.receipt(state, state.inFlight.event.id, 'uncertain');
        state.inFlight = null;
      });
    }
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.state); }

  update(mutator) {
    const operation = this.tail.then(async () => {
      const next = this.snapshot();
      const result = mutator(next);
      validate(next);
      try { await writeAtomicJson(this.file, next); }
      catch (cause) {
        const error = new Error('状态持久化失败，必须暂停游戏以避免重复执行', { cause });
        error.code = 'STORE_FAILURE';
        throw error;
      }
      this.state = next;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  receipt(state, id, status, turnId = null) {
    recordFoundryStatus(state, id, status, turnId);
    state.receipts = state.receipts.filter(receipt => receipt.id !== id);
    state.receipts.push({ id, status, turnId, at: now() });
    state.receipts = state.receipts.slice(-this.historyLimit);
  }

  enqueue(event) {
    return this.update(state => {
      if (!admitFoundryEvent(state, event)) return false;
      if (state.receipts.some(receipt => receipt.id === event.id) || state.inFlight?.event.id === event.id ||
          state.queued.some(queued => queued.id === event.id)) return false;
      if (state.queued.length >= this.maxQueued) throw Object.assign(new Error('持久化 Queue 已满，请等待处理'), { code: 'QUEUE_FULL' });
      state.queued.push(event);
      return true;
    });
  }

  begin(id) {
    return this.update(state => {
      if (state.inFlight) throw new Error('持久化记录中已有正在执行的 Turn');
      const index = state.queued.findIndex(event => event.id === id);
      if (index < 0) throw new Error('事件未持久化，禁止运行 Turn');
      state.inFlight = { event: state.queued.splice(index, 1)[0], startedAt: now() };
      recordFoundryStatus(state, id, 'running');
    });
  }

  finish(id, status, turnId = null) {
    return this.update(state => {
      if (state.inFlight?.event.id !== id) throw new Error('事件与 inFlight 记录不匹配');
      this.receipt(state, id, status, turnId);
      if (status === 'processed') state.lastProcessedMessageId = id;
      state.inFlight = null;
    });
  }

  saveThread(threadId) {
    return this.update(state => { state.threadId = threadId; state.sessionStartedAt ??= now(); });
  }

  foundryStatuses(ids) {
    return ids.map(id => ({ id, status: Object.hasOwn(this.state.foundryReceipts ?? {}, id) ? this.state.foundryReceipts[id].status : 'unknown' }));
  }

  bindWorld(world) {
    return this.update(state => {
      if (state.world && (state.world.id ?? state.world.name) !== (world.id ?? world.name)) {
        const error = new Error('Foundry World 已切换，当前 Thread 属于另一世界；请新开 Session');
        error.code = 'WORLD_CHANGED';
        throw error;
      }
      state.world = world;
    });
  }

  reset() {
    return this.update(state => {
      if (state.inFlight) throw new Error('有正在执行的事件，不能重置 Session');
      for (const event of state.queued) this.receipt(state, event.id, 'cancelled');
      state.queued = [];
      state.threadId = null;
      state.sessionStartedAt = null;
      state.world = null;
    });
  }
}
