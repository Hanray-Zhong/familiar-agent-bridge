import { redact } from '../../src/runtime/logger.mjs';

const pending = {
  codex: '等待检查 Codex 与 Familiar 服务配置',
  world: '保存配对后，运行世界只读测试',
  push: '启动 Bridge 后，在 Foundry 中测试连接',
};

// 检测凭据只保存在本次应用内存中；停止服务不会抹掉上次结果。
export class ConnectionChecks {
  constructor() { this.reset(); }

  reset(keys = Object.keys(pending)) {
    for (const key of keys) this[key] = { state: 'untested', message: pending[key], checkedAt: null };
  }

  set(key, state, message) {
    message = redact(message);
    if (this[key]?.state === state && this[key]?.message === message) return;
    this[key] = { state, message, checkedAt: ['passed', 'failed'].includes(state) ? new Date().toISOString() : null };
  }

  beginWorld() {
    this.set('codex', 'checking', '正在检查 Codex 连接');
    this.set('world', 'checking', '正在只读验证 Familiar 与配对世界');
  }

  observe(status = {}) {
    if (status.codexConnected && ['starting', 'checking', 'running', 'paused'].includes(status.phase)) {
      this.set('codex', 'passed', 'Codex 与 Familiar 服务配置已验证');
    }
    if (!['running', 'paused'].includes(status.phase)) return;
    if (status.healthy) {
      this.set('codex', 'passed', 'Codex 与 Familiar 服务配置已验证');
      this.worldResult(status.world, status.mode === 'foundry');
    } else {
      this.set('world', 'failed', status.pauseReason || '世界连接不可用，请恢复连接后重试');
      if (status.codexConnected === false) this.set('codex', 'failed', 'Codex 未连接，请恢复连接或重新检查');
    }
    if (status.listening && status.relayVerifiedAt) {
      this.set('push', 'passed', '已收到配对 GM 的签名请求，推送连接验证通过');
    }
  }

  worldResult(world, paired) {
    this.set('world', paired ? 'passed' : 'untested', paired
      ? `世界只读验证通过：${world?.name || world?.id || '当前世界'}`
      : `已读取${world?.name || '当前世界'}；保存配对后重新测试`);
  }

  snapshot() { return Object.fromEntries(Object.keys(pending).map(key => [key, { ...this[key] }])); }
}
