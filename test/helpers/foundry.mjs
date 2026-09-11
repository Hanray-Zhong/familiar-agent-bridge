import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { MODULE_ID } from '../../foundry-module/shared/protocol.mjs';

export async function pairing() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return { protocol: 1, worldId: 'world', relayUserId: 'gm', secret: randomBytes(32).toString('base64url'),
    bridgeUrl: `http://127.0.0.1:${port}`, allowedOrigins: ['http://localhost:30000'], captureSince: Date.now() - 60000 };
}

export function gameFixture(pair) {
  const users = [{ id: 'gm', name: '主持人', isGM: true }, { id: 'alice', name: 'Alice', isGM: false }, { id: 'bob', name: 'Bob', isGM: false }];
  const settings = new Map([
    [`${MODULE_ID}.enabled`, true], [`${MODULE_ID}.enabledSince`, 0], [`${MODULE_ID}.relayUserId`, 'gm'],
    [`${MODULE_ID}.allowGmRequests`, false], [`${MODULE_ID}.pairing`, pair], [`${MODULE_ID}.outboxes`, {}], ['familiar.tableChatEnabled', false],
  ]);
  return { world: { id: pair.worldId }, user: users[0], users: { contents: users, get: id => users.find(user => user.id === id) },
    messages: { contents: [], get(id) { return this.contents.find(message => message.id === id); } }, modules: new Map([['familiar', { active: true }]]),
    settings: { get: (module, key) => structuredClone(settings.get(`${module}.${key}`)),
      set: async (module, key, value) => { settings.set(`${module}.${key}`, structuredClone(value)); } } };
}

export function message(game, id = 'msg1', fields = {}) {
  return { id, author: game.users.get('alice'), content: '@familiar 我检查门', timestamp: Date.now(),
    _stats: { createdTime: Date.now() }, flags: {}, speaker: {}, whisper: [], rolls: [], visible: true, isContentVisible: true,
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      this.flags[scope][key] = structuredClone(value);
      this._stats.lastModifiedBy = game.user.id;
    }, ...fields };
}

export class FakeLocks {
  held = new Set();
  async request(name, _options, callback) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
}
