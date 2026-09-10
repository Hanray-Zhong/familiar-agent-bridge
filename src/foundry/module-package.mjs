import { lstat, readFile } from 'node:fs/promises';
import { join, posix, extname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../storage/crc32.mjs';
import { writeAtomicFile } from '../storage/atomic-json.mjs';
import { MODULE_ID } from '../../foundry-module/shared/protocol.mjs';

export async function modulePackageInfo(source) {
  const manifest = JSON.parse(await readResource(source, 'module.json'));
  if (manifest.id !== MODULE_ID || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('模块 ID 或版本无效');
  return { manifest, fileName: `familiar-agent-bridge-module-${manifest.version}.zip` };
}

async function readResource(source, file) {
  if (!/^[\w./-]+$/.test(file) || file.startsWith('/') || file.split('/').some(part => ['.', '..', ''].includes(part))) throw new Error(`模块资源路径无效：${file}`);
  // 不跟随符号链接，避免把模块目录外的文件带进安装包。
  let path = source;
  if (!(await lstat(path)).isDirectory()) throw new Error('模块资源目录无效');
  for (const part of file.split('/')) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`模块资源不能是符号链接：${file}`);
  }
  const info = await lstat(path);
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error(`模块资源不是文件或超过 4 MiB：${file}`);
  return readFile(path);
}

// 仅打包 manifest 入口及其静态相对依赖，不扫描项目配置、用户数据或临时文件。
async function collectResources(source, manifest) {
  const entries = new Map([['module.json', await readResource(source, 'module.json')]]);
  const visit = async file => {
    if (entries.has(file)) return;
    if (!['.mjs', '.js', '.css'].includes(posix.extname(file))) throw new Error(`不支持的模块资源类型：${file}`);
    const data = await readResource(source, file);
    entries.set(file, data);
    if (entries.size > 256 || [...entries.values()].reduce((sum, value) => sum + value.length, 0) > 16 * 1024 * 1024) throw new Error('模块资源超过打包容量');
    if (/\.(?:mjs|js)$/.test(file)) {
      for (const match of data.toString().matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('./') && !match[1].startsWith('../')) throw new Error(`模块依赖必须是相对路径：${match[1]}`);
        await visit(posix.normalize(posix.join(posix.dirname(file), match[1])));
      }
    }
  };
  for (const field of ['esmodules', 'scripts', 'styles']) {
    if (manifest[field] !== undefined && (!Array.isArray(manifest[field]) || manifest[field].some(value => typeof value !== 'string'))) throw new Error(`模块 ${field} 格式无效`);
    for (const file of manifest[field] ?? []) await visit(file);
  }
  return [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

// 小型模块使用标准 ZIP32 + Deflate；固定时间与文件排序使相同源码生成相同的包。
function zip(entries, prefix) {
  const bodies = [], directory = [];
  let offset = 0;
  for (const [file, data] of entries) {
    const name = Buffer.from(`${prefix}/${file}`), compressed = deflateRawSync(data), checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); local.copy(central, 6, 4, 28);
    central.writeUInt32LE(offset, 42);
    bodies.push(local, name, compressed); directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const catalog = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(catalog.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, catalog, end]);
}

export async function packageFoundryModule(source, target) {
  if (typeof target !== 'string' || extname(target).toLowerCase() !== '.zip') throw new Error('请选择 .zip 安装包路径');
  const { manifest, fileName } = await modulePackageInfo(source);
  const entries = await collectResources(source, manifest);
  const archive = zip(entries, manifest.id);
  await writeAtomicFile(target, archive);
  return { path: target, fileName, version: manifest.version, files: entries.length, bytes: archive.length };
}
