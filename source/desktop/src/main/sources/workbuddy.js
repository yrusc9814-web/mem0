'use strict';
/**
 * WorkBuddy：~/.workbuddy/projects/ 下任意层级的 <sessionId>.jsonl（递归，跳过 subagents/ 目录与 agent-* 文件）
 * 每行一个事件：{ type: 'message', role: 'user'|'assistant', content, sessionId, timestamp, cwd, isSidechain, isMeta }
 * content 可以是字符串，也可以是 [{type:'input_text'|'output_text', text}, ...]
 * 标题行：{ type: 'custom-title', customTitle|title } / { type: 'ai-title', aiTitle }
 * 规则对齐原 Chat Memo 的 WorkBuddy 解析器。
 */
const fs = require('node:fs');
const path = require('node:path');
const { readLines } = require('./read-lines');

const ID = 'workbuddy';
const TITLE_MAX = 80;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function discover(root) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'subagents') await walk(full); }
      else if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')) out.push(full);
    }
  };
  await walk(root);
  return out.sort(cmp);
}

function blocksText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n').trim();
}

function realUserText(text) {
  const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m) return m[1].trim();
  if (text.startsWith('<system-reminder')) return '';
  return text.trim();
}

/** 数字（或纯数字字符串）当毫秒，其它字符串按 ISO 解析；无法解析 → undefined */
function toMs(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    const n = Number(v);
    return Number.isFinite(n) && Number.isFinite(new Date(n).getTime()) ? n : undefined;
  }
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

async function read(file) {
  let sessionId = null;
  let cwd = null;
  let aiTitle = null;
  let customTitle = null;
  let firstUser = null;
  const messages = [];
  for await (const line of readLines(file)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
    if (ev.sessionId !== undefined && ev.sessionId !== null) {
      if (typeof ev.sessionId !== 'string' || !ev.sessionId || (sessionId !== null && ev.sessionId !== sessionId)) {
        throw new Error(`WorkBuddy 会话文件 sessionId 不一致或无效：${file}`);
      }
      sessionId = ev.sessionId;
    }
    if (!cwd && typeof ev.cwd === 'string') cwd = ev.cwd;
    if (ev.type === 'ai-title' && typeof ev.aiTitle === 'string') aiTitle = ev.aiTitle;
    if (ev.type === 'custom-title') {
      const t = ev.customTitle ?? ev.title;
      if (typeof t === 'string') customTitle = t;
    }
    if (ev.type !== 'message') continue;
    if (ev.isSidechain === true || ev.isMeta === true) continue;
    const role = ev.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const rawText = blocksText(ev.content);
    const text = role === 'user' ? realUserText(rawText) : rawText;
    if (!text) continue;
    if (role === 'user' && !firstUser) firstUser = text;
    messages.push({ role, content: text, createdAt: toMs(ev.timestamp) });
  }
  if (!sessionId || !messages.length) return null;
  const norm = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
  const pick = [customTitle, aiTitle, firstUser, cwd ? path.basename(cwd) : null, path.basename(file)].map(norm).find(Boolean);
  return {
    source: ID,
    externalId: sessionId,
    title: truncate(pick, TITLE_MAX),
    workspace: cwd,
    messages,
    ingestMethod: 'local',
  };
}

module.exports = { id: ID, label: 'WorkBuddy', discover, read };
