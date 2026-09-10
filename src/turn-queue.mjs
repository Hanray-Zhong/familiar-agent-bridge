import { EventEmitter } from 'node:events';

export class RetryLater extends Error {
  constructor(message) { super(message); this.code = 'RETRY_LATER'; }
}

export class TurnQueue extends EventEmitter {
  constructor(worker, { maxSize = 1000 } = {}) {
    super();
    Object.assign(this, { worker, maxSize });
    this.waiting = [];
    this.jobs = new Map();
    this.paused = true;
    this.accepting = true;
    this.active = null;
    this.idleWaiters = [];
  }

  enqueue(event) {
    if (!this.accepting) return Promise.reject(new Error('Queue 已关闭'));
    if (this.jobs.has(event.id)) return this.jobs.get(event.id).promise;
    if (this.jobs.size >= this.maxSize) return Promise.reject(new Error('Queue 已满'));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { event, promise, resolve, reject };
    this.jobs.set(event.id, job);
    this.waiting.push(job);
    this.emit('queued', event);
    this.pump();
    return promise;
  }

  pause(reason) {
    this.paused = true;
    this.emit('paused', reason);
  }

  resume() {
    this.paused = false;
    this.pump();
  }

  pump() {
    if (this.active || this.paused || !this.waiting.length) { this.settleIdle(); return; }
    const job = this.waiting.shift();
    this.active = job;
    void (async () => {
      let retry = false;
      try { job.resolve(await this.worker(job.event)); }
      catch (error) {
        if (error.code === 'RETRY_LATER' && this.accepting) {
          retry = true;
          this.waiting.unshift(job);
          this.pause(error.message);
        } else {
          job.reject(error);
          this.emit('failed', { event: job.event, error });
        }
      } finally {
        if (!retry) this.jobs.delete(job.event.id);
        this.active = null;
        this.settleIdle();
        this.pump();
      }
    })();
  }

  settleIdle() {
    if (this.active || this.waiting.length) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  idle() {
    if (!this.active && !this.waiting.length) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  close({ drain = true } = {}) {
    this.accepting = false;
    if (!drain) {
      this.paused = true;
      for (const job of this.waiting.splice(0)) {
        const error = new Error('Queue 关闭，尚未执行的事件保留在持久化存储中');
        error.code = 'QUEUE_CLOSED';
        job.reject(error);
        this.jobs.delete(job.event.id);
      }
    }
    this.settleIdle();
    return this.idle();
  }
}
