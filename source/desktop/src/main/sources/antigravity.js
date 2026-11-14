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

async function read(file) {
  const brainDir = path.resolve(file, '..', '..', '..');
  const cascadeId = path.basename(brainDir);
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
      else continue;
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
  return { source: ID, externalId: cascadeId, title: await titleFromBrain(brainDir), messages, ingestMethod: 'local' };
}

module.exports = { id: ID, label: 'Antigravity', discover, read, exists };
