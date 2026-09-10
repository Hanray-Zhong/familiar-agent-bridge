import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { projectRoot } from '../src/runtime/config.mjs';
import { crc32 } from '../src/storage/crc32.mjs';

// Electron 44 把二进制下载改为显式 install-electron；仅运行已锁定依赖中的官方安装器。
await promisify(execFile)(process.execPath, [join(projectRoot, 'node_modules/electron/install.js')], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
const size = 512, stride = size * 4 + 1, pixels = Buffer.alloc(size * stride);
const vertices = [[256,98],[390,176],[390,330],[256,408],[122,330],[122,176]];
const segments = vertices.map((point, i) => [point, vertices[(i + 1) % 6]]);
segments.push([[256,98],[172,306]], [[256,98],[340,306]], [[172,306],[340,306]], [[122,176],[256,230]], [[390,176],[256,230]], [[122,330],[256,230]], [[390,330],[256,230]], [[172,306],[256,408]], [[340,306],[256,408]]);
const distance = (x, y, a, b) => {
  const dx = b[0]-a[0], dy = b[1]-a[1], t = Math.max(0, Math.min(1, ((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));
  return Math.hypot(x-a[0]-t*dx, y-a[1]-t*dy);
};
for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
  const corner = Math.hypot(Math.max(78-x,0,x-434), Math.max(78-y,0,y-434));
  const color = segments.some(([a,b]) => distance(x,y,a,b)<3) ? [217,233,189] : [32,58,45];
  const offset=y*stride+1+x*4;
  for (let i=0;i<3;i++) pixels[offset+i]=color[i];
  pixels[offset+3]=corner>66?0:255;
}
const chunk = (name,data) => { const type=Buffer.from(name), length=Buffer.alloc(4), checksum=Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type,data]))); return Buffer.concat([length,type,data,checksum]); };
const header=Buffer.alloc(13); header.writeUInt32BE(size,0); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
await mkdir(join(projectRoot,'build'),{recursive:true});
await writeFile(join(projectRoot,'build/icon.png'),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
// 外部资源从独立暂存目录复制，避免 electron-builder 把核心依赖的共享协议从 ASAR 排除。
const resources = join(projectRoot, 'build/bridge-resources');
await rm(resources, { recursive: true, force: true });
for (const directory of ['agents/dm', 'foundry-module', 'docs/user-manual']) {
  await cp(join(projectRoot, directory), join(resources, directory), { recursive: true });
}
console.log('桌面运行时与应用图标已就绪。');
