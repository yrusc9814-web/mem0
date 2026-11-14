'use strict';
/**
 * DeepSeek Harness（dsh）：~/.dsh/sessions/<项目>/<会话>/session[.vN].jsonl[.zstd]
 * 同一会话目录可能有多代文件（session.jsonl、session.v2.jsonl …），取版本号最高的那个。
 * 首行是头：{ type:'session', id, version, createdAt(ms), cwd?, origin?:'subagent' }
 * 之后每行一个事件：{ type, seq, time(ms), surfaceOp:'append'|{op:'replace',...}, data }
 *   user/message      data = { role:'user', source:{kind:'user'|...}, content:[{type:'text',text}|...] }
 *   assistant/message data = { message:{ role:'assistant', content:[...] } }
 *   session/title     data = { title }
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { readLines } = require('./read-lines');

const ID = 'deepseek-harness';

function generation(name) {
  const m = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(name);
  return m ? Number(m[1] ?? 0) : null;
}

async function ls(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function discover(root) {
  const out = [];
  for (const project of await ls(root)) {
    if (!project.isDirectory()) continue;
    for (const session of await ls(path.join(root, project.name))) {
      if (!session.isDirectory()) continue;
      const dir = path.join(root, project.name, session.name);
      const best = (await ls(dir))
        .filter((e) => e.isFile() && generation(e.name) !== null)
        .sort((a, b) => generation(b.name) - generation(a.name) || (a.name.endsWith('.zstd') ? 1 : -1))[0];
      if (best) out.push(path.join(dir, best.name));
    }
  }
  return out;
}

function zstd() {
  if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.createZstdDecompress !== 'function') throw new Error('当前运行时不支持 zstd 解压');
  return zlib.createZstdDecompress();
}

function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'file') parts.push(`[文件] ${b.name || b.path || ''}`.trim());
    else if (b.type === 'image') parts.push('[图片]');
  }
  return parts.join('\n').trim();
}

async function read(file) {
  let header;
  let seenHeader = false;
  const messages = [];
  let title;
  for await (const line of readLines(file, file.endsWith('.zstd') ? { decompress: zstd } : undefined)) {
    if (!seenHeader) {
      seenHeader = true;
      try { header = JSON.parse(line); } catch { return null; }
      if (!header || header.type !== 'session' || !header.id) return null;
      if (header.origin === 'subagent') return null; // 子代理会话不单独保存
      continue;
    }
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const data = row && row.data;
    if (!data || typeof data !== 'object') continue;
    if (row.type === 'session/title' && typeof data.title === 'string') { title = data.title; continue; }
    if (row.type !== 'user/message' && row.type !== 'assistant/message') continue;
    if (row.surfaceOp !== 'append') continue;
    const role = row.type === 'user/message' ? 'user' : 'assistant';
    const msg = role === 'user' ? data : (data.message || data);
    if (role === 'user' && msg.source && msg.source.kind !== 'user') continue; // 系统注入
    const text = textOf(msg.content);
    if (!text) continue;
    const ts = Number.isFinite(row.time) ? row.time : undefined;
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && role === 'assistant') { last.content += '\n' + text; last.createdAt = ts ?? last.createdAt; }
    else messages.push({ role, content: text, createdAt: ts });
  }
  if (!seenHeader) return null; // 空文件
  if (!messages.some((m) => m.role === 'user')) return null;
  return {
    source: ID, externalId: header.id, title, workspace: header.cwd || null,
    createdAt: Number.isFinite(header.createdAt) ? header.createdAt : undefined,
    messages, ingestMethod: 'local',
  };
}

module.exports = { id: ID, label: 'DeepSeek Harness', discover, read };
