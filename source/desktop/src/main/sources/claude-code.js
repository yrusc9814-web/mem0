'use strict';
/**
 * Claude Code：~/.claude/projects/<编码后的项目路径>/<sessionId>.jsonl
 * 每行一个事件：{ type: 'user'|'assistant'|'summary'|..., message: { role, content }, sessionId, timestamp, cwd, isSidechain, isMeta }
 * content 可以是字符串，也可以是 [{type:'text',text}, {type:'tool_use',...}, {type:'tool_result',...}, {type:'thinking',...}]
 */
const fs = require('node:fs');
const path = require('node:path');
const { readLines } = require('./read-lines');

const ID = 'claude-code';

async function discover(root) {
  const out = [];
  let dirs;
  try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try { files = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) if (f.isFile() && f.name.endsWith('.jsonl')) out.push(path.join(dir, f.name));
  }
  return out;
}

function textOf(content, role) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use') parts.push(`[调用工具 ${b.name}] ${clip(JSON.stringify(b.input ?? {}), 400)}`);
    // tool_result 通常是大段文件内容/命令输出，只保留开头，避免把库撑爆
    else if (b.type === 'tool_result' && role === 'user') {
      const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join('\n') : '';
      if (t) parts.push(`[工具结果] ${clip(t, 400)}`);
    }
  }
  return parts.join('\n').trim();
}

function clip(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

async function read(file) {
  const messages = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd = null;
  let summary = null;
  let customTitle = null;
  let aiTitle = null;
  for await (const line of readLines(file)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'summary' && typeof ev.summary === 'string') { summary = ev.summary; continue; }
    if (ev.type === 'custom-title' && typeof ev.customTitle === 'string') { customTitle = ev.customTitle; continue; }
    if (ev.type === 'ai-title' && typeof ev.aiTitle === 'string') { aiTitle = ev.aiTitle; continue; }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    if (ev.isSidechain || ev.isMeta) continue;
    const msg = ev.message;
    if (!msg) continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const text = textOf(msg.content, role);
    if (!text) continue;
    // 过滤 Claude Code 注入的命令包装
    if (role === 'user' && /^<(command-name|local-command-stdout|command-message)>/.test(text)) continue;
    if (ev.sessionId) sessionId = ev.sessionId;
    if (ev.cwd) cwd = ev.cwd;
    const ts = Date.parse(ev.timestamp);
    const last = messages[messages.length - 1];
    // 同一轮 assistant 的多个分块合并
    if (last && last.role === role && role === 'assistant') {
      last.content += '\n' + text;
      if (Number.isFinite(ts)) last.createdAt = ts;
    } else {
      messages.push({ role, content: text, createdAt: Number.isFinite(ts) ? ts : undefined });
    }
  }
  if (!messages.length) return null;
  return {
    source: ID,
    externalId: sessionId,
    title: customTitle || aiTitle || summary || undefined,
    workspace: cwd,
    messages,
    ingestMethod: 'local',
  };
}

module.exports = { id: ID, label: 'Claude Code', discover, read };
