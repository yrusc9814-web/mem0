'use strict';
/**
 * Claude Code：~/.claude/projects/<编码后的项目路径>/<sessionId>.jsonl
 * 每行一个事件：{ type: 'user'|'assistant'|'summary'|..., message: { role, content }, sessionId, timestamp, cwd, isSidechain, isMeta }
 * content 可以是字符串，也可以是 [{type:'text',text}, {type:'tool_use',...}, {type:'tool_result',...}, {type:'thinking',...}]
 * 只保留用户和 AI 的正文：工具调用/结果/思考/系统注入全部丢弃。
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

// 以这些标签开头的 user 文本是 Claude Code 注入的命令/通知，不是用户正文
const INJECTED_TAG = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|task-notification|user-memory-input)>/;
// 压缩上下文时生成的续接摘要
const CONTINUED_PREFIX = 'This session is being continued from a previous conversation';
// 用户中断提示（含 for tool use 变体）
const INTERRUPTED_PREFIX = '[Request interrupted by user';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  let hasImage = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    // 只取正文；tool_use / tool_result / thinking / redacted_thinking 一律丢弃
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') hasImage = true;
  }
  const text = parts.join('\n').trim();
  // 没有文字时才用 [图片] 占位，避免纯图片消息被整条丢掉
  return text || (hasImage ? '[图片]' : '');
}

// 删掉正文里夹带的 <system-reminder>…</system-reminder>（可多段、可跨行）
function stripReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

function isInjectedUserText(text) {
  return INJECTED_TAG.test(text) || text.startsWith(CONTINUED_PREFIX) || text.startsWith(INTERRUPTED_PREFIX);
}

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
    // 压缩上下文生成的摘要事件，不是真实对话
    if (ev.isCompactSummary === true) continue;
    const msg = ev.message;
    if (!msg) continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    let text = textOf(msg.content);
    if (!text) continue;
    if (role === 'user') {
      text = stripReminders(text).trim();
      // 只剩工具结果/命令包装/中断提示/续接摘要时整条丢弃
      if (!text || isInjectedUserText(text)) continue;
    }
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
