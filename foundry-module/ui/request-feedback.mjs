import { MODULE_ID } from '../shared/protocol.mjs';
import { buildFoundryEvent } from '../relay/message.mjs';
import { ACTIVE_REQUEST_STATUSES, REQUEST_STATUS_FLAG, STATUS_STALE_MS } from '../relay/request-status.mjs';

const warnings = {
  retrying: 'Familiar 暂未确认收到请求，正在重试连接。请稍候；持续失败时请 GM 修复连接并重试待发消息，勿重复发送。',
  'delivery-failed': 'Familiar 请求发送异常。请 GM 检查连接后点击“重试待发消息”；玩家暂勿重复发送。',
  delayed: 'Familiar 待发请求较多，当前请求将稍后补投。请稍候，持续无回复时请 GM 检查并重试待发消息。',
  paused: 'Familiar 暂停回答，请 GM 恢复连接。请求仍在排队，无需重复发送。',
  disconnected: 'Familiar 回答状态暂时无法确认。请 GM 检查连接和游戏结果，确认未执行后再重试，勿直接重复行动。',
  uncertain: 'Familiar 回答异常，行动可能已部分执行。请先让 GM 核对聊天、掷骰和资源，再重试未完成的部分。',
  unknown: 'Familiar 无法确认这条请求的处理结果。请 GM 核对记录，确认未执行后再重试。',
  cancelled: 'Familiar 请求已取消。需要继续时，请重新发送 @familiar 请求。',
  rejected: 'Familiar 未转发这条请求。请检查消息长度；密语请 GM 核对接收者和用户名称，修正后重试。',
};

export class RequestFeedback {
  constructor({ game, notifications, textOf, clock = Date.now }) {
    Object.assign(this, { game, notifications, textOf, clock });
    this.requests = new Map();
  }

  request(message, creatorId) {
    if (!this.game.settings.get(MODULE_ID, 'enabled') || !this.game.modules.get('familiar')?.active ||
        this.game.settings.get('familiar', 'tableChatEnabled')) return null;
    if (message.whisper?.length && message.author?.id !== this.game.user.id && !message.whisper.includes(this.game.user.id)) return null;
    const relayUserId = this.game.settings.get(MODULE_ID, 'relayUserId');
    if (!this.game.users.get(relayUserId)?.isGM) return null;
    return buildFoundryEvent(message, this.game, { worldId: this.game.world.id, relayUserId,
      captureSince: this.game.settings.get(MODULE_ID, 'enabledSince') }, { text: this.textOf(message), creatorId });
  }

  observe(message, creatorId) {
    try {
      if (this.request(message, creatorId) && !this.requests.has(message.id)) this.set(message.id, 'sending', this.clock());
    } catch { this.set(message.id, 'rejected', this.clock()); }
  }

  update(message, userId, { restoring = false } = {}) {
    const value = message.flags?.[MODULE_ID]?.[REQUEST_STATUS_FLAG];
    const relayUserId = this.game.settings.get(MODULE_ID, 'relayUserId');
    if (!value || value.relayUserId !== relayUserId || userId !== relayUserId || !this.game.users.get(userId)?.isGM ||
        !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 ||
        (!ACTIVE_REQUEST_STATUSES.has(value.status) && !Object.hasOwn(warnings, value.status) && value.status !== 'processed')) return;
    try { if (!this.request(message)) { this.remove(message.id); return; } } catch { return; }
    if (restoring && !ACTIVE_REQUEST_STATUSES.has(value.status)) return;
    const previous = this.requests.get(message.id);
    if (previous?.remoteAt > value.updatedAt) return;
    // GM 时间仅用于远端回执排序；在线失联计时从本机收到更新起算，兼容玩家电脑时钟偏差。
    this.set(message.id, restoring && this.clock() - value.updatedAt >= STATUS_STALE_MS
      ? 'disconnected' : value.status, this.clock(), value.updatedAt);
  }

  set(id, status, updatedAt, remoteAt = this.requests.get(id)?.remoteAt) {
    const previous = this.requests.get(id);
    this.requests.set(id, { status, updatedAt, remoteAt });
    this.render();
    if (warnings[status] && previous?.status !== status) this.notifications.warn(warnings[status], { console: false });
    // 保留近期终态以抑制重复通知，活跃请求一直保留到完成或失联。
    if (this.requests.size > 1000) {
      for (const [key, value] of this.requests) {
        if (!ACTIVE_REQUEST_STATUSES.has(value.status)) this.requests.delete(key);
        if (this.requests.size <= 1000) break;
      }
    }
  }

  render() {
    const active = [...this.requests.values()].filter(value => ACTIVE_REQUEST_STATUSES.has(value.status));
    if (!active.length) {
      if (this.indicator) this.notifications.remove(this.indicator);
      this.indicator = null;
      this.indicatorText = '';
      return;
    }
    const status = active.some(value => value.status === 'running') ? '正在回答，请稍候…'
      : active.some(value => value.status === 'queued') ? '请求已排队，等待回答…' : '正在发送请求，请稍候…';
    const text = `Familiar：${status}${active.length > 1 ? `（${active.length} 条请求待完成）` : ''}`;
    if (!this.indicator || !this.notifications.has(this.indicator)) {
      this.indicator = this.notifications.info(text, { permanent: true, console: false });
    } else if (text !== this.indicatorText) this.notifications.update(this.indicator, { message: text });
    this.indicatorText = text;
  }

  remove(id) { this.requests.delete(id); this.render(); }

  checkTimeouts() {
    if (!this.game.settings.get(MODULE_ID, 'enabled')) {
      this.requests.clear(); this.render(); return;
    }
    for (const [id, value] of this.requests) {
      if (ACTIVE_REQUEST_STATUSES.has(value.status) && this.clock() - value.updatedAt >= STATUS_STALE_MS) {
        this.set(id, 'disconnected', value.updatedAt);
      }
    }
  }

  start() {
    for (const message of this.game.messages.contents) {
      this.update(message, message._stats?.lastModifiedBy, { restoring: true });
    }
    this.timer = setInterval(() => this.checkTimeouts(), 2000);
  }

  stop() { clearInterval(this.timer); this.requests.clear(); this.render(); }
}
