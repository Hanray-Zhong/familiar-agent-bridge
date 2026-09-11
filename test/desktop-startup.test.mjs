import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectRoot } from '../src/runtime/config.mjs';

const execute = promisify(execFile);
const electronUrl = new URL('./helpers/desktop-electron.mjs', import.meta.url).href;
const entryUrl = new URL('../desktop/main/index.mjs', import.meta.url).href;
const loader = 'data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: ${JSON.stringify(electronUrl)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`);

async function runStartup(t, scenario) {
  const directory = await mkdtemp(join(tmpdir(), 'familiar-desktop-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (scenario === 'invalid-profile') await writeFile(join(directory, 'settings.json'), '{broken');
  const code = `
    import assert from 'node:assert/strict';
    import { register } from 'node:module';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    import { app, windows, errors, calls, loaded, shown, closed } from ${JSON.stringify(electronUrl)};
    register(${JSON.stringify(loader)}, import.meta.url);
    const deadline = setTimeout(() => {
      console.error('桌面启动超时：入口模块必须在 ready 事件之前完成加载');
      process.exit(1);
    }, 2500);
    // Electron 完成入口 ESM 求值后才触发 ready，不能提前 resolve 掩盖启动死锁。
    await import(${JSON.stringify(entryUrl)});
    assert.equal(windows.length, 0);
    assert.equal(app.getPath('userData'), process.env.FAMILIAR_BRIDGE_APP_DATA);
    if (process.env.DESKTOP_TEST_SCENARIO === 'second-instance') {
      await closed.promise;
      assert.deepEqual(calls, ['set-path', 'lock']);
    } else {
      assert.deepEqual(calls, ['set-path', 'lock', 'when-ready']);
      app.finishReady();
      if (process.env.DESKTOP_TEST_SCENARIO === 'invalid-profile') {
        await closed.promise;
        assert.equal(windows.length, 0);
        assert.equal(errors[0].title, '应用无法启动');
        assert.match(errors[0].message, /桌面配置无法读取/);
      } else {
        while (!calls.includes('load-file')) await delay(5);
        assert.equal(windows.length, 1);
        assert.equal(windows[0].visible, false);
        assert.equal(windows[0].file, join(process.cwd(), 'desktop/renderer/index.html'));
        loaded.resolve();
        await shown.promise;
        assert.equal(windows[0].visible, true);
        assert.deepEqual(errors, []);
        app.quit();
        await closed.promise;
      }
    }
    clearTimeout(deadline);
  `;
  const result = await execute(process.execPath, ['--input-type=module', '-e', code], {
    cwd: projectRoot, timeout: 5000,
    env: { ...process.env, FAMILIAR_BRIDGE_APP_DATA: directory, DESKTOP_TEST_SCENARIO: scenario },
  });
  assert.equal(result.stderr, '');
}

test('桌面入口先完成 ESM 加载，再在 ready 后加载并显示窗口，关闭时正常退出', t => runStartup(t, 'normal'));
test('桌面配置损坏时显示启动错误并退出，不停在无窗口状态', t => runStartup(t, 'invalid-profile'));
test('桌面重复实例直接退出，不等待 ready 或创建窗口', t => runStartup(t, 'second-instance'));
