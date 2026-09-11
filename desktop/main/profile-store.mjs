import { mkdir, readFile, writeFile, access, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { configDefaults, configFields } from '../../src/runtime/config-fields.mjs';
import { loadConfig } from '../../src/runtime/config.mjs';
import { writeAtomicJson, writeAtomicFile } from '../../src/storage/atomic-json.mjs';

export class ProfileStore {
  constructor(directory, resources) { Object.assign(this, { directory, resources }); this.file = join(directory, 'settings.json'); }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('桌面配置无法读取；请保留原文件并检查格式');
      const root = join(this.directory, 'runtime');
      await mkdir(join(root, 'agents/dm'), { recursive: true, mode: 0o700 });
      try { await writeFile(join(root, 'agents/dm/AGENTS.md'), await readFile(join(this.resources, 'agents/dm/AGENTS.md')), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      this.data = { version: 1, root, values: { ...configDefaults } };
      await writeAtomicJson(this.file, this.data);
    }
    if (this.data.version !== 1 || typeof this.data.root !== 'string' || !this.data.values || typeof this.data.values !== 'object') throw new Error('桌面配置格式无效');
    this.data = { version: 1, root: this.data.root, values: this.validateValues(this.data.values) };
    return this.snapshot();
  }

  validateValues(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('设置必须是对象');
    // 旧版测试玩家名称自动迁移，原文件在用户保存设置前保持不变。
    values = { ...values };
    if (Object.hasOwn(values, 'STDIN_PLAYER')) {
      values.TEST_PLAYER ??= values.STDIN_PLAYER;
      delete values.STDIN_PLAYER;
    }
    if (Object.keys(values).some(key => !Object.hasOwn(configDefaults, key))) throw new Error('包含不支持的设置项');
    return Object.fromEntries(configFields.map(({ key }) => {
      const value = values[key] ?? configDefaults[key];
      if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f]/.test(value)) throw new Error(`${key} 格式无效`);
      return [key, value];
    }));
  }

  snapshot() { return structuredClone({ ...this.data, directory: this.directory, fields: configFields }); }
  config() { return loadConfig(this.data.values, { root: this.data.root }); }

  async save(values) {
    const next = { ...this.data, values: this.validateValues(values) };
    await loadConfig(next.values, { root: next.root });
    await writeAtomicJson(this.file, next);
    this.data = next;
    return this.snapshot();
  }

  async importProject(directory) {
    const root = await realpath(directory);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'familiar-agent-bridge') throw new Error('请选择 Familiar Agent Bridge 项目文件夹');
    let file = {};
    try { file = parseEnv(await readFile(join(root, '.env'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const values = this.validateValues(Object.fromEntries(configFields.map(({ key }) => [key,
      file[key] ?? (key === 'TEST_PLAYER' ? file.STDIN_PLAYER : undefined) ?? configDefaults[key]])));
    const config = await loadConfig(values, { root });
    await access(config.instructionsFile);
    const next = { ...this.data, root, values };
    await writeAtomicJson(this.file, next);
    this.data = next;
    return this.snapshot();
  }

  async rules() { return readFile((await this.config()).instructionsFile, 'utf8'); }
  async saveRules(text) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64000) throw new Error('主持规则不能为空，且不能超过 64 KB');
    const path = (await this.config()).instructionsFile;
    if (resolve(path) === resolve(this.resources, 'AGENTS.md')) throw new Error('不能覆盖开发规则');
    // 与 JSON 存储使用相同的原子落盘机制，内容仍是 Markdown。
    await writeAtomicFile(path, text.endsWith('\n') ? text : text + '\n');
  }
}
