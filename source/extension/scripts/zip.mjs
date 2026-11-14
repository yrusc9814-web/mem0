// 打一个可直接上传 Chrome 应用商店 / 拖进 chrome://extensions 的 zip（只含运行所需文件）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const { version } = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
fs.mkdirSync('dist', { recursive: true });
const out = `dist/mem0-extension-${version}.zip`;
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', out, 'manifest.json', 'src', 'icons'], { stdio: 'inherit' });
console.log(out);
