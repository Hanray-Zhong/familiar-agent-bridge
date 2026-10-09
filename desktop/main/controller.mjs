import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, redact } from '../../src/runtime/logger.mjs';
import { CodexAppServer } from '../../src/codex-app-server.mjs';
import { inspectCodex } from '../../src/codex/process.mjs';
import { listModels, listThreads } from '../../src/codex/catalog.mjs';
import { acquireLock } from '../../src/storage/instance-lock.mjs';
import { ThreadStore } from '../../src/thread-store.mjs';
import { configurePairing, publicPairing } from '../../src/foundry/pairing-management.mjs';
import { loadPairing } from '../../src/foundry/pairing.mjs';
import { modulePackageInfo, packageFoundryModule } from '../../src/foundry/module-package.mjs';
import { preparePath, findCodex } from './environment.mjs';
import { DesktopSession } from './session.mjs';
import { pendingReviewCount, reviewIssuesFromState } from '../../src/runtime/reviews.mjs';
import { gmMessagesFromState } from '../../src/runtime/desktop-conversation.mjs';
import { ConnectionChecks } from './connection-checks.mjs';

export class DesktopController extends EventEmitter {
  constructor(profile, { SessionClass = DesktopSession, ClientClass = CodexAppServer, inspect = inspectCodex } = {}) {
    super(); Object.assign(this, { profile, SessionClass, ClientClass, inspect });
    this.logs = []; this.aiResponses = []; this.models = []; this.threads = []; this.environment = null;
    this.connections = new ConnectionChecks();
  }

  notify() { this.emit('change'); }
  logger(level) {
    return createLogger({ level, output: { write: line => {
      this.logs.push({ id: randomUUID(), text: line.trim().slice(0, 6000) });
      this.logs = this.logs.slice(-300); this.notify();
    } } });
  }

  recordResponse(response) {
    this.aiResponses.push(response);
    this.aiResponses = this.aiResponses.slice(-100);
    this.notify();
  }

  async snapshot() {
    const profile = this.profile.snapshot();
    let pairing = null, stored = {}, reviewIssues = [], gmMessages = [], notice = '', paths = {};
    try {
      const config = await this.profile.config();
      paths = { rules: config.instructionsFile, state: config.stateFile, pairing: config.foundryPairingFile };
      try { pairing = publicPairing(await loadPairing(config.foundryPairingFile)); }
      catch (error) { if (error.code !== 'ENOENT') notice = redact(error.message); }
      try {
        const state = JSON.parse(await readFile(config.stateFile, 'utf8'));
        reviewIssues = reviewIssuesFromState(state);
        gmMessages = gmMessagesFromState(state);
        stored = { threadId: state.threadId, world: state.world ? { id: state.world.id, name: state.world.name } : null, queued: state.queued?.length ?? 0,
          uncertain: pendingReviewCount(state) };
      } catch (error) { if (error.code !== 'ENOENT') notice = '会话状态文件无法读取，请保留原文件并检查'; }
    } catch (error) { notice = redact(error.message); }
    return { profile, paths, pairing, notice, modulePackage: this.modulePackage || null, status: { ...stored, phase: 'stopped', ...this.session?.status() },
      busy: this.busy || null, environment: this.environment, connections: this.connections.snapshot(), models: this.models, threads: this.threads, logs: this.logs,
      aiResponses: this.aiResponses, reviewIssues, gmMessages };
  }

  idle() {
    if (this.session && this.session.phase !== 'stopped') throw new Error('请先停止 Bridge，再修改设置或执行检查');
  }
  async run(label, operation) {
    if (this.closing) throw new Error('应用正在关闭');
    if (this.operation) throw new Error('请等待当前操作完成');
    this.busy = label; this.notify();
    this.operation = Promise.resolve().then(operation);
    try { return await this.operation; }
    finally { this.operation = null; this.busy = null; this.notify(); }
  }
  async config() {
    const config = await this.profile.config();
    process.env.PATH = await preparePath(config.command);
    return config;
  }
  async locks(config) {
    const releases = [await acquireLock(config.lockFile)];
    try { releases.push(await acquireLock(`${config.stateFile}.lock`)); return releases; }
    catch (error) { await releases[0](); throw error; }
  }
  async locked(operation) {
    const config = await this.config(), releases = await this.locks(config);
    try { return await operation(config); }
    finally { for (const release of releases.reverse()) await release(); }
  }
  async withClient(operation) {
    this.idle();
    const config = await this.config(), releases = await this.locks(config);
    const client = new this.ClientClass({ ...config, model: undefined, reasoningEffort: undefined, readOnlyProbe: true,
      logger: this.logger(config.logLevel), onProcessStarted: async pid => { for (const release of releases) await release.setRuntimePid(pid); } });
    this.client = client;
    this.clientLease = { client, releases };
    try { await client.start(); return await operation(client); }
    finally { await this.closeClient(); }
  }
  async closeClient() {
    const lease = this.clientLease;
    if (!lease) return;
    if (lease.closing) return lease.closing;
    lease.closing = (async () => {
      await lease.client.stop(); // 清理失败保留锁；再次关闭成功后释放剩余的锁。
      while (lease.releases.length) { await lease.releases.at(-1)(); lease.releases.pop(); }
      this.clientLease = null; this.client = null;
    })();
    try { await lease.closing; } finally { lease.closing = null; }
  }

