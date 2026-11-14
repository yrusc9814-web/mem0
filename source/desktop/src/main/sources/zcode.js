'use strict';
/**
 * ZCode（智谱）：~/.zcode/cli/db/db.sqlite
 * 表结构：
 *   session(id, parent_id, directory, title, time_created, time_updated)
 *   message(id, session_id, time_created, data JSON{role})
 *   part(id, message_id, session_id, data JSON{type:'text', text, synthetic?})
 * 一个数据库里有全部会话，read() 逐个会话产出。只读打开，不会锁住 ZCode。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ID = 'zcode';

function dbPath(root) { return path.join(root, 'cli', 'db', 'db.sqlite'); }

async function discover(root) {
  const p = dbPath(root);
  return fs.existsSync(p) ? [p] : [];
}

/** WAL 模式下新数据先写到 -wal 文件，签名要把它也算上 */
function signature(file) {
  let size = 0; let mtime = 0;
  for (const f of [file, `${file}-wal`]) {
    try { const s = fs.statSync(f); size += s.size; mtime = Math.max(mtime, s.mtimeMs); } catch { /* 没有 wal */ }
  }
  return { size, mtimeMs: mtime };
}

function json(s) { try { return JSON.parse(s); } catch { return null; } }

async function* read(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const sessions = db.prepare('SELECT id, directory, title, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC').all();
    const msgs = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, rowid');
    const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY rowid');
    for (const s of sessions) {
      const messages = [];
      for (const m of msgs.all(s.id)) {
        const d = json(m.data);
        if (!d || (d.role !== 'user' && d.role !== 'assistant')) continue;
        const text = parts.all(m.id).map((p) => json(p.data))
          .filter((p) => p && p.type === 'text' && !p.synthetic && typeof p.text === 'string')
          .map((p) => p.text.trim()).filter(Boolean).join('\n');
        if (text) messages.push({ role: d.role, content: text, createdAt: m.time_created });
      }
      if (!messages.some((m) => m.role === 'user')) continue;
      yield {
        source: ID, externalId: s.id, title: s.title || (s.directory ? path.basename(s.directory) : undefined),
        workspace: s.directory || null, createdAt: s.time_created, updatedAt: s.time_updated, messages, ingestMethod: 'local',
      };
    }
  } finally {
    db.close();
  }
}

module.exports = { id: ID, label: 'ZCode', discover, read, signature, dbPath };
