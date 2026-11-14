'use strict';
/**
 * 数据目录搬迁（设置 → 数据目录 → 更改）。纯 Node，不依赖 Electron，供测试直接调用。
 *
 * - 位置记在指针文件（Electron userData 下的 data-location.json），优先级：环境变量 MEM0_DATA_DIR > 指针 > ~/.mem0。
 * - planTarget：用户选的文件夹 → 实际目标。空文件夹直接用；已有 mem0 数据 → 「改用那里的数据」；
 *   其他非空文件夹 → 在里面建 mem0 子文件夹，不把数据散在用户的文件之间。
 * - copyData：整目录复制后逐个核对文件大小；失败时清掉本次复制出来的东西。旧目录从不删除。
 */
const fs = require('node:fs');
const path = require('node:path');

const DB_FILE = 'mem0.db';
const SUBDIR = 'mem0';

const norm = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
/** a 与 b 相同，或 a 在 b 里面 */
function isSameOrInside(a, b) {
  const A = norm(a); const B = norm(b);
  if (A === B) return true;
  const rel = path.relative(B, A);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const hasMem0Data = (dir) => { try { return fs.statSync(path.join(dir, DB_FILE)).isFile(); } catch { return false; } };
const isEmptyDir = (dir) => { try { return fs.readdirSync(dir).length === 0; } catch { return false; } };
const exists = (p) => fs.existsSync(p);

/**
 * @returns {{ ok: true, target: string, mode: 'copy'|'use-existing' } | { ok: false, error: string }}
 */
function planTarget(current, chosen) {
  if (!chosen) return { ok: false, error: '没有选择文件夹' };
  const c = path.resolve(chosen);
  if (isSameOrInside(c, current)) return { ok: false, error: '不能选当前数据目录，或它里面的文件夹' };
  let target = c;
  if (!hasMem0Data(c) && exists(c) && !isEmptyDir(c)) target = path.join(c, SUBDIR);
  if (isSameOrInside(target, current)) return { ok: false, error: '不能选当前数据目录，或它里面的文件夹' };
  if (isSameOrInside(current, target)) return { ok: false, error: '不能选当前数据目录的上级文件夹' };
  if (hasMem0Data(target)) return { ok: true, target, mode: 'use-existing' };
  if (exists(target) && !isEmptyDir(target)) return { ok: false, error: `${target} 里已经有别的文件，请换一个空文件夹` };
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.mem0-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    return { ok: false, error: `这个位置没法写入：${e.code || e.message}` };
  }
  return { ok: true, target, mode: 'copy' };
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out;
}

/** 复制并核对；失败时清空 target 里本次复制的内容并抛错。返回 { files, bytes } */
function copyData(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const files = listFiles(from);
  try {
    let bytes = 0;
    for (const rel of files) {
      const src = path.join(from, rel);
      const dst = path.join(to, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      const a = fs.statSync(src).size; const b = fs.statSync(dst).size;
      if (a !== b) throw new Error(`核对失败：${rel}`);
      bytes += a;
    }
    if (files.includes(DB_FILE) && !hasMem0Data(to)) throw new Error('核对失败：没找到 mem0.db');
    return { files: files.length, bytes };
  } catch (e) {
    for (const rel of files) { try { fs.rmSync(path.join(to, rel), { force: true }); } catch { /* ignore */ } }
    throw e;
  }
}

/**
 * 重启参数：免安装版（electron-builder portable）运行时 process.execPath 在临时解压目录，
 * 直接 relaunch 会重启临时目录里的程序；AppImage 同理要用外层镜像。返回 undefined 表示照旧 relaunch。
 */
function relaunchOptions(env, execPath, argv) {
  const e = env || {};
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  if (e.PORTABLE_EXECUTABLE_FILE) return { execPath: e.PORTABLE_EXECUTABLE_FILE, args };
  if (e.APPIMAGE) return { execPath: e.APPIMAGE, args };
  return undefined;
}

function readPointer(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j.dataDir === 'string' && j.dataDir ? j.dataDir : null;
  } catch { return null; }
}
function writePointer(file, dir) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ dataDir: path.resolve(dir), updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { planTarget, copyData, readPointer, writePointer, relaunchOptions, isSameOrInside, hasMem0Data, DB_FILE, SUBDIR };
