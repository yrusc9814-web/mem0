'use strict';
/**
 * 检查 MiSans 子集是否覆盖界面用到的中文与全角标点。
 * 用法：node scripts/check-font-coverage.js [--json]
 * 缺字时打印缺失字符列表并以退出码 1 结束（npm test 会因此失败）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src/renderer');
const FONTS_CSS = path.join(RENDERER, 'fonts/fonts.css');

// 需要检查的字符区间：CJK 符号与标点 / 全角字符 / 中日韩统一表意文字
const TARGET_RANGES = [[0x3000, 0x303f], [0xff00, 0xffef], [0x4e00, 0x9fff]];

/** 把 "U+3001-3002,U+FF1F" 解析成 [[0x3001,0x3002],[0xff1f,0xff1f]] */
function parseUnicodeRange(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    // CSS 的 unicode-range 大小写不敏感
    const m = /^\s*U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?\s*$/i.exec(part);
    if (!m) continue;
    const start = parseInt(m[1], 16);
    const end = m[2] ? parseInt(m[2], 16) : start;
    if (end >= start) out.push([start, end]);
  }
  return out;
}

/** 合并重叠或相邻区间，返回按起点升序的区间数组 */
function mergeRanges(ranges) {
  const sorted = ranges.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** 从 fonts.css 中取出 MiSans 各 @font-face 的 unicode-range 并合并 */
function misansRanges(cssText) {
  const ranges = [];
  for (const m of String(cssText).matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const block = m[1];
    if (!/font-family:\s*['"]MiSans['"]/.test(block)) continue;
    const range = /unicode-range:\s*([^;]+)/.exec(block);
    if (range) ranges.push(...parseUnicodeRange(range[1]));
  }
  return mergeRanges(ranges);
}

/** 二分判断码点是否落在合并后的区间内（含端点） */
function isCovered(merged, cp) {
  let lo = 0;
  let hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < merged[mid][0]) hi = mid - 1;
    else if (cp > merged[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function inTargetRange(cp) {
  return TARGET_RANGES.some(([s, e]) => cp >= s && cp <= e);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js)$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** 收集 renderer 下所有 .html/.js 用到的目标区间字符：Map<码点, Set<文件>> */
function collectChars(rendererDir) {
  const used = new Map();
  for (const file of walk(rendererDir).sort()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (!inTargetRange(cp)) continue;
      if (!used.has(cp)) used.set(cp, new Set());
      used.get(cp).add(path.relative(rendererDir, file).split(path.sep).join('/'));
    }
  }
  return used;
}

/** 核心检查：返回 { files, used, covered, missing } */
function checkFontCoverage(opts = {}) {
  const rendererDir = opts.rendererDir || RENDERER;
  const cssPath = opts.cssPath || path.join(rendererDir, 'fonts/fonts.css');
  const merged = misansRanges(fs.readFileSync(cssPath, 'utf8'));
  const used = collectChars(rendererDir);
  const missing = [];
  for (const cp of [...used.keys()].sort((a, b) => a - b)) {
    if (!isCovered(merged, cp)) {
      missing.push({ codePoint: cp, char: String.fromCodePoint(cp), files: [...used.get(cp)].sort() });
    }
  }
  return {
    files: walk(rendererDir).length,
    used: used.size,
    covered: used.size - missing.length,
    missing,
  };
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

function report(r) {
  if (!r.missing.length) {
    console.log(`MiSans 缺字检查通过：扫描 ${r.files} 个文件，用到 ${r.used} 个中文字符/全角标点，全部覆盖。`);
    return;
  }
  console.log(`MiSans 缺字检查未通过：扫描 ${r.files} 个文件，用到 ${r.used} 个中文字符/全角标点，覆盖 ${r.covered} 个，缺失 ${r.missing.length} 个。`);
  console.log('缺失字符列表：');
  for (const m of r.missing) console.log(`  ${hex(m.codePoint)}  ${m.char}  ← ${m.files.join(', ')}`);
  console.log('请重新切分 MiSans 子集，把上述字符加入 unicode-range 与字体文件。');
}

module.exports = {
  TARGET_RANGES,
  parseUnicodeRange,
  mergeRanges,
  misansRanges,
  isCovered,
  collectChars,
  checkFontCoverage,
};

if (require.main === module) {
  const r = checkFontCoverage();
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else report(r);
  process.exit(r.missing.length ? 1 : 0);
}
