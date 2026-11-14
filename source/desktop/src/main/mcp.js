'use strict';
/**
 * 本地 MCP 服务（Streamable HTTP，无状态）：http://127.0.0.1:3790/mcp?token=<token>
 * 只监听回环地址，并校验 Host/Origin，防止网页通过 DNS rebinding 读取记录。
 * 访问密钥首次启动时生成在 <数据目录>/mcp-token，请求须带 Authorization: Bearer <token> 或 ?token=<token>。
 *
 * 只暴露两个工具（纯本地机械检索与切片，绝不调用任何大模型做改写或摘要）：
 *   list_conversations  按本地日期列会话目录（不含正文）
 *   recall              跨来源挑重点搜原文片段，按 process_id 会话级自动去重
 *
 * 「今天互通」：两个工具每次成功调用后 store.bumpMcpCall()，并通过 mcpEvents 发出 'call' 事件。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { ALL_SOURCES } = require('./db');
const { dataDir, mcpToken } = require('./paths');

const DEFAULT_PORT = 3790;
const CLOSE_GRACE_MS = 1000; // 退出时给在途请求的收尾时间，超时强制断开
const mcpEvents = new EventEmitter();
mcpEvents.setMaxListeners(50);

// ---------- 常量 ----------
const MAX_RANGE_DAYS = 31;
const MAX_LIST_ITEMS = 300;          // 目录最多列出的会话条数
const SEGMENTS_PER_CALL = 6;         // 单次 recall 交付段数（5–8 段区间内）
const MAX_SEGMENTS_PER_CONV = 2;     // 单次同一会话最多几段，保证跨会话多样性
const TOTAL_CHAR_BUDGET = 7000;      // 单次返回正文总字数上限
const HIT_MAX = 480;                 // 命中消息摘录上限
const CTX_MAX = 240;                 // 紧邻上下文消息摘录上限
const WHOLE_MSG = 600;               // 短于此长度的消息整条返回
const CLUSTER_GAP = 260;             // 同一消息内多个命中相距超过此值则视为不同片段
const DELIVERED_TTL = 24 * 3600_000;
const TERM_HIT_LIMIT = 300;
// recall 候选总量上限：各原子词命中合并时先到先停，避免极端查询把全部正文读进内存
const MAX_CAND_MESSAGES = 2000;                 // 候选消息最多 2000 条
const MAX_CAND_BYTES = 50 * 1024 * 1024;        // 候选正文累计最多 50 MiB（按 content.length*2 估算字节）

const SOURCE_NAMES = {
  'claude-code': 'Claude Code', codex: 'Codex', 'deepseek-harness': 'DeepSeek Harness',
  antigravity: 'Antigravity', zcode: 'ZCode', dimcode: 'DimCode', workbuddy: 'WorkBuddy',
  'chatgpt-web': 'ChatGPT 网页', 'claude-web': 'Claude 网页', 'gemini-web': 'Gemini 网页',
  'deepseek-web': 'DeepSeek 网页', 'doubao-web': '豆包 网页', 'yuanbao-web': '元宝 网页',
  'kimi-web': 'Kimi 网页', 'qianwen-web': '千问 网页', 'google-ai-mode-web': 'Google AI Mode 网页',
  'grok-web': 'Grok 网页', 'hark-web': 'Hark 网页',
};
const srcName = (s) => SOURCE_NAMES[s] || s;
const isWeb = (s) => /-web$/.test(s || '');
const roleTag = (r) => (r === 'user' ? '[用户]' : '[AI]');

const FOOTER = (pid) => `process_id: ${pid}（当前对话窗口固定值；后续每次调用 recall 都必须原样传回，即使更换 query 也不得更换）`;
const MORE_HINT = '仍有尚未交付的候选证据；可再次调用 recall 获取其他证据，已交付片段会自动跳过。';

// ---------- 时间 ----------
const pad = (n) => String(n).padStart(2, '0');
function fmtDay(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtHm(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtTime(ms) { return ms ? `${fmtDay(ms)} ${fmtHm(ms)}` : '时间未知'; }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_HINT = '请使用真实日历日期 YYYY-MM-DD（如 2026-11-03）；「上周」「这个月」「最近」等模糊说法请先按今天的日期换算成具体起止日期再调用。';
/** 严格解析 YYYY-MM-DD（真实日期），返回本地时区当天 00:00 的毫秒；非法返回 null */
function parseDay(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}
const endOfDay = (startMs) => { const d = new Date(startMs); d.setDate(d.getDate() + 1); return d.getTime() - 1; };
const dayCount = (fromMs, toMs) => {
  const a = new Date(fromMs); const b = new Date(toMs);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400_000) + 1;
};

