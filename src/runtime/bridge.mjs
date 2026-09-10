import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { CodexAppServer } from '../codex-app-server.mjs';
import { TurnQueue, RetryLater } from '../turn-queue.mjs';
import { ThreadStore } from '../thread-store.mjs';
import { buildPlayerTurnPrompt } from '../prompt-builder.mjs';
import { normalizeEvent } from '../event-source/base.mjs';
import { acquireLock } from '../storage/instance-lock.mjs';
import { threadOptions } from '../codex/policy.mjs';
import { checkFamiliar, guardGameItem, verifyAgent } from './familiar-health.mjs';

export class Bridge extends EventEmitter {
  constructor(config, logger, { codex, store, health = checkFamiliar } = {}) {
    super();
    Object.assign(this, { config, logger, health });
    this.codex = codex ?? new CodexAppServer({ ...config, logger, onProcessStarted: async pid => {
      for (const release of this.releases) await release.setRuntimePid(pid);
    } });
    this.store = store ?? new ThreadStore(config.stateFile, { maxQueued: config.queueLimit });
    this.queue = new TurnQueue(event => this.processEvent(event), { maxSize: config.queueLimit });
    this.admission = Promise.resolve();
    this.releases = [];
    this.restarts = 0;
    this.healthy = false;
    this.stopping = false;
    this.manualPause = false;
    this.queue.on('queued', event => logger.info('queue', 'queued message', { id: event.id }));
    this.codex.on('unavailable', error => {
      this.pause(error.message);
      void this.codex.stop().catch(cleanupError => this.fatal(cleanupError));
    });
    this.codex.on('notification', ({ method, params }) => {
      if (method === 'mcpServer/startupStatus/updated' && params?.name === config.familiarServer && ['failed', 'cancelled'].includes(params.status)) {
        this.pause(`Familiar MCP ${params.status}`);
        void this.codex.interruptActive().catch(error => this.fatal(error));
      }
    });
  }

  async start({ inspectionOnly = false } = {}) {
    this.inspectionOnly = inspectionOnly;
    this.releases.push(await acquireLock(this.config.lockFile));
    this.releases.push(await acquireLock(`${this.config.stateFile}.lock`));
    const previous = await this.store.load();
    if (this.config.threadId && previous.threadId && this.config.threadId !== previous.threadId) {
      throw new Error('CODEX_THREAD_ID 与状态文件保存的对话不同；请先备份并处理旧待办，再在“对话与模型”新开跑团会话，最后选择目标对话');
    }
    const uncertain = previous.receipts.filter(receipt => receipt.status === 'uncertain');
    if (uncertain.length) this.logger.warn('state', '存在结果不确定的历史事件，请在 Foundry 核对；不会自动重放', { ids: uncertain.map(receipt => receipt.id) });
    this.instructions = await readFile(this.config.instructionsFile, 'utf8');
    if (!inspectionOnly) for (const event of this.store.snapshot().queued) this.submit(event);
    await this.recover();
    this.scheduleHealth();
  }

  submit(event) {
    this.queue.enqueue(event).catch(error => {
      if (error.code !== 'QUEUE_CLOSED') this.logger.error('event', '处理失败', { id: event.id, code: error.code ?? 'TURN_FAILED', message: error.message });
    });
  }

  accept(input) {
    if (this.stopping) return Promise.reject(new Error('Bridge 正在关闭'));
    const operation = this.admission.then(async () => {
      const event = normalizeEvent(input);
      if (!event) return { accepted: false, reason: 'agent-reply' };
      const world = this.store.snapshot().world;
      if (event.metadata.worldId && world?.id && event.metadata.worldId !== world.id) throw Object.assign(new Error('事件来自其他 Foundry World'), { code: 'WORLD_CHANGED' });
      const accepted = await this.store.enqueue(event);
      if (accepted) {
        this.logger.info('event', '收到玩家请求', { id: event.id, player: event.player, characters: event.text.length });
        this.submit(event);
      } else this.logger.info('event', 'duplicate ignored', { id: event.id });
      return { accepted, id: event.id };
    });
    this.admission = operation.catch(error => { if (error.code === 'STORE_FAILURE') this.fatal(error); });
    return operation;
  }

