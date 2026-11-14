'use strict';
/**
 * OpenAI Codex CLI：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（以及 archived_sessions/）
 * 新格式每行：{ timestamp, type: 'session_meta'|'response_item'|'event_msg'|'turn_context', payload }
 *   response_item.payload: { type:'message', role:'user'|'assistant'|'developer', content:[{type:'input_text'|'output_text', text}] }
 * 旧格式每行直接是 { type:'message', role, content } 或首行 { id, timestamp, instructions }
 * 标题来自 ~/.codex/session_index.jsonl（若存在）
 */
const fs = require('node:fs');
const path = require('node:path');
const { readLines } = require('./read-lines');

const ID = 'codex';

async function walk(dir, out) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

async function discover(root) {
  const out = [];
  await walk(path.join(root, 'sessions'), out);
  await walk(path.join(root, 'archived_sessions'), out);
  return out;
}

let titleCache = { mtime: 0, map: new Map() };
async function titles(root) {
  const file = path.join(root, 'session_index.jsonl');
  try {
    const st = await fs.promises.stat(file);
    if (st.mtimeMs === titleCache.mtime) return titleCache.map;
    const map = new Map();
    for await (const line of readLines(file)) {
      try {
        const r = JSON.parse(line);
        const id = r.id || r.session_id;
        const t = r.title || r.thread_name || r.name;
        if (id && t) map.set(id, t);
      } catch { /* 忽略坏行 */ }
    }
    titleCache = { mtime: st.mtimeMs, map };
    return map;
  } catch { return new Map(); }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n').trim();
}

// Codex 会把环境说明、AGENTS.md 等作为 user 消息注入，跳过
const INJECTED = /^\s*<(environment_context|user_instructions|permissions|INSTRUCTIONS)>|^# AGENTS\.md instructions/;

async function read(file, root) {
  const messages = [];
  let sessionId = null;
  let cwd = null;
  for await (const line of readLines(file)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    let item = ev;
    let ts = Date.parse(ev.timestamp);
    // 旧格式首行 { id, timestamp, instructions }（没有 type）：会话 ID 以它为准，不用文件名
    if (!ev.type && typeof ev.id === 'string' && ev.id && 'instructions' in ev) {
      if (!sessionId) sessionId = ev.id;
      continue;
    }
    if (ev.type === 'session_meta' && ev.payload) {
      sessionId = ev.payload.id || sessionId;
      cwd = ev.payload.cwd || cwd;
      continue;
    }
    if (ev.type === 'response_item') item = ev.payload;
    else if (ev.type && ev.type !== 'message') continue;
    if (!item || item.type !== 'message') continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    const text = textOf(item.content);
    if (!text || (item.role === 'user' && INJECTED.test(text))) continue;
    messages.push({ role: item.role, content: text, createdAt: Number.isFinite(ts) ? ts : undefined });
  }
  if (!messages.length) return null;
  if (!sessionId) {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    sessionId = m ? m[1] : path.basename(file, '.jsonl');
  }
  const t = (await titles(root)).get(sessionId);
  return { source: ID, externalId: sessionId, title: t, workspace: cwd, messages, ingestMethod: 'local' };
}

module.exports = { id: ID, label: 'Codex', discover, read };
