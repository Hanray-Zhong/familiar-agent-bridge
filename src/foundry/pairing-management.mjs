import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeAtomicJson } from '../storage/atomic-json.mjs';
import { loadPairing } from './pairing.mjs';
import { validatePairing } from '../../foundry-module/shared/protocol.mjs';

export async function configurePairing({ file, stateFile, worldId, relayUserId, origins = [], port, rotate = false }) {
  let previous, state;
  try { previous = await loadPairing(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取现有状态，请先检查文件格式和权限'); }
  worldId ||= previous?.worldId ?? state?.world?.id;
  relayUserId ||= previous?.relayUserId;
  if (!worldId || !relayUserId) throw new Error('需要当前 Foundry 世界 ID 和中继 GM 用户 ID');
  if (previous && !rotate) {
    if (previous.worldId !== worldId || previous.relayUserId !== relayUserId || origins.length || port !== undefined) {
      throw new Error('配对已存在；修改世界、GM、地址或端口需要明确轮换并重新导入');
    }
    return { pairing: previous, changed: false };
  }
  const chosenPort = Number(port ?? (previous ? new URL(previous.bridgeUrl).port : 3210));
  if (!Number.isInteger(chosenPort) || chosenPort < 1024 || chosenPort > 65535) throw new Error('Bridge 端口必须是 1024–65535 的整数');
  const pairing = validatePairing({ protocol: 1, worldId, relayUserId, secret: randomBytes(32).toString('base64url'),
    bridgeUrl: `http://127.0.0.1:${chosenPort}`,
    allowedOrigins: origins.length ? origins : previous?.allowedOrigins ?? ['http://localhost:30000', 'http://127.0.0.1:30000'],
    captureSince: previous?.worldId === worldId ? previous.captureSince : Date.now() });
  await writeAtomicJson(file, pairing);
  return { pairing, changed: true };
}

export function publicPairing(pairing) {
  if (!pairing) return null;
  const { worldId, relayUserId, bridgeUrl, allowedOrigins } = pairing;
  return { worldId, relayUserId, bridgeUrl, allowedOrigins };
}
