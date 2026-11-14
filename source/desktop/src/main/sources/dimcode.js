'use strict';
/**
 * DimCode / DimAgent（dim CLI 与桌面版）：~/.dimcode/v2/dimcode.sqlite
 * 相关表：
 *   sessions(sessionId, cwd, title, status:'active'|'archived', createdAt, updatedAt)  —— 时间是 ISO 字符串
 *   messages(messageId, sessionId, role:'user'|'assistant'|'tool_result', parts JSON, orderKey, createdAt)
 *     parts: [{type:'text', text} | {type:'reasoning', text} | {type:'tool-call', ...} | {type:'file', ...}]
 *   session_catalog_entries(sessionId, topLevel)  —— topLevel=0 是子代理会话，不单独保存
 * 只读打开，不影响 DimCode 运行。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ID = 'dimcode';

function dbPath(root) { return path.join(root, 'v2', 'dimcode.sqlite'); }

async function discover(root) {
  const p = dbPath(root);
  return fs.existsSync(p) ? [p] : [];
}

function signature(file) {
  let size = 0; let mtime = 0;
  for (const f of [file, `${file}-wal`]) {
    try { const s = fs.statSync(f); size += s.size; mtime = Math.max(mtime, s.mtimeMs); } catch { /* 没有 wal */ }
  }
  return { size, mtimeMs: mtime };
}

function json(s) { try { return JSON.parse(s); } catch { return null; } }
function ms(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? t : undefined; }

function textOf(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  const out = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text);
    else if (p.type === 'file') out.push(`[文件] ${p.filename || ''}`.trim());
  }
  return out.join('\n').trim();
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

async function* read(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const subagents = new Set();
    if (hasTable(db, 'session_catalog_entries')) {
      for (const r of db.prepare('SELECT sessionId FROM session_catalog_entries WHERE topLevel = 0').all()) subagents.add(r.sessionId);
    }
    const sessions = db.prepare('SELECT sessionId, cwd, title, createdAt, updatedAt FROM sessions ORDER BY updatedAt DESC').all();
    const msgs = db.prepare(`SELECT role, parts, createdAt FROM messages WHERE sessionId = ? AND role IN ('user','assistant')
      ORDER BY orderKey, createdAt, messageId`);
    for (const s of sessions) {
      if (subagents.has(s.sessionId)) continue;
      const messages = [];
      for (const m of msgs.all(s.sessionId)) {
        const text = textOf(json(m.parts) ?? m.parts);
        if (!text) continue;
        const ts = ms(m.createdAt);
        const last = messages[messages.length - 1];
        // 一轮里工具调用会把 assistant 拆成多条，合并成一条
        if (last && last.role === 'assistant' && m.role === 'assistant') { last.content += '\n' + text; last.createdAt = ts ?? last.createdAt; }
        else messages.push({ role: m.role, content: text, createdAt: ts });
      }
      if (!messages.some((m) => m.role === 'user')) continue;
      yield {
        source: ID, externalId: s.sessionId,
        title: s.title || undefined, workspace: s.cwd || null,
        createdAt: ms(s.createdAt), updatedAt: ms(s.updatedAt), messages, ingestMethod: 'local',
      };
    }
  } finally {
    db.close();
  }
}

module.exports = { id: ID, label: 'DimCode', discover, read, signature, dbPath };
