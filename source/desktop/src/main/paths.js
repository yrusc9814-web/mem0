'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR_NAME = '.mem0';
const TOKEN_FILE = 'mcp-token';

/** 设置 → 数据目录 → 更改 写下的指针文件（Electron userData/data-location.json），由 main 在启动时设置 */
let pointerFile = null;
function setPointerFile(f) { pointerFile = f || null; }
function getPointerFile() { return pointerFile; }

/** 数据目录从哪来：env（环境变量）/ custom（用户更改过）/ default */
function dataDirSource() {
  if (process.env.MEM0_DATA_DIR) return 'env';
  if (pointerFile && require('./datamove').readPointer(pointerFile)) return 'custom';
  return 'default';
}

/** 优先级：环境变量 MEM0_DATA_DIR > 用户更改过的位置 > ~/.mem0 */
function dataDir(home = os.homedir()) {
  const custom = !process.env.MEM0_DATA_DIR && pointerFile ? require('./datamove').readPointer(pointerFile) : null;
  const dir = process.env.MEM0_DATA_DIR || custom || path.join(home, DATA_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * MCP 访问密钥：首次生成后存 <数据目录>/mcp-token，以后复用。
 * 已存在的文件内容不合法（空/被改坏）时重新生成，避免服务带着无效密钥启动。
 */
function mcpToken(dir = dataDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, TOKEN_FILE);
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch { /* 首次启动 */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 等不支持时忽略 */ }
  return token;
}

/** 各本机 Agent 的会话根目录 */
function sourceRoots(home = os.homedir()) {
  return {
    'claude-code': process.env.MEM0_CLAUDE_ROOT || path.join(home, '.claude', 'projects'),
    codex: process.env.MEM0_CODEX_ROOT || path.join(home, '.codex'),
    'deepseek-harness': process.env.MEM0_DSH_ROOT || path.join(home, '.dsh', 'sessions'),
    antigravity: process.env.MEM0_ANTIGRAVITY_ROOT || path.join(home, '.gemini'),
    zcode: process.env.MEM0_ZCODE_ROOT || path.join(home, '.zcode'),
    dimcode: process.env.MEM0_DIMCODE_ROOT || path.join(home, '.dimcode'),
    workbuddy: process.env.MEM0_WORKBUDDY_ROOT || path.join(home, '.workbuddy', 'projects'),
  };
}

module.exports = { dataDir, dataDirSource, setPointerFile, getPointerFile, mcpToken, sourceRoots, DATA_DIR_NAME, TOKEN_FILE };