  saveSettings(values) { return this.run('保存设置', async () => { this.idle(); const result = await this.profile.save(values); this.environment = null; this.connections.reset(); return result; }); }
  importProject(path) { return this.run('接管旧版跑团数据', async () => { this.idle(); const result = await this.profile.importProject(path); this.environment = null; this.connections.reset(); this.session = null; return result; }); }
  async detectCodex() {
    return this.run('查找 Codex', async () => {
      this.idle(); const command = await findCodex(await preparePath());
      await this.profile.save({ ...this.profile.data.values, CODEX_COMMAND: command });
      this.environment = null; this.connections.reset();
      return command;
    });
  }
  checkEnvironment() {
    return this.run('检查 Codex', async () => {
      this.idle(); this.environment = null;
      this.connections.set('codex', 'checking', '正在检查 Codex 与 Familiar 服务配置'); this.notify();
      try {
        const config = await this.config();
        const environment = await this.inspect(config.command, config.cwd);
        if (environment.version !== 'codex-cli 0.153.4') throw new Error(`当前 ${environment.version}，需要已适配的 codex-cli 0.153.4`);
        if (!environment.servers.some(server => server.name === config.familiarServer && server.enabled)) throw new Error('Codex 中没有启用指定的 Familiar 服务，请在 Familiar 的 MCP / Subs 页完成连接');
        this.environment = { ...environment, compatible: true };
        this.connections.set('codex', 'passed', `${environment.version} · Familiar 服务配置已验证`);
        return this.environment;
      } catch (error) {
        this.connections.set('codex', 'failed', error.message); this.connections.reset(['world', 'push']); throw error;
      }
    });
  }
  fetchModels() { return this.run('读取模型列表', () => this.withClient(async client => {
    this.models = (await listModels(client)).map(({ model, displayName, defaultReasoningEffort, supportedReasoningEfforts, hidden, isDefault }) =>
      ({ model, displayName, defaultReasoningEffort, supportedReasoningEfforts, hidden, isDefault }));
    return this.models;
  })); }
  fetchThreads(query = {}) {
    if (!query || typeof query.search !== 'string' || query.search.length > 200) throw new Error('对话搜索内容无效');
    return this.run('读取对话列表', () => this.withClient(async client => {
      const page = await listThreads(client, { searchTerm: query.search });
      this.threads = page.data.map(({ id, name, updatedAt }) => ({ id, name: name || '未命名对话', updatedAt })); return this.threads;
    }));
  }

