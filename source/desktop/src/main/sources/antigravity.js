'use strict';
/**
 * Google Antigravity（IDE / App / CLI）
 * conversations/*.pb 是加密的，读不了；但每个会话在
 *   ~/.gemini/<antigravity|antigravity-ide|antigravity-cli>/brain/<cascade-id>/.system_generated/logs/transcript.jsonl
 * 有一份明文逐步记录，每行：{ step_index, source, type, status, created_at, content, thinking, tool_calls }
 *   source:'USER_EXPLICIT' + type:'USER_INPUT'  → 用户输入
 *   source:'MODEL' + type:'PLANNER_RESPONSE'     → 模型回复
 * 注意：Antigravity 最多只保留约 200 个会话，更早的会被删除，越早备份越好。
 */
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { readLines } = require('./read-lines');

const ID = 'antigravity';
const VARIANTS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];

async function ls(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** root = ~/.gemini */
async function discover(root) {
  const out = [];
  for (const v of VARIANTS) {
    const brain = path.join(root, v, 'brain');
    for (const d of await ls(brain)) {
      if (!d.isDirectory()) continue;
      const f = path.join(brain, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

function exists(root) {
  return VARIANTS.some((v) => fs.existsSync(path.join(root, v)));
}

// 首条用户输入常被包在 <USER_REQUEST>…</USER_REQUEST> 里，还可能附带大段上下文
function cleanUser(text) {
  const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return (m ? m[1] : text).trim();
}

async function titleFromBrain(dir) {
  for (const name of ['task.md', 'implementation_plan.md', 'walkthrough.md']) {
    try {
      // 逐行读，找到第一个一级标题就停，避免整份 Markdown 读进内存
      for await (const line of readLines(path.join(dir, name))) {
        const h = line.match(/^#\s+(.+)$/);
        if (h) return h[1].trim();
      }
    } catch { /* 没有就算了 */ }
  }
  return undefined;
}

// conversation_summaries.db 查询结果按 dbPath + mtimeMs 轻量缓存，读取完立即 close
const summaryCache = new Map();

/** workspace_uris 是 JSON 数组字符串；Windows 盘符 URI 要显式按 windows 规则解码 */
function workspaceFromUris(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let list;
  try { list = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(list)) return undefined;
  const u = list.find((x) => typeof x === 'string' && x.trim());
  if (!u) return undefined;
  if (!u.startsWith('file://')) return u;
  try {
    const isWinUri = /^file:\/\/\/[a-zA-Z](?:%3A|:)(?:\/|$)/i.test(u);
    return url.fileURLToPath(u, { windows: isWinUri });
  } catch {
    return undefined;
  }
}

function readSummaries(dbPath) {
  try {
    const st = fs.statSync(dbPath);
    const cached = summaryCache.get(dbPath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.rows;
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    let rows;
    try {
      // 严禁 SELECT *：真实表里有纳秒级 64 位时间戳，node:sqlite 读成 Number 会抛 ERR_OUT_OF_RANGE
      rows = new Map();
      const list = db.prepare(`SELECT conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth
        FROM conversation_summaries`).all();
      for (const row of list) rows.set(String(row.conversation_id), row);
    } finally {
      try { db.close(); } catch { /* 已关闭 */ }
    }
    summaryCache.set(dbPath, { mtimeMs: st.mtimeMs, rows });
    return rows;
  } catch {
    return null; // 数据库损坏/被占用/运行时无 node:sqlite：静默回退旧逻辑
  }
}

function summaryOf(file, cascadeId) {
  // <root>/<variant>/brain/<cascadeId>/.system_generated/logs/transcript.jsonl
  const dirs = [
    path.resolve(file, '..', '..', '..', '..', '..'), // <root>/<variant>
    path.resolve(file, '..', '..', '..', '..'), // 兼容部分版本把 db 放在 brain/ 下
  ];
  for (const dir of dirs) {
    const dbPath = path.join(dir, 'conversation_summaries.db');
    if (!fs.existsSync(dbPath)) continue;
    const rows = readSummaries(dbPath);
    if (!rows) continue;
    const row = rows.get(cascadeId);
    if (row) return row;
  }
  return null;
}

function isSubagent(row) {
  if (!row) return false;
  return (row.parent_conversation_id && String(row.parent_conversation_id).trim() !== '') || Number(row.nesting_depth) > 0;
}

async function read(file) {
  const brainDir = path.resolve(file, '..', '..', '..');
  const cascadeId = path.basename(brainDir);
  const summary = summaryOf(file, cascadeId);
  if (isSubagent(summary)) return null; // 子代理会话不单独保存
  let strippedBlocks = 0;
  const rows = [];
  for await (const line of readLines(file)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!r || typeof r !== 'object') continue;
      // 先判角色，只留排序与正文用得到的字段，thinking/tool_calls 等不再占内存
      let role;
      if (r.type === 'USER_INPUT' && (r.source === 'USER_EXPLICIT' || r.source === undefined)) role = 'user';
      else if (r.type === 'PLANNER_RESPONSE' && (r.source === 'MODEL' || r.source === undefined)) role = 'assistant';
      else { strippedBlocks++; continue; } // TOOL_* 等非问答步骤
      if (role === 'assistant') {
        if (typeof r.thinking === 'string' && r.thinking.trim()) strippedBlocks++;
        if (Array.isArray(r.tool_calls)) strippedBlocks += r.tool_calls.length;
      }
      rows.push({ created_at: r.created_at, step_index: r.step_index, role, content: r.content });
    } catch { /* 正在写入的半行 */ }
  }
  rows.sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || (a.step_index ?? 0) - (b.step_index ?? 0));
  const messages = [];
  for (const r of rows) {
    const role = r.role;
    let text = typeof r.content === 'string' ? r.content : '';
    if (role === 'user') text = cleanUser(text);
    text = text.trim();
    if (!text) continue;
    const ts = Date.parse(r.created_at);
    const last = messages[messages.length - 1];
    if (last && last.role === role && role === 'assistant') { last.content += '\n\n' + text; if (Number.isFinite(ts)) last.createdAt = ts; }
    else messages.push({ role, content: text, createdAt: Number.isFinite(ts) ? ts : undefined });
  }
  if (!messages.some((m) => m.role === 'user')) return null;
  const dbTitle = summary && typeof summary.title === 'string' ? summary.title.trim() : '';
  const title = dbTitle || await titleFromBrain(brainDir);
  const workspace = summary ? workspaceFromUris(summary.workspace_uris) : undefined;
  const out = { source: ID, externalId: cascadeId, title, messages, strippedBlocks, ingestMethod: 'local' };
  if (workspace) out.workspace = workspace;
  return out;
}

module.exports = { id: ID, label: 'Antigravity', discover, read, exists };
