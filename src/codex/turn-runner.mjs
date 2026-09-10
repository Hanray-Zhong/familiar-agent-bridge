import { turnPolicy } from './policy.mjs';

export class TurnFailure extends Error {
  constructor(message, code = 'TURN_FAILED') { super(message); this.code = code; }
}

export async function runTurn(client, threadId, prompt, {
  timeoutMs = 300000, interruptTimeoutMs = 10000, eventId, onItem, model, effort,
} = {}) {
  if (client.activeTurn) throw new Error('同一 App Server 只允许一个正在运行的 Turn');
  const items = new Map();
  const early = [];
  let id, settled = false, interrupted, interruptPromise, timer;
  let resolve, reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  done.catch(() => {});
  const finish = (error, turn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve({ turn, items: [...items.values()] });
  };
  const disconnected = () => finish(interrupted ?? new TurnFailure('App Server 连接中断，Turn 结果不确定', 'DISCONNECTED'));
  const cancel = (reason = new TurnFailure('Turn 被中断', 'INTERRUPTED')) => {
    if (settled) return Promise.resolve();
    if (interruptPromise) return interruptPromise;
    interrupted = reason;
    interruptPromise = (async () => {
      let grace;
      try {
        if (!id) { await client.stop(); finish(reason); return; }
        const deadline = new Promise(yes => { grace = setTimeout(() => yes(false), interruptTimeoutMs); });
        const request = client.request('turn/interrupt', { threadId, turnId: id }, interruptTimeoutMs).catch(() => {});
        const ended = done.then(() => true, () => true);
        if (!await Promise.race([ended, deadline])) await client.stop();
        await request;
        finish(reason);
      } finally { clearTimeout(grace); }
    })();
    interruptPromise.catch(error => finish(error));
    return interruptPromise;
  };
  const notification = ({ method, params }) => {
    if (params?.threadId !== threadId) return;
    if (!id) { early.push({ method, params }); return; }
    const incomingId = params.turnId ?? params.turn?.id;
    if (incomingId && incomingId !== id) return;
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (!item) return;
      if (method === 'item/completed') items.set(item.id, item);
      try { onItem?.(item, method); }
      catch (error) { void cancel(error); }
      if (item.type === 'mcpToolCall') {
        client.logger?.info('mcp', `${item.server} ${item.tool}`, { status: item.status });
      }
    }
    if (method === 'turn/completed') {
      for (const item of params.turn.items ?? []) items.set(item.id, item);
      const status = params.turn.status;
      client.logger?.info('turn', status, { turnId: params.turn.id });
      finish(interrupted ?? (status === 'completed' ? null : new TurnFailure(`Turn ${status}${params.turn.error?.message ? `: ${params.turn.error.message.slice(0, 500)}` : ''}`)), params.turn);
    }
  };
  client.activeTurn = { threadId, cancel, get id() { return id; } };
  client.on('notification', notification);
  client.on('disconnected', disconnected);
  timer = setTimeout(() => { void cancel(new TurnFailure('Turn 超时，已请求中断', 'TURN_TIMEOUT')); }, timeoutMs);
  try {
    let response;
    try {
      response = await client.request('turn/start', {
        threadId, input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        ...(eventId ? { clientUserMessageId: eventId } : {}), ...turnPolicy,
      }, Math.min(timeoutMs, client.requestTimeoutMs));
      if (!response?.turn?.id || (id && response.turn.id !== id)) throw new Error('turn/start 返回了不匹配的 Turn');
      id = response.turn.id;
      client.logger?.info('turn', 'started', { turnId: id });
      for (const event of early.splice(0)) notification(event);
    } catch (error) {
      // start response 丢失时服务器可能已经开始执行。关闭旧进程后才允许继续。
      await client.stop();
      finish(error);
    }
    return await done;
  } finally {
    clearTimeout(timer);
    try { if (interruptPromise) await interruptPromise; }
    finally {
      client.off('notification', notification);
      client.off('disconnected', disconnected);
      client.activeTurn = null;
    }
  }
}
