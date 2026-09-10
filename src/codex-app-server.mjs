import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { JsonlConnection } from './codex/jsonl-connection.mjs';
import { inspectCodex, spawnServer, stopServer } from './codex/process.mjs';
import { serverArgs } from './codex/policy.mjs';
import { runTurn } from './codex/turn-runner.mjs';
import { listModels, validateModelSelection, modelThreadOptions, modelConfigurationError } from './codex/catalog.mjs';

export class CodexAppServer extends EventEmitter {
  constructor({ command = 'codex', cwd = process.cwd(), familiarServer = 'familiar', logger, requestTimeoutMs = 30000, readOnlyProbe = false, onProcessStarted, model, reasoningEffort } = {}) {
    super();
    Object.assign(this, { command, cwd, familiarServer, logger, requestTimeoutMs, readOnlyProbe, onProcessStarted, model, reasoningEffort });
    this.stopping = false;
  }

  async start() {
    if (this.child) throw new Error('App Server 已启动');
    this.stopping = false;
    const info = await inspectCodex(this.command, this.cwd);
    if (info.version !== 'codex-cli 0.153.4') {
      throw Object.assign(new Error(`未验证的 Codex 版本：${info.version}；请重新生成协议并验证后更新兼容范围`), { code: 'UNSUPPORTED_CODEX_VERSION' });
    }
    this.logger?.info('bridge', 'Codex App Server starting', { version: info.version });
    this.child = spawnServer(this.command, serverArgs(info.servers, this.familiarServer, { readOnlyProbe: this.readOnlyProbe }), this.cwd);
    const child = this.child;
    this.logger?.debug('codex', 'spawn requested', { pid: child.pid });
    this.connection = new JsonlConnection({ input: child.stdin, output: child.stdout, logger: this.logger, timeoutMs: this.requestTimeoutMs });
    const connection = this.connection;
    this.connection.on('notification', message => {
      if (message.method === 'error') this.logger?.error('codex', message.params?.error?.message ?? 'App Server error', { willRetry: message.params?.willRetry });
      this.emit('notification', message);
    });
    this.connection.on('serverRequest', message => this.emit('serverRequest', message));
    this.connection.on('disconnect', error => {
      this.emit('disconnected', error);
      if (!this.stopping) this.emit('unavailable', error);
    });
    this.stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    // 原始 stderr 可能含配置 secret / GM 数据，仅在 debug 下脱敏输出。
    this.stderr.on('line', line => this.logger?.debug('codex:stderr', line));
    child.on('error', error => connection.close(error));
    child.on('exit', (code, signal) => {
      connection.close(new Error(`App Server 退出 code=${code} signal=${signal}`));
      this.logger?.[this.stopping ? 'info' : 'error']('codex', 'App Server exited', { code, signal, pid: child.pid });
    });
    try {
      await child.processTree?.start();
      await this.onProcessStarted?.(child.pid);
      const response = await this.request('initialize', {
        clientInfo: { name: 'familiar_agent_bridge', title: 'Familiar Agent Bridge', version: '0.3.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.connection.notify('initialized');
      this.logger?.info('codex', 'initialized', { userAgent: response.userAgent, pid: child.pid });
      if (this.model || this.reasoningEffort) {
        this.models = await listModels(this);
        validateModelSelection(this.models, this);
      }
      return response;
    } catch (error) {
      this.logger?.error('codex', error.message);
      await this.stop();
      throw error;
    }
  }

  request(method, params, timeoutMs) {
    if (!this.connection) return Promise.reject(new Error('App Server 尚未启动'));
    return this.connection.request(method, params, timeoutMs);
  }

  async startThread(options = {}) {
    const result = await this.request('thread/start', { ...modelThreadOptions(this, options), ephemeral: false });
    return this.verifySelection(result);
  }

  async resumeThread(threadId, options = {}) {
    const result = await this.request('thread/resume', { ...modelThreadOptions(this, options), threadId, excludeTurns: true });
    return this.verifySelection(result);
  }

  verifySelection(result) {
    if (this.model || this.reasoningEffort) {
      if (!result?.model) throw modelConfigurationError('Codex 未返回实际模型，无法核验 model / effort 配置');
      validateModelSelection(this.models, { model: result.model, reasoningEffort: this.reasoningEffort });
      if ((this.model && result.model !== this.model) || (this.reasoningEffort && result.reasoningEffort !== this.reasoningEffort)) {
        throw modelConfigurationError('Codex 未应用指定的 model / effort，已停止处理；请检查配置和模型支持情况');
      }
    }
    return result;
  }

  runTurn(threadId, prompt, options) {
    return runTurn(this, threadId, prompt, { model: this.model, effort: this.reasoningEffort, ...options });
  }

  interruptActive(reason) { return this.activeTurn?.cancel(reason) ?? Promise.resolve(); }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.connection?.close();
      await stopServer(this.child);
      this.stderr?.close();
      this.child = null;
    })();
    try { await this.stopPromise; } finally { this.stopPromise = null; }
  }
}
