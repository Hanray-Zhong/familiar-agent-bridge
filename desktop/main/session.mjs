import { Bridge } from '../../src/runtime/bridge.mjs';
import { FoundryEventSource } from '../../src/event-source/foundry.mjs';
import { loadPairing } from '../../src/foundry/pairing.mjs';

export class DesktopSession {
  constructor(config, logger, changed, { BridgeClass = Bridge, SourceClass = FoundryEventSource, readPairing = loadPairing, onResponse = () => {} } = {}) {
    Object.assign(this, { config, logger, changed, BridgeClass, SourceClass, readPairing, onResponse });
    this.phase = 'stopped';
  }

  start({ mode = 'foundry', inspectionOnly = false } = {}) {
    if (this.starting || this.bridge) throw new Error('Bridge 已在运行或启动中');
    this.stopRequested = false;
    this.phase = inspectionOnly ? 'checking' : 'starting';
    this.changed();
    this.starting = (async () => {
      try {
        const pairing = mode === 'foundry' ? await this.readPairing(this.config.foundryPairingFile) : null;
        const config = { ...this.config, ...(pairing ? { expectedWorldId: pairing.worldId } : {}), ...(inspectionOnly ? { readOnlyProbe: true } : {}) };
        this.bridge = new this.BridgeClass(config, this.logger);
        this.bridge.on('response', this.onResponse);
        this.bridge.on('ready', () => { if (!inspectionOnly && this.activated && !this.stopRequested) this.phase = 'running'; this.changed(); });
        this.bridge.on('paused', () => { if (this.activated && !this.stopRequested) this.phase = 'paused'; this.changed(); });
        // 先挂接并检查，端口监听完成后才允许旧待办执行。停止请求不会启动队列。
        await this.bridge.start({ inspectionOnly: true });
        if (this.stopRequested || inspectionOnly) return;
        if (pairing) {
          this.source = new this.SourceClass({ pairing, accept: event => this.bridge.accept(event), status: () => this.bridge.status(),
            receipts: ids => this.bridge.store.foundryStatuses(ids), logger: this.logger });
          this.source.on('failure', error => { this.logger.error('foundry', error.message); void this.stop().catch(e => this.logger.error('desktop', e.message)); });
          await this.source.start();
        }
        if (this.stopRequested) return;
        this.activated = true;
        this.bridge.inspectionOnly = false;
        for (const event of this.bridge.store.snapshot().queued) this.bridge.submit(event);
        if (this.bridge.healthy) this.bridge.queue.resume();
        this.phase = this.bridge.healthy ? 'running' : 'paused';
      } catch (error) {
        await this.source?.stop();
        await this.bridge?.stop();
        this.bridge = null;
        this.source = null;
        this.phase = 'stopped';
        throw error;
      } finally { this.changed(); }
    })();
    return this.starting.finally(() => { this.starting = null; });
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopRequested = true;
    this.phase = 'stopping';
    this.changed();
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      await this.source?.stop();
      await this.bridge?.stop();
      this.bridge = null;
      this.source = null;
      this.activated = false;
      this.phase = 'stopped';
      this.changed();
    })();
    return this.stopping.finally(() => { this.stopping = null; });
  }

  status() {
    if (!this.bridge?.store?.state) return { phase: this.phase, healthy: false, inFlight: null };
    return { ...this.bridge.status(), phase: this.phase, listening: Boolean(this.source) };
  }
}
