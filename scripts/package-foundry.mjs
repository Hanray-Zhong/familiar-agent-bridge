import { join, resolve } from 'node:path';
import { projectRoot } from '../src/runtime/config.mjs';
import { modulePackageInfo, packageFoundryModule } from '../src/foundry/module-package.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) throw new Error('用法：npm run dist:foundry [-- --output /目录/module.zip]');
const source = join(projectRoot, 'foundry-module');
const { fileName } = await modulePackageInfo(source);
const target = args.length ? resolve(args[1]) : join(projectRoot, 'dist/foundry', fileName);
const result = await packageFoundryModule(source, target);
console.log(`Foundry 模块安装包：${result.path}`);
console.log(`包含 ${result.files} 个运行文件。解压后，将 familiar-agent-bridge 文件夹放入 Foundry 的 Data/modules。`);
