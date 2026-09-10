import { MODULE_ID, validatePairing } from '../shared/protocol.mjs';
import { Outbox } from './outbox.mjs';
import { buildFoundryEvent, canRelay, messageTime } from './message.mjs';
import { signedPost } from './transport.mjs';

export class RelayController {
  constructor({ game, locks, notify, textOf, post = signedPost }) {
    Object.assign(this, { game, locks, notify, textOf, post });
    this.owner = false;
    this.stopped = false;
    this.lastWarning = '';
    this.live = [];
  }

  warn(message) { if (this.lastWarning !== message) { this.lastWarning = message; this.notify(message); } }

  start() { this.timer = setInterval(() => void this.tick().catch(error => this.warn(error.message)), 2000); void this.tick().catch(error => this.warn(error.message)); }

  async tick() {
    if (this.stopped) return;
    let pairing;
    try { pairing = validatePairing(this.game.settings.get(MODULE_ID, 'pairing')); }
    catch { this.release?.(); return; }
    if (!canRelay(this.game, pairing)) {
      this.release?.();
      if (this.game.user?.id === pairing.relayUserId && this.game.settings.get(MODULE_ID, 'enabled') && this.game.settings.get('familiar', 'tableChatEnabled')) {
        this.warn('Familiar Table Chat 已开启，Bridge 推送已暂停；请先关闭内置自动回答');
      }
      return;
    }
    if (!this.locks) { this.warn('浏览器不支持 Web Locks，无法保证单一 GM 标签页推送'); return; }
    if (this.lease) return;
    this.lease = this.locks.request(`${MODULE_ID}:${pairing.worldId}:${pairing.relayUserId}`, { ifAvailable: true }, async lock => {
      if (!lock || this.stopped) return;
      this.pairing = pairing;
      const storageKey = `${pairing.worldId}:${pairing.relayUserId}`;
      this.outbox = new Outbox({
        read: () => this.game.settings.get(MODULE_ID, 'outboxes')[storageKey],
        write: async state => { const all = this.game.settings.get(MODULE_ID, 'outboxes'); await this.game.settings.set(MODULE_ID, 'outboxes', { ...all, [storageKey]: state }); },
        post: (path, payload) => this.post(pairing, path, payload), notify: message => this.warn(message),
      });
      await this.outbox.load();
      this.owner = true;
      this.initializing = true;
      let resolve;
      const held = new Promise(yes => { resolve = yes; });
      this.release = resolve;
      try {
        await this.catchUp();
        this.initializing = false;
        for (const [message, creatorId] of this.live.splice(0)) {
          try { await this.observe(message, creatorId); }
          catch (error) { if (error.code === 'OUTBOX_FULL') { this.warn(error.message); break; } throw error; }
        }
        this.pumpTimer = setInterval(() => {
          if (!canRelay(this.game, pairing)) return this.release?.();
          void this.work().catch(error => this.warn(error.message));
        }, 1000);
        await this.work();
        await held;
      } finally {
        clearInterval(this.pumpTimer);
        this.owner = false;
        this.initializing = false;
        await this.working?.catch(() => {});
        await this.outbox.stop();
        this.release = null;
      }
    });
    try { await this.lease; } finally { this.lease = null; }
  }

  async observe(message, creatorId) {
    if (!this.owner || this.stopped || !canRelay(this.game, this.pairing)) return;
    if (this.initializing && creatorId) { this.live.push([message, creatorId]); return; }
    const event = buildFoundryEvent(message, this.game, this.pairing, { text: this.textOf(message), creatorId });
    const timestamp = messageTime(message);
    if (!timestamp || timestamp > Date.now() + 60000) return;
    await this.outbox.observe(event, timestamp);
  }

  async catchUp() {
    if (!this.owner) return;
    const gapVersion = this.outbox.state.gapVersion;
    const position = Math.min(this.outbox.state.cursor - 5000, this.outbox.state.gapSince ?? Infinity);
    const since = Math.max(this.pairing.captureSince, this.game.settings.get(MODULE_ID, 'enabledSince'), position);
    const messages = this.game.messages.contents.filter(message => messageTime(message) >= since)
      .sort((a, b) => messageTime(a) - messageTime(b) || a.id.localeCompare(b.id));
    for (const message of messages) {
      try { await this.observe(message); }
      catch (error) { if (error.code === 'OUTBOX_FULL') { this.warn(error.message); return; } throw error; }
    }
    if (this.outbox.state.gapSince !== null) await this.outbox.clearGap(gapVersion);
  }

  async work() {
    if (this.working) return this.working;
    this.working = (async () => { await this.outbox.pump(); if (this.owner && this.outbox.state.gapSince) await this.catchUp(); })();
    try { await this.working; } finally { this.working = null; }
  }

  async retry() { if (this.owner) { await this.outbox.retry(); await this.work(); await this.catchUp(); this.lastWarning = ''; } }
  status() {
    const state = this.outbox?.state;
    return this.owner ? `本标签页负责推送；待发送 ${state?.pending.length ?? 0}，待完成 ${state?.watching.length ?? 0}${state?.blocked ? '；发送已暂停，请检查后重试' : ''}` : '本标签页未持有 GM 推送锁（可能由其他 GM 标签页负责，或尚未启用）';
  }
  async stop() { this.stopped = true; clearInterval(this.timer); this.release?.(); await this.lease; }
}