  pause(reason, manual = false) {
    this.healthy = false;
    this.manualPause ||= manual;
    this.queue.pause(reason);
    if (!this.stopping) this.logger.warn('bridge', 'Queue paused', { reason, action: this.manualPause ? '由管理员核对后点击“恢复连接”' : '等待连接恢复' });
    this.emit('paused');
  }

  fatal(error) { this.pause(error.message, true); }

  async recover({ manual = false } = {}) {
    if (this.recovering) return this.recovering;
    if (this.stopping || this.queue.active) return;
    if (manual) { this.manualPause = false; this.restarts = 0; }
    if (this.manualPause) return;
    this.recovering = (async () => {
      try {
        if (!this.codex.child || this.codex.connection?.closed) {
          if (this.everStarted && this.restarts >= this.config.maxRestarts) {
            this.pause('App Server 已达到自动重启次数上限', true); return;
          }
          if (this.everStarted) this.restarts++;
          this.everStarted = true;
          this.attached = false;
          await this.codex.stop();
          if (this.stopping) return;
          await this.codex.start();
          const saved = this.store.snapshot().threadId ?? this.config.threadId;
          const options = threadOptions(this.config.cwd, this.instructions);
          const result = saved ? await this.codex.resumeThread(saved, options) : await this.codex.startThread(options);
          if (result.sandbox?.type !== 'readOnly' || result.approvalPolicy !== 'never') {
            throw Object.assign(new Error('App Server 未应用要求的最小权限，禁止处理玩家输入'), { code: 'SECURITY_VIOLATION' });
          }
          this.threadId = result.thread.id;
          if (saved && this.threadId !== saved) throw Object.assign(new Error('Codex 恢复了与请求不同的对话，禁止继续'), { code: 'THREAD_CONFIGURATION' });
          this.model = result.model ?? null;
          this.reasoningEffort = result.reasoningEffort ?? null;
          this.attached = true;
          if (!this.store.snapshot().threadId) await this.store.saveThread(this.threadId);
          this.logger.info('thread', saved ? 'resumed' : 'started', { threadId: this.threadId });
          this.logger.info('codex', '本次对话配置', { model: this.model, effort: this.reasoningEffort });
        }
        if (this.stopping) return;
        const { world } = await this.health(this.codex, this.threadId, { timeoutMs: this.config.healthTimeoutMs });
        await this.bindWorld(world);
        this.healthy = true;
        this.logger.info('health', 'Familiar / Foundry ready', { world });
        if (!this.inspectionOnly) this.queue.resume();
        this.emit('ready');
      } catch (error) {
        if (['WORLD_CHANGED', 'STORE_FAILURE', 'SECURITY_VIOLATION', 'UNSUPPORTED_CODEX_VERSION', 'MODEL_CONFIGURATION', 'THREAD_CONFIGURATION'].includes(error.code)) this.fatal(error);
        else this.pause(error.message);
        if (error.restartRequired && !this.stopping && !this.codex.connection?.closed) {
          await this.codex.request('config/mcpServer/reload').catch(() => this.codex.stop());
        }
        if (!this.attached || this.codex.connection?.closed) await this.codex.stop();
      }
    })();
    try { await this.recovering; } finally { this.recovering = null; }
  }

  scheduleHealth() {
    clearTimeout(this.healthTimer);
    if (this.stopping) return;
    this.healthTimer = setTimeout(() => {
      this.healthWork = (async () => {
      try {
        if (!this.queue.active && !this.manualPause) {
          if (!this.healthy) await this.recover();
          else {
            const { world } = await this.health(this.codex, this.threadId, { timeoutMs: this.config.healthTimeoutMs });
            await this.bindWorld(world);
          }
        }
      } catch (error) { this.pause(error.message, error.code === 'WORLD_CHANGED' || error.code === 'STORE_FAILURE'); }
      finally { this.scheduleHealth(); }
      })();
    }, this.config.healthIntervalMs);
  }

