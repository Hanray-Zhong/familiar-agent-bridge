import { readFile, stat } from 'node:fs/promises';
import { validatePairing } from '../../foundry-module/shared/protocol.mjs';

export async function loadPairing(file) {
  const info = await stat(file);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('配对文件包含认证密钥，必须设置为 chmod 600');
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('无法解析私有配对 JSON，请检查文件格式；内容不会回显'); }
  return validatePairing(parsed);
}