class ArgError extends Error {}
function checkDate(name, v, required) {
  if (v == null || v === '') {
    if (required) throw new ArgError(`参数 ${name} 必填。${DATE_HINT}`);
    return null;
  }
  const t = parseDay(v);
  if (t == null) throw new ArgError(`参数 ${name}=${JSON.stringify(v)} 不是合法日期。${DATE_HINT}`);
  return t;
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errText = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

// ---------- 文本切片（只截取，不改写） ----------
const BOUNDARY = new Set(['。', '！', '？', '!', '?', '；', ';', '\n', '…']);
function isBoundaryAt(t, i) {
  const c = t[i];
  if (BOUNDARY.has(c)) return true;
  return c === '.' && (i + 1 >= t.length || /\s/.test(t[i + 1]));
}
/**
 * 把命中区间 [s,e) 向两侧扩到句界：带上命中句的前一句与后一句（紧邻上下文），总长不超过 max。
 * 找不到句界时在字数上限处截断（输出时以「…」标示）。
 */
function expandWindow(t, s, e, max) {
  const len = t.length;
  if (len <= max) return [0, len];
  if (e - s > max) e = s + max;
  const room = max - (e - s);
  const backLim = Math.max(0, s - Math.floor(room * 0.45));
  let a = backLim; let seen = 0;
  for (let i = s - 1; i >= backLim; i--) {
    if (i === 0) { a = 0; break; }
    if (isBoundaryAt(t, i - 1)) { a = i; if (++seen >= 2) break; }
  }
  if (backLim === 0 && seen < 2) a = 0;
  const fwdLim = Math.min(len, a + max);
  let b = fwdLim; seen = 0;
  for (let i = e; i < fwdLim; i++) if (isBoundaryAt(t, i)) { b = i + 1; if (++seen >= 2) break; }
  if (b < e) b = Math.min(len, e);
  while (a < b && /\s/.test(t[a])) a++;
  return [a, b];
}
/** 上下文：取消息尾部（问）或头部（答），在句界截断 */
function tailWindow(t, max) {
  const len = t.length;
  if (len <= max) return [0, len];
  let a = len - max;
  for (let i = a; i < len - 20; i++) if (isBoundaryAt(t, i)) { a = i + 1; break; }
  while (a < len && /\s/.test(t[a])) a++;
  return [a, len];
}
function headWindow(t, max) {
  const len = t.length;
  if (len <= max) return [0, len];
  let b = max;
  for (let i = max - 1; i > max * 0.5; i--) if (isBoundaryAt(t, i)) { b = i + 1; break; }
  return [0, b];
}
function excerpt(t, [a, b]) {
  const body = t.slice(a, b).replace(/\s+$/, '');
  return (a > 0 ? '…' : '') + body + (b < t.length ? '…' : '');
}

// ---------- 检索词与打分 ----------
function buildConcepts(query, alternatives) {
  const seen = new Set();
  const concepts = [];
  const add = (raw, w) => {
    const p = String(raw || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
    const key = p.toLowerCase();
    if (!p || seen.has(key)) return;
    seen.add(key);
    const tokens = [...new Set(p.toLowerCase().split(' ').filter((x) => x && [...x].length >= 2))];
    concepts.push({ text: p, lower: key, w, tokens: tokens.length > 1 ? tokens : [] });
  };
  add(query, 1);
  for (const a of alternatives || []) add(a, 0.8);
  // 参与检索的原子词：每个短语本身 + 其空格拆词（≥2 字符）
  const atoms = new Set();
  for (const c of concepts) { if ([...c.lower].length >= 1) atoms.add(c.lower); for (const tk of c.tokens) atoms.add(tk); }
  return { concepts, atoms: [...atoms].slice(0, 40) };
}
function occurrences(lower, term) {
  const out = [];
  if (!term) return out;
  let i = lower.indexOf(term);
  while (i >= 0 && out.length < 50) { out.push(i); i = lower.indexOf(term, i + term.length); }
  return out;
}
/** 消息级打分：词项覆盖度 + 多词共现 + 命中密度 + 标题命中 + 时间新鲜度 */
function scoreMessage(content, title, role, at, concepts, atoms, now) {
  const lower = content.toLowerCase();
  const tlow = (title || '').toLowerCase();
  let coverage = 0; let titleHit = 0;
  for (const c of concepts) {
    if (lower.includes(c.lower)) coverage += c.w;
    else if (c.tokens.length) {
      const f = c.tokens.filter((tk) => lower.includes(tk)).length / c.tokens.length;
      coverage += c.w * 0.5 * f;
    }
    if (tlow && (tlow.includes(c.lower) || (c.tokens.length && c.tokens.every((tk) => tlow.includes(tk))))) titleHit += c.w;
  }
  const positions = [];
  const matchedAtoms = new Set();
  let occChars = 0;
  for (const a of atoms) {
    const occ = occurrences(lower, a);
    if (occ.length) { matchedAtoms.add(a); occChars += occ.length * a.length; for (const p of occ) positions.push({ p, len: a.length, a }); }
  }
  const density = Math.min(1, occChars / Math.max(120, Math.sqrt(content.length) * 12));
  const cooccur = 0.5 * Math.max(0, matchedAtoms.size - 1);
  const ageDays = at ? Math.max(0, (now - at) / 86400_000) : 365;
  const recency = Math.exp(-ageDays / 90);
  const score = 3 * coverage + Math.min(2, cooccur) + 2 * density + Math.min(1.5, titleHit) + recency + (role === 'user' ? 0.2 : 0);
  return { score, positions: positions.sort((x, y) => x.p - y.p), matched: matchedAtoms.size, hasContentHit: positions.length > 0 };
}
/** 同一消息内的命中按距离聚类，每簇一个候选片段 */
function clusters(content, positions, matched) {
  if (content.length <= WHOLE_MSG || !positions.length) return [{ s: 0, e: content.length, k: matched }];
  const out = [];
  let cur = null;
  for (const h of positions) {
    if (cur && h.p - cur.s <= CLUSTER_GAP) { cur.e = Math.max(cur.e, h.p + h.len); cur.atoms.add(h.a); }
    else { cur = { s: h.p, e: h.p + h.len, atoms: new Set([h.a]) }; out.push(cur); }
  }
  return out.map((c) => ({ s: c.s, e: c.e, k: c.atoms.size }));
}

const overlapLen = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
/** 候选片段与已交付区间重叠达到自身一半即视为已交付 */
function isDelivered(delivered, msgId, a, b) {
  const rs = delivered.get(msgId);
  if (!rs) return false;
  const len = Math.max(1, b - a);
  let cov = 0;
  for (const [s, e] of rs) cov += overlapLen(a, b, s, e);
  return cov >= len * 0.5;
}
function markLocal(delivered, msgId, a, b) {
  if (!delivered.has(msgId)) delivered.set(msgId, []);
  delivered.get(msgId).push([a, b]);
}

/**
 * recall 主流程（导出以便单测）。返回 { text, processId, delivered, remaining }
 */
function runRecall(store, args, now = Date.now()) {
  const { query, alternatives, sources } = args;
  const fromMs = checkDate('from', args.from, false);
  const toMs = checkDate('to', args.to, false);
  if (fromMs != null && toMs != null && toMs < fromMs) throw new ArgError(`参数 to（${args.to}）不能早于 from（${args.from}）。${DATE_HINT}`);
  const since = fromMs ?? undefined;
  const until = toMs != null ? endOfDay(toMs) : undefined;
  const processId = (args.process_id && String(args.process_id).trim()) || crypto.randomUUID();

  const { concepts, atoms } = buildConcepts(query, alternatives);
  if (!concepts.length) throw new ArgError('参数 query 不能为空。');
  const filt = { sources, since, until };

  // 1) 召回原料：每个原子词分别检索正文；短语/词同时检索标题
  //    合并时设总量上限（消息条数 + 正文估算字节），先到先停
  const msgRows = new Map();
  let candBytes = 0;
  for (const a of atoms) {
    for (const r of store.recallTermHits(a, { ...filt, limit: TERM_HIT_LIMIT })) {
      if (msgRows.has(r.id)) continue;
      const bytes = String(r.content || '').length * 2;
      // 至少保留一条候选，避免单条超大消息导致完全没有结果
      if (msgRows.size >= MAX_CAND_MESSAGES || (candBytes > 0 && candBytes + bytes > MAX_CAND_BYTES)) break;
      candBytes += bytes;
      msgRows.set(r.id, r);
    }
    if (msgRows.size >= MAX_CAND_MESSAGES || candBytes >= MAX_CAND_BYTES) break;
  }
  const titleConvs = new Map();
  for (const a of atoms) {
    if ([...a].length < 2) continue;
    for (const c of store.recallTitleHits(a, { ...filt, limit: 50 })) titleConvs.set(c.id, c);
  }
  // 标题命中但正文没有命中的会话：用首条用户消息作为代表片段（同样计入候选上限）
  const convWithMsgHit = new Set([...msgRows.values()].map((r) => r.conversation_id));
  for (const c of titleConvs.values()) {
    if (convWithMsgHit.has(c.id)) continue;
    if (msgRows.size >= MAX_CAND_MESSAGES || candBytes >= MAX_CAND_BYTES) break;
    const m = store.firstMessage(c.id);
    if (!m) continue;
    const at = m.created_at ?? c.updated_at;
    if (since != null && at < since) continue;
    if (until != null && at > until) continue;
    const bytes = String(m.content || '').length * 2;
    if (candBytes > 0 && candBytes + bytes > MAX_CAND_BYTES) break;
    candBytes += bytes;
    msgRows.set(m.id, { ...m, source: c.source, title: c.title, workspace: c.workspace, updated_at: c.updated_at, message_count: c.message_count, ingest_method: c.ingest_method });
  }

  // 2) 打分 → 候选片段
  const cands = [];
  for (const r of msgRows.values()) {
    const at = r.created_at ?? r.updated_at;
    const sc = scoreMessage(r.content, r.title, r.role, at, concepts, atoms, now);
    const parts = sc.hasContentHit ? clusters(r.content, sc.positions, sc.matched) : [{ s: 0, e: Math.min(r.content.length, 1), k: 0 }];
    parts.forEach((p, i) => {
      const win = expandWindow(r.content, p.s, p.e, HIT_MAX);
      const factor = sc.matched ? 0.6 + 0.4 * (p.k / sc.matched) : 1;
      cands.push({ row: r, at, win, score: sc.score * factor - i * 0.01, partial: win[0] > 0 || win[1] < r.content.length });
    });
  }
  cands.sort((x, y) => y.score - x.score || (y.at || 0) - (x.at || 0));

  // 3) 去重 + 选段
  store.pruneDelivered(DELIVERED_TTL, now);
  const delivered = store.getDelivered(processId);
  const picked = [];
  const perConv = new Map();
  const newRanges = [];
  let budget = TOTAL_CHAR_BUDGET;
  for (const c of cands) {
    if (picked.length >= SEGMENTS_PER_CALL) break;
    const r = c.row;
    if (isDelivered(delivered, r.id, c.win[0], c.win[1])) continue;
    if ((perConv.get(r.conversation_id) || 0) >= MAX_SEGMENTS_PER_CONV) continue;
    // 紧邻上下文：命中用户发言 → 附下一条 AI 回复开头；命中 AI → 附上一条用户提问结尾
    const nbSeq = r.role === 'user' ? r.seq + 1 : r.seq - 1;
    const nb = nbSeq >= 0 ? store.getMessagesBySeq(r.conversation_id, [nbSeq])[0] : null;
    const lines = [];
    const ranges = [{ msgId: r.id, start: c.win[0], end: c.win[1] }];
    let ctx = null;
    if (nb && nb.role !== r.role) {
      const w = nb.seq < r.seq ? tailWindow(nb.content, CTX_MAX) : headWindow(nb.content, CTX_MAX);
      // 上下文已在本 process 交付过整段时不再重复附带
      if (!isDelivered(delivered, nb.id, w[0], w[1])) ctx = { m: nb, w };
    }
    const hitLine = `${roleTag(r.role)} ${excerpt(r.content, c.win)}`;
    const ctxLine = ctx ? `${roleTag(ctx.m.role)} ${excerpt(ctx.m.content, ctx.w)}` : null;
    const size = hitLine.length + (ctxLine ? ctxLine.length : 0);
    if (picked.length && size > budget) continue;
    if (ctx && ctx.m.seq < r.seq) lines.push(ctxLine, hitLine); else if (ctx) lines.push(hitLine, ctxLine); else lines.push(hitLine);
    if (ctx) ranges.push({ msgId: ctx.m.id, start: ctx.w[0], end: ctx.w[1] });
    for (const g of ranges) markLocal(delivered, g.msgId, g.start, g.end);
    newRanges.push(...ranges);
    budget -= size;
    perConv.set(r.conversation_id, (perConv.get(r.conversation_id) || 0) + 1);
    picked.push({ c, lines, partial: c.partial || (ctx && (ctx.w[0] > 0 || ctx.w[1] < ctx.m.content.length)) });
  }

  // 4) 剩余候选（未交付、且与已交付不重叠）
  const left = cands.filter((c) => !isDelivered(delivered, c.row.id, c.win[0], c.win[1]));
  const leftByConv = new Map();
  for (const c of left) leftByConv.set(c.row.conversation_id, (leftByConv.get(c.row.conversation_id) || 0) + 1);

  store.addDelivered(processId, newRanges, now);

  // 5) 输出纯文本
  const scope = [
    since != null || until != null ? `时间 ${args.from || '不限'} 至 ${args.to || '不限'}` : '时间不限',
    sources && sources.length ? `来源 ${sources.map(srcName).join('、')}` : '全部来源',
  ].join('，');
  const terms = concepts.map((c) => `「${c.text}」`).join(' ');
  const out = [];
  if (!picked.length) {
    if (cands.length) out.push(`检索词 ${terms}（${scope}）的相关候选片段已在本 process_id 下全部交付过，没有新的片段。请基于已拿到的原文作答，或换个角度/放宽范围再查。`);
    else out.push(`在当前范围（${scope}）内未找到与 ${terms} 相关的原文。这只代表本地备份在此范围内未命中，不代表用户从未聊过；可换同义词、中英文变体或放宽时间/来源后再试，切勿编造记忆。`);
  } else {
    out.push(`检索词 ${terms}（${scope}）本次交付 ${picked.length} 段原文证据，按相关度与时间综合排序。以下均为本地备份的原文摘录（未改写；「…」表示截断处）。[用户] 是用户本人的发言，[AI] 是当时 AI 的回复——AI 的建议不等于用户已接受的决定。`);
    picked.forEach((p, i) => {
      const r = p.c.row;
      const notes = [];
      if (p.partial) notes.push('仅截取长消息局部');
      const more = (leftByConv.get(r.conversation_id) || 0);
      if (more) notes.push(`同会话另有 ${more} 处命中未展示`);
      const time = isWeb(r.source)
        ? `${fmtTime(p.c.at)}（插件采集时间，非实际发送时间）`
        : `${fmtTime(p.c.at)}${r.created_at ? '' : '（会话更新时间）'}`;
      out.push('');
      out.push(`【${i + 1}】来源：${srcName(r.source)} ｜ 会话：${(r.title || '（无标题）').replace(/\s+/g, ' ').slice(0, 120)} ｜ 时间：${time}`);
      if (r.workspace) out.push(`工作区：${r.workspace}`);
      if (notes.length) out.push(`说明：${notes.join('；')}`);
      out.push(...p.lines);
    });
  }
  out.push('');
  if (left.length) out.push(MORE_HINT);
  out.push(FOOTER(processId));
  return { text: out.join('\n'), processId, delivered: picked.length, remaining: left.length };
}

/** list_conversations 主流程（导出以便单测） */
function runList(store, args) {
  const fromMs = checkDate('from', args.from, true);
  const toMs = checkDate('to', args.to, true);
  if (toMs < fromMs) throw new ArgError(`参数 to（${args.to}）不能早于 from（${args.from}）。${DATE_HINT}`);
  const days = dayCount(fromMs, toMs);
  if (days > MAX_RANGE_DAYS) throw new ArgError(`日期跨度为 ${days} 天，超过上限 ${MAX_RANGE_DAYS} 天。请把范围拆成不超过 ${MAX_RANGE_DAYS} 天的具体起止日期（YYYY-MM-DD）分次查询。`);
  const since = fromMs; const until = endOfDay(toMs);
  const { activity, meta } = store.conversationActivity({ since, until, sources: args.sources });
  // 按（本地日期, 会话）聚合；SQL 已按（会话, 时间戳）合并计数
  const byDay = new Map();
  let total = 0;
  for (const [cid, list] of activity) {
    total++;
    for (const p of list) {
      const day = fmtDay(p.at);
      if (!byDay.has(day)) byDay.set(day, new Map());
      const m = byDay.get(day);
      let g = m.get(cid);
      if (!g) { g = { cid, first: p.at, last: p.at, n: 0, untimed: !!p.untimed }; m.set(cid, g); }
      g.first = Math.min(g.first, p.at); g.last = Math.max(g.last, p.at);
      if (!p.untimed) g.n += p.n;
    }
  }
  const scope = args.sources && args.sources.length ? `来源 ${args.sources.map(srcName).join('、')}` : '全部来源';
  const rangeLabel = args.from === args.to ? args.from : `${args.from} 至 ${args.to}`;
  const out = [];
  if (!total) {
    out.push(`${rangeLabel}（${scope}）没有找到有活动的会话。这只代表本地备份在该范围内没有记录；可放宽日期或来源，或直接用 recall 按主题检索。`);
    return { text: out.join('\n'), total: 0 };
  }
  out.push(`${rangeLabel}（${scope}）共有 ${total} 个会话有活动，按本地时区日期整理，新的在前。只列目录、不含正文；需要原文请调用 recall。`);
  if ([...meta.values()].some((c) => isWeb(c.source))) out.push('注：网页来源（标「网页」）的时间为浏览器插件采集时间，并非消息实际发送时间。');
  let listed = 0;
  const sortedDays = [...byDay.keys()].sort().reverse();
  outer: for (const day of sortedDays) {
    const items = [...byDay.get(day).values()].sort((a, b) => b.last - a.last);
    out.push('');
    out.push(`## ${day}（${items.length} 个会话）`);
    for (const g of items) {
      if (listed >= MAX_LIST_ITEMS) { out.push(`…（目录过长已截断，共 ${total} 个会话；请缩小日期范围或限定来源）`); break outer; }
      const c = meta.get(g.cid);
      if (!c) continue;
      const title = (c.title || '（无标题）').replace(/\s+/g, ' ').slice(0, 100);
      const span = fmtHm(g.first) === fmtHm(g.last) ? fmtHm(g.first) : `${fmtHm(g.first)}–${fmtHm(g.last)}`;
      const time = isWeb(c.source) ? `采集于 ${span}` : (g.untimed ? `更新于 ${span}` : span);
      const cnt = g.untimed ? `共 ${c.message_count} 条消息` : `当日 ${g.n} 条 / 共 ${c.message_count} 条消息`;
      out.push(`- [${srcName(c.source)}] ${title} · ${time} · ${cnt}`);
      listed++;
    }
  }
  return { text: out.join('\n'), total };
}

// ---------- MCP Server ----------
const INSTRUCTIONS = [
  'mem0 是用户本机的 AI 对话备份（Claude Code、Codex、DeepSeek Harness、Antigravity、ZCode、DimCode、WorkBuddy 以及 ChatGPT、Claude、Gemini、DeepSeek、豆包、元宝、Kimi、千问、Grok、Hark 等网页对话）。',
  '当任务涉及用户过往的想法、表态与决定、偏好或项目背景，而当前上下文不足时使用本服务：',
  '- 已知日期、想先看那段时间聊过哪些话题：调用 list_conversations（from/to 为具体日期 YYYY-MM-DD，跨度 ≤31 天）。',
  '- 需要与某主题相关的原文证据：直接调用 recall（不必每次先列目录），并自行准备同义词/拆词/中英文变体放进 alternatives。',
  'recall 首次返回的 process_id 是当前对话窗口的固定值，之后每次调用 recall 都原样传回，服务端会自动跳过已交付片段。',
  '所有返回都是本地原文摘录，未经任何模型改写；[用户] 是用户本人发言，[AI] 是过往 AI 的回复，不要把 AI 的建议当成用户已接受的决定。未找到只代表当前范围内没有命中，不要编造记忆。',
].join('\n');

function buildServer(store, version, onSuccess) {
  const server = new McpServer({ name: 'mem0', version }, { instructions: INSTRUCTIONS });
  const webList = ALL_SOURCES.filter((s) => s.endsWith('-web')).join('、');
  const sourcesSchema = z.array(z.enum(ALL_SOURCES)).max(ALL_SOURCES.length).optional()
    .describe(`可选，限定来源；不填或空数组 = 全部已存来源。本机：claude-code、codex、deepseek-harness、antigravity、zcode、dimcode、workbuddy；网页插件（时间为采集时间）：${webList}`);
  const dateSchema = (d) => z.string().regex(DATE_RE, `必须是 YYYY-MM-DD 格式的真实日期（如 2026-11-03）；模糊的周/月请先换算成具体日期`).describe(d);

  const wrap = (fn) => async (args) => {
    try {
      const res = fn(args);
      let today = null;
      try { today = store.bumpMcpCall(); } catch { /* 计数失败不影响工具结果 */ }
      if (today != null) { try { mcpEvents.emit('call', { today }); } catch { /* 监听方异常不影响工具结果 */ } }
      if (onSuccess) { try { onSuccess(today); } catch { /* ignore */ } }
      return text(res.text);
    } catch (e) {
      if (e instanceof ArgError) return errText(`参数错误：${e.message}`);
      return errText(`内部错误：${e && e.message ? e.message : String(e)}`);
    }
  };

  server.registerTool('list_conversations', {
    title: '按日期查看会话目录',
    description: '按本地时区日期列出用户在指定日期范围内有活动的 AI 会话目录（日期、来源、会话标题、时间、消息数），不含消息正文。适合「已知大概日期，想先看那几天聊过哪些话题」。from/to 必须是具体日期 YYYY-MM-DD（单日查询时二者相同），to 不得早于 from，跨度最多 31 天；「上周」「本月」等请先换算成具体日期。网页插件来源的时间为插件采集时间。需要原文时调用 recall。',
    inputSchema: {
      from: dateSchema('查询起始日期（含），YYYY-MM-DD，本地时区；单日查询时与 to 相同'),
      to: dateSchema('查询结束日期（含），YYYY-MM-DD，本地时区；不得早于 from，跨度最多 31 天'),
      sources: sourcesSchema,
    },
  }, wrap((a) => runList(store, a)));

  server.registerTool('recall', {
    title: '挑重点调取历史对话原文',
    description: [
      '跨全部来源检索用户历史 AI 对话，返回与主题最相关的少量真实原文片段（每段附紧邻上下文），而不是整篇会话。',
      '用法：query 填核心检索词或短句；alternatives 由你在调用前自行准备同义词、拆词、中英文变体（最多 8 个）以提高召回；可选 from/to（YYYY-MM-DD）与 sources 限定范围。',
      '首次调用会签发 process_id（见返回末尾）；之后在同一对话窗口内每次调用都必须原样传回同一个 process_id，即使更换 query 也不要更换——服务端会自动跳过已交付片段，想看更多同主题证据就用同样参数再调一次。',
      '请依据返回的真实原文完成任务，严格区分 [用户]（用户本人发言）与 [AI]（过往 AI 的回复）：不要把过往 AI 的建议当成用户已经接受的决定。没有结果仅代表当前范围内未找到，不要编造记忆。',
    ].join('\n'),
    inputSchema: {
      query: z.string().trim().min(1).max(200).describe('核心检索词或短句（如「数据库迁移方案」）'),
      alternatives: z.array(z.string().trim().min(1).max(100)).max(8).optional()
        .describe('可选，最多 8 个：同义词、拆词或中英文变体（如 ["数据库 迁移", "migration", "schema 变更"]），与 query 合并检索'),
      from: dateSchema('可选，时间下限（含），YYYY-MM-DD，本地时区').optional(),
      to: dateSchema('可选，时间上限（含），YYYY-MM-DD，本地时区').optional(),
      sources: sourcesSchema,
      process_id: z.string().trim().min(1).max(128).optional()
        .describe('当前对话窗口的固定去重标识：首次不填，由服务端签发；之后每次原样传回'),
    },
  }, wrap((a) => runRecall(store, a)));

  return server;
}

const ALLOWED_HOSTS = (port) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

/** 定长比较，避免按字符提前返回泄露密钥前缀；长度不同直接失败 */
function tokenEquals(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
/** 请求头里的 Bearer 密钥；没有则返回空串（查询参数另取） */
function headerToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function startMcpServer(store, { port = DEFAULT_PORT, version = '0.1.0', onCall, token: fixedToken } = {}) {
  const hosts = ALLOWED_HOSTS(port);
  let token;
  try { token = fixedToken || mcpToken(dataDir()); }
  catch (e) { return Promise.reject(e); } // 数据目录不可写：与端口占用一样走启动失败分支
  const sockets = new Set(); // 所有连接（含 keep-alive），关闭时统一断开
  const inFlight = new Set(); // 在途请求，关闭时最多等 CLOSE_GRACE_MS
  let closing = false;
  let onDrained = null;
  let closePromise = null;
  const drain = () => {
    if (closing && onDrained && !inFlight.size) { const f = onDrained; onDrained = null; f(); }
  };
  const handleRequest = async (req, res) => {
    // 防 DNS rebinding / 浏览器跨站调用（保持在密钥校验之前）
    if (!hosts.has(req.headers.host || '')) { res.writeHead(403).end('forbidden host'); return; }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) { res.writeHead(403).end('forbidden origin'); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return; }
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }

    // 两种方式都接受：请求头 Bearer，或 URL 查询参数；二者任一正确即可
    const provided = [headerToken(req), url.searchParams.get('token') || ''];
    if (!provided.some((v) => tokenEquals(v, token))) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: null, error: { code: -32001, message: '未授权：缺少或错误的访问密钥。请在请求头带 Authorization: Bearer <token>，或在地址后加 ?token=<token>。' },
      }));
      return;
    }

    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) { res.writeHead(413, { connection: 'close' }).end(); req.destroy(); return; } }
    let json;
    try { json = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }

    const server = buildServer(store, version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, json);
      if (onCall) onCall(json);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e.message || e));
    }
  };
  const httpServer = http.createServer((req, res) => {
    inFlight.add(res);
    res.on('close', () => { inFlight.delete(res); drain(); });
    handleRequest(req, res).catch(() => { inFlight.delete(res); drain(); });
  });
  httpServer.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(token)}`,
      port,
      token,
      /** 给在途请求最多 CLOSE_GRACE_MS 收尾，超时强制断开所有连接 */
      close: () => {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = new Promise((r) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            onDrained = null;
            for (const s of sockets) s.destroy();
            sockets.clear();
            httpServer.close(() => r());
          };
          const timer = setTimeout(finish, CLOSE_GRACE_MS);
          if (timer.unref) timer.unref();
          if (!inFlight.size) { finish(); return; }
          onDrained = finish;
        });
        return closePromise;
      },
    }));
  });
}

module.exports = { startMcpServer, DEFAULT_PORT, mcpEvents, _internal: { runRecall, runList, parseDay, expandWindow, buildConcepts, tokenEquals, headerToken } };
