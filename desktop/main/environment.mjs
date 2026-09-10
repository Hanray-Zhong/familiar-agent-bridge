import { readdir, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';

export async function preparePath(command, env = process.env) {
  let versions = [];
  const nvm = join(env.NVM_DIR || join(homedir(), '.nvm'), 'versions/node');
  try { versions = (await readdir(nvm)).filter(name => /^v\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).map(name => join(nvm, name, 'bin')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parts = [isAbsolute(command || '') ? dirname(command) : '', ...String(env.PATH || '').split(delimiter), ...versions, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

export async function findCodex(path) {
  const candidates = [...path.split(delimiter).map(directory => join(directory, 'codex')), '/Applications/Codex.app/Contents/Resources/codex'];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); }
    catch { /* 找下一个已安装程序，不安装或修改系统 PATH。 */ }
  }
  throw new Error('未找到 Codex CLI；请在连接设置中选择已经安装的 Codex 程序');
}