  async processEvent(event) {
    if (!this.healthy || this.stopping) throw new RetryLater('Bridge 尚未就绪');
    try {
      const { world } = await this.health(this.codex, this.threadId, { timeoutMs: this.config.healthTimeoutMs });
      await this.bindWorld(world);
      if (event.metadata?.worldId && event.metadata.worldId !== world.id) throw Object.assign(new Error('排队事件来自其他 Foundry World'), { code: 'WORLD_CHANGED' });
    } catch (error) {
      this.pause(error.message, error.code === 'WORLD_CHANGED' || error.code === 'STORE_FAILURE');
      throw new RetryLater(error.message);
    }
    if (this.stopping) throw new RetryLater('Bridge 正在关闭');
    try { await this.store.begin(event.id); }
    catch (error) { this.fatal(error); throw error; }
    try {
      const result = await this.codex.runTurn(this.threadId, buildPlayerTurnPrompt(event), {
        timeoutMs: this.config.turnTimeoutMs, eventId: event.id,
        onItem: (item, method) => {
          try { guardGameItem(this.codex, item, method); }
          catch (error) { this.pause(error.message, error.code === 'SECURITY_VIOLATION'); throw error; }
        },
      });
      const calls = result.items.filter(item => item.type === 'mcpToolCall' && item.server === this.config.familiarServer && item.status === 'completed');
      if (!calls.some(item => item.tool.replaceAll('_', '-') === 'get-world-info') ||
          !calls.some(item => item.tool.replaceAll('_', '-') === 'send-chat-message')) {
        throw new Error('Turn 缺少实际世界读取或 Foundry Chat 发送回执；不能将口头描述标为已处理');
      }
      await this.store.finish(event.id, 'processed', result.turn.id);
      this.logger.info('event', 'processed', { id: event.id });
    } catch (error) {
      if (error.code === 'STORE_FAILURE') { this.fatal(error); throw error; }
      await this.store.finish(event.id, 'uncertain').catch(storeError => { this.fatal(storeError); throw storeError; });
      if (['TURN_TIMEOUT', 'SECURITY_VIOLATION'].includes(error.code)) this.pause(error.message, true);
      else if (['DISCONNECTED', 'FAMILIAR_UNAVAILABLE', 'REQUEST_TIMEOUT'].includes(error.code) || this.codex.connection?.closed) this.pause(error.message);
      throw error;
    }
  }

  status() {
    const state = this.store.snapshot();
    return { threadId: state.threadId, world: state.world, healthy: this.healthy, paused: this.queue.paused,
      model: this.model ?? null, reasoningEffort: this.reasoningEffort ?? null,
      queued: state.queued.length, inFlight: state.inFlight?.event.id ?? null, lastProcessedMessageId: state.lastProcessedMessageId,
      uncertain: state.receipts.filter(receipt => receipt.status === 'uncertain').length, restarts: this.restarts };
  }

  async bindWorld(world) {
    if (this.config.expectedWorldId && world.id !== this.config.expectedWorldId) {
      throw Object.assign(new Error('Familiar 当前世界与 Foundry 推送配对的世界不一致'), { code: 'WORLD_CHANGED' });
    }
    await this.store.bindWorld(world);
  }

  async doctor() {
    if (!this.healthy) throw new Error('Familiar 未就绪，无法进行 Agent 验证');
    return verifyAgent(this.codex, this.threadId, { timeoutMs: this.config.turnTimeoutMs });
  }

  async drain() {
    await this.admission;
    if (this.queue.paused) return;
    let onPause;
    const paused = new Promise(resolve => { onPause = resolve; this.once('paused', onPause); });
    try { await Promise.race([this.queue.idle(), paused]); }
    finally { this.off('paused', onPause); }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    clearTimeout(this.healthTimer);
    this.stopPromise = (async () => {
      await this.admission;
      const idle = this.queue.close({ drain: false });
      let timer;
      try {
        const completed = await Promise.race([idle.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.config.shutdownTimeoutMs); })]);
        if (!completed) await this.codex.interruptActive();
      } finally { clearTimeout(timer); }
      await this.codex.stop();
      await this.recovering;
      await this.healthWork;
      // recover 可能在前一个 await 后才完成启动；二次 stop 不启动新进程。
      await this.codex.stop();
      await idle;
      await this.store.tail;
      for (const release of this.releases.reverse()) await release();
      this.releases = [];
      this.logger.info('bridge', '已关闭，尚未执行的事件已保留');
    })();
    return this.stopPromise;
  }
}
