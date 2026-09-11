import { MODULE_ID } from './shared/protocol.mjs';
import { htmlToText } from './relay/message.mjs';
import { RelayController } from './relay/controller.mjs';
import { settingsApplication } from './ui/settings.mjs';
import { RequestFeedback } from './ui/request-feedback.mjs';

let controller;
let feedback;
const textOf = message => htmlToText(message.content ?? '', document);
const notify = (text, level = 'warn') => ui.notifications[level](text);
const restart = async () => {
  await controller?.stop();
  controller = new RelayController({ game, locks: navigator.locks, notify,
    textOf });
  controller.start();
};

Hooks.once('init', () => {
  for (const [key, scope, type, value] of [
    ['enabled', 'world', Boolean, false], ['enabledSince', 'world', Number, 0],
    ['relayUserId', 'world', String, ''], ['allowGmRequests', 'world', Boolean, false],
    ['pairing', 'client', Object, {}], ['outboxes', 'client', Object, {}],
  ]) game.settings.register(MODULE_ID, key, { name: key, scope, type, default: value, config: false });
  game.settings.registerMenu(MODULE_ID, 'connection', { name: 'Familiar Agent Bridge', label: '配置 Bridge 推送',
    hint: '导入本机配对文件、选择 GM 中继并启用 @familiar。', icon: 'fa-solid fa-link', restricted: true,
    type: settingsApplication({ game, ApplicationV2: foundry.applications.api.ApplicationV2, notify, restart, controller: () => controller }) });
});

Hooks.once('ready', () => {
  feedback = new RequestFeedback({ game, notifications: ui.notifications, textOf });
  feedback.start();
  if (game.user.isGM) void restart().catch(error => notify(error.message, 'error'));
});
Hooks.on('createChatMessage', (message, _options, userId) => {
  feedback?.observe(message, userId);
  void controller?.observe(message, userId).catch(error => notify(error.message, 'error'));
});
Hooks.on('updateChatMessage', (message, _changed, _options, userId) => feedback?.update(message, userId));
Hooks.on('deleteChatMessage', message => feedback?.remove(message.id));
window.addEventListener('beforeunload', () => { feedback?.stop(); void controller?.stop(); });
