import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function prepareDevelopmentData(app, sourceRoot, env = process.env) {
  if (app.isPackaged) return;
  const directory = resolve(env.FAMILIAR_BRIDGE_APP_DATA || join(sourceRoot, 'data/desktop'));
  // Electron setPath 要求目录先存在，并且应在 ready 之前设置。
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath('userData', directory);
}