  start(mode = 'foundry') {
    if (!['foundry', 'manual'].includes(mode)) throw new Error('不支持的启动方式');
    return this.run('启动 Bridge', async () => {
      this.idle(); const config = await this.config();
      this.connections.reset(); this.connections.beginWorld();
      this.createSession(config);
      try { await this.session.start({ mode }); }
      catch (error) { this.connections.set('world', 'failed', error.message); throw error; }
      finally {
        this.connections.observe(this.session.status?.());
        if (this.connections.codex.state === 'checking') this.connections.set('codex', 'untested', '启动未完成，请检查 Codex');
        if (this.session.phase === 'stopped' && this.connections.world.state === 'checking') this.connections.reset(['world']);
      }
    });
  }
  createSession(config) {
    this.session = new this.SessionClass(config, this.logger(config.logLevel), () => {
      this.connections.observe(this.session?.status?.()); this.notify();
    }, { onResponse: response => this.recordResponse(response) });
  }
  async stop() { await this.session?.stop(); this.notify(); }
  recover() { return this.run('恢复连接', async () => {
    if (!this.session?.bridge) throw new Error('请先启动 Bridge');
    await this.session.bridge.recover({ manual: true });
  }); }
  doctor() { return this.run('只读链路检查', async () => {
    this.idle(); this.connections.beginWorld(); this.notify();
    try {
      const config = await this.config();
      let pairing = null, world;
      try { pairing = await loadPairing(config.foundryPairingFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.createSession(config);
      try {
        await this.session.start({ mode: pairing ? 'foundry' : 'manual', inspectionOnly: true });
        if (!this.session.stopRequested && !this.closing) {
          world = await this.session.bridge.doctor();
          if (pairing && world.id !== pairing.worldId) throw new Error('只读测试返回的世界与当前配对不一致');
        }
      } finally { await this.session.stop(); }
      if (!world || this.closing) { this.connections.reset(['codex', 'world']); return; }
      this.connections.set('codex', 'passed', 'Codex 与 Familiar 服务配置已验证');
      this.connections.worldResult(world, Boolean(pairing));
      this.logger('info').info('doctor', '只读连接验证通过', { world });
      return world;
    } catch (error) {
      this.connections.set('world', 'failed', error.message);
      if (this.connections.codex.state === 'checking') this.connections.set('codex', 'untested', '链路检查未完成，请检查 Codex');
      throw error;
    }
  }); }
  async sendMessage(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('请求不能为空且不能超过 16000 字符');
    if (!this.session?.activated) throw new Error('请先启动 Bridge');
    return this.session.bridge.accept({ id: randomUUID(), type: 'player-message', player: this.profile.data.values.TEST_PLAYER || '玩家',
      text, timestamp: new Date().toISOString(), metadata: { source: 'desktop', origin: 'player' } });
  }
  reviewMessage(value) {
    if (!value || typeof value.id !== 'string' || typeof value.text !== 'string') throw new Error('审核请求无效');
    return this.run('AI 正在核对世界状态', async () => {
      if (!this.session?.activated || !this.session.bridge) throw new Error('请先启动 Bridge，再处理待审核项');
      return this.session.bridge.requestReview(value.id, value.text);
    });
  }
  gmMessage(text) {
    if (typeof text !== 'string') throw new Error('GM 要求无效');
    return this.run('AI 正在执行 GM 要求', async () => {
      if (!this.session?.activated || !this.session.bridge) throw new Error('请先启动 Bridge，再使用 GM 控制台');
      return this.session.bridge.requestGmMessage(text);
    });
  }
  setReviewResolved(value) {
    if (!value || typeof value.id !== 'string' || typeof value.resolved !== 'boolean') throw new Error('审核状态无效');
    return this.run(value.resolved ? '关闭待审核项' : '重新打开待审核项', async () => {
      if (this.session?.bridge) return this.session.bridge.setReviewResolved(value.id, value.resolved);
      return this.locked(async config => {
        const store = new ThreadStore(config.stateFile); await store.load();
        return store.setReviewResolved(value.id, value.resolved);
      });
    });
  }
  configurePairing(value) { return this.run('保存配对', async () => {
    this.idle();
    if (!value || typeof value.worldId !== 'string' || typeof value.relayUserId !== 'string' || typeof value.origins !== 'string' || value.origins.length > 2000) throw new Error('配对设置无效');
    const result = await this.locked(config => configurePairing({ file: config.foundryPairingFile, stateFile: config.stateFile,
      worldId: value.worldId.trim(), relayUserId: value.relayUserId.trim(), origins: value.origins.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
      port: value.port, rotate: value.rotate === true }));
    this.connections.reset(['world', 'push']);
    return publicPairing(result.pairing);
  }); }
  importPairing(path) { return this.run('导入配对', async () => {
    this.idle(); await loadPairing(path);
    await this.profile.save({ ...this.profile.data.values, FOUNDRY_PUSH_CONFIG: path });
    this.connections.reset(['world', 'push']);
  }); }
  moduleInfo() { return modulePackageInfo(join(this.profile.resources, 'foundry-module')); }
  exportModule(path) { return this.run('导出 Foundry 模块安装包', async () => {
    this.idle();
    this.modulePackage = await packageFoundryModule(join(this.profile.resources, 'foundry-module'), path);
    return this.modulePackage;
  }); }
  getRules() { return this.profile.rules(); }
  saveRules(text) { return this.run('保存主持规则', async () => { this.idle(); await this.locked(() => this.profile.saveRules(text)); }); }
  resetSession() { return this.run('新建跑团会话', async () => {
    this.idle(); await this.locked(async config => {
      const store = new ThreadStore(config.stateFile); await store.load();
      await this.profile.save({ ...this.profile.data.values, CODEX_THREAD_ID: '' });
      await store.reset();
    }); this.session = null; this.connections.reset();
  }); }
  async shutdown() {
    this.closing = true;
    await this.stop();
    await this.operation?.catch(() => {});
    await this.closeClient();
  }
}
