'use strict';
/**
 * 后台静默轻量 AI 自动整理：配置、密钥、网络、脱敏与截断基础设施（SPEC 3.1-3.4）。
 *
 * 本模块可同时在 Electron 主进程与纯 Node 单测环境运行：
 * - Electron 环境可注入 electron（safeStorage / net.fetch）；纯 Node 自动降级 b64 密钥与 globalThis.fetch。
 * - 双水位线 / 空闲防抖 / 严格写入边界 / 粘贴拆卡均在此实现（SPEC 3.5 / 3.6）。
 */

const { MEMORY_GROUPS } = require('./db');

/** 4 个内置快速预设（SPEC 3.1） */
const AI_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needKey: true },
  { id: 'gemini', label: 'Gemini Flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needKey: true },
  { id: 'openai', label: 'OpenAI 兼容 / 中转', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true },
  { id: 'ollama', label: '本地 Ollama（免 Key）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needKey: false },
];

/** kv 键名（仅本模块使用） */
const AI_CONFIG_KV = 'ai_config';
const AI_KEY_KV = 'ai_api_key';
/** 首次启用 AI 自动整理时记录的时间水位线（SPEC 3.5） */
const AI_ENABLE_WATERMARK_KV = 'ai_enable_watermark';

/** 粘贴导入可选的「新建推进事项」目标 */
const NEW_PROJECT_TARGET = '__new_project__';
/** 后台自动整理唯一允许写入的常驻分组（代码写死，绝不由模型决定） */
const AI_PITFALL_GROUP = '踩坑与经验库';
/** 主动整理旧对话的默认批大小 */
const DEFAULT_OLD_BATCH = 20;

/** 默认网络超时（SPEC 3.2：30 秒） */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 截断保真预算（SPEC 3.4） */
const HEAD_KEEP = 4500;
const TAIL_KEEP = 7000;
const DEFAULT_MAX_CHARS = 12000;

function presetOf(id) {
  return AI_PRESETS.find((p) => p.id === id) || null;
}

function isMaskedKey(value) {
  return typeof value === 'string' && value.includes('••••');
}

/** 公开展示的 Key 掩码：保留前 3 位与后 4 位，中间固定 4 个圆点（如 sk-••••9a3f） */
function keyHintOf(key) {
  if (!key) return '';
  if (key.length < 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/**
 * Chat Completions URL 规范化（SPEC 3.1）：
 * - 去首尾空白与末尾多余 /；
 * - 已以 /chat/completions 结尾直接返回；
 * - 已有路径（非空且非 /）补 /chat/completions；
 * - 裸 origin 补 /v1/chat/completions。
 */
function resolveChatCompletionsUrl(baseUrl) {
  let s = String(baseUrl == null ? '' : baseUrl).trim();
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(s)) return s;

  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (!/^https?:$/i.test(u.protocol)) return '';
  const p = u.pathname.replace(/\/+$/, '');
  u.pathname = (!p || p === '/') ? '/v1/chat/completions' : `${p}/chat/completions`;
  return u.toString();
}

/**
 * 发送前隐私脱敏（SPEC 3.4）。仅处理临时拼接文本，绝不回写 messages 表。
 */
function redactSecretsForLLM(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer [REDACTED_TOKEN]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]');
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_TOKEN]');
  s = s.replace(/\bAKIA[0-9A-Z]{16,}\b/g, '[REDACTED_TOKEN]');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_TOKEN]');
  return s;
}

function formatTranscript(messages) {
  const list = Array.isArray(messages) ? messages : (messages == null ? [] : [messages]);
  return list.map((m) => {
    if (typeof m === 'string') return `[用户] ${m}`;
    const role = m && typeof m.role === 'string' ? m.role : '';
    const label = role === 'assistant' ? 'AI' : role === 'user' || !role ? '用户' : role;
    const content = m && m.content != null ? m.content : '';
    return `[${label}] ${content}`;
  }).join('\n\n');
}

function truncationMarker(omitted) {
  return `\n\n...[中间省略 ${omitted} 字]...\n\n`;
}

/**
 * 12,000 字首尾保真截断（SPEC 3.4）：
 * 格式化并脱敏后，超长时保留前 4500 + 省略提示 + 后 7000；任何 maxChars 下总长严格 <= maxChars。
 */
function prepareTranscriptForLLM(messages, maxChars = DEFAULT_MAX_CHARS) {
  const full = redactSecretsForLLM(formatTranscript(messages));
  let limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit < 0) limit = DEFAULT_MAX_CHARS;
  limit = Math.floor(limit);
  if (limit <= 0) return '';
  if (full.length <= limit) return full;

  let headLen;
  let tailLen;
  if (limit >= HEAD_KEEP + TAIL_KEEP) {
    headLen = HEAD_KEEP;
    tailLen = TAIL_KEEP;
  } else {
    // maxChars 不足以容纳 4500 + 7000 时，按同样比例保留首尾，仍保证首尾都保真。
    const reserve = 48;
    const avail = Math.max(0, limit - reserve);
    headLen = Math.min(HEAD_KEEP, Math.floor((avail * HEAD_KEEP) / (HEAD_KEEP + TAIL_KEEP)));
    tailLen = Math.min(TAIL_KEEP, Math.max(0, avail - headLen));
  }

  for (let i = 0; i < 8; i++) {
    const omitted = Math.max(0, full.length - headLen - tailLen);
    const marker = truncationMarker(omitted);
    const over = headLen + tailLen + marker.length - limit;
    if (over <= 0) return full.slice(0, headLen) + marker + full.slice(full.length - tailLen);
    if (tailLen > 0) {
      tailLen = Math.max(0, tailLen - over);
      continue;
    }
    if (headLen > 0) {
      headLen = Math.max(0, headLen - over);
      continue;
    }
    break;
  }

  // 极端小的 maxChars：连省略提示都放不下，退化为首尾对半保留（仍严格 <= maxChars）。
  if (limit < 2) return full.slice(0, limit);
  const half = Math.floor(limit / 2);
  return full.slice(0, half) + full.slice(full.length - (limit - half));
}

/** 归一化导入目标：只允许 4 个常驻分组或「新建推进事项」，非法值回退 fallbackGroup。 */
function normalizeImportTarget(target, fallbackGroup) {
  const fbRaw = typeof fallbackGroup === 'string' ? fallbackGroup.trim() : fallbackGroup;
  const fb = MEMORY_GROUPS.includes(fbRaw)
    ? fbRaw
    : (fbRaw === NEW_PROJECT_TARGET ? NEW_PROJECT_TARGET : MEMORY_GROUPS[0]);
  const next = typeof target === 'string' ? target.trim() : target;
  if (MEMORY_GROUPS.includes(next) || next === NEW_PROJECT_TARGET) return next;
  return fb;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => String(x).trim());
}

function dedupeStrings(value) {
  const seen = new Set();
  const out = [];
  for (const x of normalizeStringList(value)) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function nonEmptyString(value) {
  return value == null ? '' : String(value).trim();
}

/** 提取 JSON 候选文本（兼容 ```json 围栏与前后说明文字）；解析失败返回 null。 */
function extractJsonCandidate(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return '';
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence && fence[1] && fence[1].trim()) s = fence[1].trim();
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) return s;
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  let end = -1;
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
    start = firstObj;
    end = s.lastIndexOf('}');
  } else if (firstArr >= 0) {
    start = firstArr;
    end = s.lastIndexOf(']');
  }
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}

function parseLLMJson(text) {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** 兼容旧命名：自动整理固定期望一个 JSON 对象。 */
function parseOrganizerJson(text) {
  return parseLLMJson(text);
}

/** 本地确定性短标题（与 v4 参考原型一致）。 */
function deriveShortTitle(raw, fallback = '新增要点') {
  const first = String(raw == null ? '' : raw).trim().split('\n')[0].replace(/^[-*+\d.)#\s`]+/, '').trim();
  if (!first) return fallback;
  const cut = first.split(/[；。！？：:—]/)[0].trim() || first;
  return cut.length > 26 ? `${cut.slice(0, 26)}…` : cut;
}

function stripBoldTitle(value) {
  return String(value == null ? '' : value).trim().replace(/^\*\*|\*\*$/g, '').trim();
}

/** 单段文本 → { title, body }（标题行 / 粗体小标题 / 「标题：正文」/ 首行短句）。 */
function draftFromText(text) {
  const clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!clean) return { title: '', body: '' };
  const lines = clean.split('\n');
  const first = lines[0].trim();
  const heading = /^#{1,6}\s+(.*)$/.exec(first);
  if (heading) {
    const title = stripBoldTitle(heading[1]);
    const body = lines.slice(1).join('\n').trim();
    return { title, body: body || title };
  }
  const boldLine = /^\*\*([^*\n]{2,60})\*\*\s*$/.exec(first);
  if (boldLine) {
    const title = boldLine[1].trim();
    const body = lines.slice(1).join('\n').trim();
    return { title, body: body || title };
  }
  const inlineBold = /^\*\*([^*\n]{2,60})\*\*\s*[：:]\s*([\s\S]+)$/.exec(clean);
  if (inlineBold) return { title: inlineBold[1].trim(), body: inlineBold[2].trim() };
  const firstColon = /^([^：:\n]{1,32})[：:]\s*(.*)$/.exec(first);
  if (firstColon && firstColon[2].trim()) {
    const body = [firstColon[2].trim(), ...lines.slice(1)].filter(Boolean).join('\n').trim();
    return { title: firstColon[1].trim(), body };
  }
  const firstLine = first.replace(/^[-*+\d.)#\s`]+/, '').replace(/[：:]$/, '').trim();
  if (lines.length >= 2 && firstLine && firstLine.length <= 32 && !/^([-*+]|\d+[.)])\s/.test(first) && !/^```/.test(first)) {
    const body = lines.slice(1).join('\n').trim();
    return { title: firstLine, body: body || firstLine };
  }
  return { title: deriveShortTitle(clean), body: clean };
}

/** 一段内若含 >= 2 个同级列表项，则逐项拆成草稿；否则返回 []。 */
function splitListItems(block) {
  const lines = String(block || '').split('\n');
  const marker = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;
  let minIndent = Infinity;
  let count = 0;
  for (const line of lines) {
    const m = marker.exec(line);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '    ').length;
    if (indent < minIndent) minIndent = indent;
    count++;
  }
  if (count < 2) return [];
  const items = [];
  const intro = [];
  let cur = null;
  for (const line of lines) {
    const m = marker.exec(line);
    const indent = m ? m[1].replace(/\t/g, '    ').length : -1;
    if (m && indent === minIndent) {
      if (cur) items.push(cur);
      cur = [m[3]];
    } else if (cur) {
      cur.push(line);
    } else if (line.trim()) {
      intro.push(line);
    }
  }
  if (cur) items.push(cur);
  if (items.length < 2) return [];
  if (intro.length) items.unshift(intro);
  return items.map((arr) => draftFromText(arr.join('\n').trim())).filter((x) => x.title || x.body);
}

/**
 * 本地确定性粘贴拆卡（SPEC 3.6 第 3 点）：
 * 先按 Markdown 标题切；无标题时按空行分段，段内若为列表则按同级列表项切。
 * target 只使用 fallbackGroup（非法时回退第一个常驻分组），绝不受文本内容影响。
 */
function splitPastedTextToDrafts(rawText, fallbackGroup) {
  const target = normalizeImportTarget('__invalid__', fallbackGroup);
  const clean = String(rawText == null ? '' : rawText).replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];

  const lines = clean.split('\n');
  let inFence = false;
  let h23 = 0;
  let h1 = 0;
  for (const ln of lines) {
    const t = ln.trim();
    if (/^```/.test(t)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^#{2,3}\s+\S+/.test(t)) h23++;
    else if (/^#\s+\S+/.test(t)) h1++;
  }

  const chunks = [];
  if (h23 > 0 || h1 >= 2) {
    const re = h23 > 0 ? /^#{2,3}\s+(.*)$/ : /^#\s+(.*)$/;
    let curTitle = '';
    let curBody = [];
    inFence = false;
    const flush = () => {
      const body = curBody.join('\n').trim();
      if (curTitle || body) chunks.push({ title: curTitle || deriveShortTitle(body), body: body || curTitle });
      curTitle = '';
      curBody = [];
    };
    for (const ln of lines) {
      const t = ln.trim();
      if (/^```/.test(t)) { inFence = !inFence; curBody.push(ln); continue; }
      if (!inFence && h23 > 0 && !curTitle && !curBody.join('').trim() && /^#\s+(.*)$/.test(t)) continue;
      const m = !inFence ? re.exec(t) : null;
      if (m) { flush(); curTitle = stripBoldTitle(m[1]); }
      else curBody.push(ln);
    }
    flush();
  } else {
    const blocks = [];
    let buf = [];
    inFence = false;
    const flushBlock = () => { const b = buf.join('\n').trim(); if (b) blocks.push(b); buf = []; };
    for (const ln of lines) {
      const t = ln.trim();
      if (/^```/.test(t)) { inFence = !inFence; buf.push(ln); continue; }
      if (!inFence && !t) { flushBlock(); continue; }
      buf.push(ln);
    }
    flushBlock();
    for (const block of blocks) {
      const items = splitListItems(block);
      if (items.length) chunks.push(...items);
      else chunks.push(draftFromText(block));
    }
  }

  return chunks
    .map((c) => ({ title: String(c.title || '').trim(), body: String(c.body || '').trim() }))
    .filter((c) => c.title || c.body)
    .map((c) => ({ title: c.title || deriveShortTitle(c.body), body: c.body || c.title, target }));
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

function isLoopbackUrl(url) {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function extractChatText(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : (choice ? choice.text : undefined);
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.content === 'string') return part.content;
      return '';
    }).join('');
  }
  if (data && typeof data.output_text === 'string') return data.output_text;
  throw new Error('AI 接口响应缺少文本内容');
}

function shortError(error) {
  const msg = error && error.message ? error.message : String(error || '未知错误');
  return msg.split('\n')[0].slice(0, 300);
}

class AiOrganizer {
  constructor({ store, electron, fetchImpl, idleMs, checkIntervalMs, now, timeoutMs } = {}) {
    this.store = store || null;
    this.electron = electron || null;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.idleMs = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : 5 * 60 * 1000;
    this.checkIntervalMs = Number.isFinite(checkIntervalMs) && checkIntervalMs > 0 ? checkIntervalMs : 60 * 1000;
    this.now = typeof now === 'function' ? now : Date.now;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

    this.organizing = false;
    this.unorganizedCount = 0;
    this.statusText = '未配置';
    this.statusOk = false;
    this._timer = null;
    this._checking = false;
    this._lastError = '';
    this._loadConfig();
    this._refreshStatus();
    this._ensureWatermark();
    this._refreshUnorganizedCount();
  }

  // ---------- 配置读写 ----------
  _getKv(key) {
    if (!this.store || typeof this.store.getKv !== 'function') return null;
    try { return this.store.getKv(key); } catch { return null; }
  }

  _setKv(key, value) {
    if (!this.store || typeof this.store.setKv !== 'function') return;
    this.store.setKv(key, value);
  }

  _loadConfig() {
    const fallback = presetOf('deepseek');
    const cfg = { enabled: false, provider: fallback.id, baseUrl: fallback.baseUrl, model: fallback.model };
    let parsed = null;
    try {
      const raw = this._getKv(AI_CONFIG_KV);
      if (raw) parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      if (parsed.enabled !== undefined) cfg.enabled = !!parsed.enabled;
      if (typeof parsed.provider === 'string' && parsed.provider.trim()) cfg.provider = parsed.provider.trim();
      if (typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()) cfg.baseUrl = parsed.baseUrl.trim();
      if (typeof parsed.model === 'string' && parsed.model.trim()) cfg.model = parsed.model.trim();
    }
    this.config = cfg;
  }

  _persistConfig() {
    this._setKv(AI_CONFIG_KV, JSON.stringify({
      enabled: !!this.config.enabled,
      provider: this.config.provider,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
    }));
  }

  _safeStorage() {
    const ss = this.electron && this.electron.safeStorage;
    if (!ss || typeof ss.encryptString !== 'function' || typeof ss.decryptString !== 'function') return null;
    if (typeof ss.isEncryptionAvailable === 'function') {
      try {
        if (!ss.isEncryptionAvailable()) return null;
      } catch {
        return null;
      }
    }
    return ss;
  }

  /** 读取库内明文 Key（仅进程内使用，绝不经 getPublicState 泄露）。 */
  getApiKey() {
    const raw = this._getKv(AI_KEY_KV);
    if (!raw) return '';
    if (raw.startsWith('enc:')) {
      const ss = this._safeStorage();
      if (!ss) return '';
      try {
        const out = ss.decryptString(Buffer.from(raw.slice(4), 'base64'));
        return Buffer.isBuffer(out) ? out.toString('utf8') : String(out == null ? '' : out);
      } catch {
        return '';
      }
    }
    if (raw.startsWith('b64:')) {
      try { return Buffer.from(raw.slice(4), 'base64').toString('utf8'); } catch { return ''; }
    }
    // 兼容手工写入的旧明文（新代码永不这样落盘）。
    return String(raw);
  }

  _setApiKey(apiKey) {
    if (!apiKey) {
      this._setKv(AI_KEY_KV, '');
      return;
    }
    const ss = this._safeStorage();
    if (ss) {
      try {
        const encrypted = ss.encryptString(apiKey);
        const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
        this._setKv(AI_KEY_KV, `enc:${buf.toString('base64')}`);
        return;
      } catch {
        // 加密失败时继续走 b64 降级，绝不裸存明文。
      }
    }
    this._setKv(AI_KEY_KV, `b64:${Buffer.from(apiKey, 'utf8').toString('base64')}`);
  }

  needKey() {
    const preset = presetOf(this.config.provider);
    return preset ? !!preset.needKey : true;
  }

  _refreshStatus() {
    const ready = !this.needKey() || !!this.getApiKey();
    this.statusText = this.config.enabled && ready ? '已就绪' : '未配置';
    this.statusOk = false;
  }

  // ---------- 双水位线 / 空闲防抖（SPEC 3.5） ----------
  /** 首次启用时写入 ai_enable_watermark；之后永久复用该基准水位线。 */
  _ensureWatermark() {
    let wm = Number(this._getKv(AI_ENABLE_WATERMARK_KV));
    if (Number.isFinite(wm) && wm > 0) return wm;
    if (!this.config.enabled) return null;
    wm = Number(this.now());
    if (!Number.isFinite(wm) || wm <= 0) wm = Date.now();
    this._setKv(AI_ENABLE_WATERMARK_KV, String(wm));
    return wm;
  }

  /** 只统计旧会话条数，绝不触发请求。 */
  _refreshUnorganizedCount() {
    if (!this.store || typeof this.store.countAiOldCandidates !== 'function') {
      this.unorganizedCount = 0;
      return 0;
    }
    const watermark = this._ensureWatermark();
    this.unorganizedCount = watermark ? Number(this.store.countAiOldCandidates(watermark)) || 0 : 0;
    return this.unorganizedCount;
  }

  /** 当前配置是否真的可以发请求（开启 + 需要 Key 时已有 Key）。 */
  _aiUsable() {
    return !!this.config.enabled && (!this.needKey() || !!this.getApiKey());
  }

  /** 分页读全量消息（getConversation 单页上限 2000），不修改 messages 表。 */
  _readAllMessages(id) {
    const out = [];
    let fromSeq = 0;
    for (let page = 0; page < 50; page++) {
      const conv = this.store.getConversation(id, { fromSeq, limit: 2000 });
      if (!conv) break;
      const list = Array.isArray(conv.messages) ? conv.messages : [];
      out.push(...list);
      if (list.length < 2000) break;
      const last = list[list.length - 1];
      if (!last || !Number.isFinite(Number(last.seq))) break;
      fromSeq = Number(last.seq) + 1;
    }
    return out;
  }

  /**
   * 保存配置。apiKey 为空/未传/掩码占位时复用库内旧 Key；仅显式新 Key 覆盖，
   * `{ clearKey: true }` 才清空。返回不含 apiKey 的公开状态。
   */
  saveConfig(cfg = {}) {
    const input = cfg && typeof cfg === 'object' ? cfg : {};
    const prevProvider = this.config.provider;
    const next = { ...this.config };

    if (Object.prototype.hasOwnProperty.call(input, 'enabled')) next.enabled = !!input.enabled;
    if (input.provider !== undefined) {
      const provider = String(input.provider == null ? '' : input.provider).trim();
      if (provider) next.provider = provider;
    }

    const preset = presetOf(next.provider);
    if (next.provider !== prevProvider && preset) {
      if (input.baseUrl === undefined) next.baseUrl = preset.baseUrl;
      if (input.model === undefined) next.model = preset.model;
    }
    if (input.baseUrl !== undefined) {
      const baseUrl = String(input.baseUrl == null ? '' : input.baseUrl).trim();
      next.baseUrl = baseUrl || (preset ? preset.baseUrl : next.baseUrl);
    }
    if (input.model !== undefined) {
      const model = String(input.model == null ? '' : input.model).trim();
      next.model = model || (preset ? preset.model : next.model);
    }
    if (!next.baseUrl) next.baseUrl = (presetOf('deepseek') || {}).baseUrl || '';
    if (!next.model) next.model = (preset || presetOf('deepseek') || {}).model || '';

    this.config = next;
    this._persistConfig();

    const currentKey = this.getApiKey();
    if (input.clearKey === true) {
      this._setApiKey('');
    } else if (input.apiKey !== undefined && input.apiKey !== null) {
      const provided = String(input.apiKey);
      if (provided.trim() && !isMaskedKey(provided)) this._setApiKey(provided.trim());
    }
    // 其它情况（空字符串 / 未传 / 掩码）自动复用 currentKey，无需重写。

    this._refreshStatus();
    this._ensureWatermark();
    this._refreshUnorganizedCount();
    return this.getPublicState();
  }

  /** SPEC 3.3：仅返回公开字段，绝不包含 apiKey。 */
  getPublicState() {
    const apiKey = this.getApiKey();
    return {
      enabled: !!this.config.enabled,
      provider: this.config.provider,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      hasKey: !!apiKey,
      keyHint: keyHintOf(apiKey),
      statusText: this.statusText,
      statusOk: !!this.statusOk,
      unorganizedCount: Number(this.unorganizedCount) || 0,
      organizing: !!this.organizing,
    };
  }

  // ---------- 网络层 ----------
  _fetchFor(url) {
    // 注入的测试替身优先级最高。
    if (this.fetchImpl) return { fn: this.fetchImpl, ctx: undefined };
    // 回环地址一律 globalThis.fetch 直连，避免全局代理把本地 Ollama / Mock Server 发往远端。
    if (isLoopbackUrl(url)) {
      if (typeof globalThis.fetch !== 'function') throw new Error('当前运行环境不支持 fetch');
      return { fn: globalThis.fetch, ctx: globalThis };
    }
    const net = this.electron && this.electron.net;
    if (net && typeof net.fetch === 'function') return { fn: net.fetch, ctx: net };
    if (typeof globalThis.fetch !== 'function') throw new Error('当前运行环境不支持 fetch');
    return { fn: globalThis.fetch, ctx: globalThis };
  }

  /**
   * 调 Chat Completions 并返回首条文本。默认 30 秒超时。
   * @param {Array<{role:string, content:string}>} messages
   * @param {{ maxTokens?: number, timeoutMs?: number }} [options]
   */
  async callChat(messages, options = {}) {
    const list = Array.isArray(messages)
      ? messages
      : [{ role: 'user', content: String(messages == null ? '' : messages) }];
    const url = resolveChatCompletionsUrl(this.config.baseUrl);
    if (!url) throw new Error('AI 接口地址无效');

    const apiKey = this.getApiKey();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const body = { model: this.config.model, messages: list };
    if (options && options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const requestedTimeout = Number(options && options.timeoutMs);
    const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : this.timeoutMs;
    const picked = this._fetchFor(url);
    const controller = new AbortController();
    let timer = null;
    const timeoutError = new Error(`AI 请求超时（${Math.round(timeout / 1000)} 秒）`);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, timeout);
    });

    let res;
    try {
      // Promise.race 兜底：即使注入的 fetchImpl 不响应 AbortSignal，也会按超时失败。
      const request = Promise.resolve().then(() => picked.fn.call(picked.ctx, url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }));
      res = await Promise.race([request, timeoutPromise]);
    } catch (e) {
      if (e === timeoutError || controller.signal.aborted) throw timeoutError;
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res) throw new Error('AI 接口无响应');
    const status = Number(res.status) || 0;
    if (res.ok === false || status >= 400) {
      let detail = '';
      if (typeof res.text === 'function') {
        try { detail = String(await res.text()); } catch { detail = ''; }
      }
      const label = `HTTP ${status}${res.statusText ? ` ${res.statusText}` : ''}`;
      const snippet = detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 300)}` : '';
      throw new Error(`${label}${snippet}`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('AI 接口返回的不是合法 JSON');
    }
    return extractChatText(data);
  }

  /** 发送最小连通性探针并保存配置；返回 { ok, latencyMs, error? }。 */
  async testConfig(cfg = {}) {
    this.saveConfig(cfg);
    const started = this.now();
    try {
      await this.callChat([{ role: 'user', content: '请只回复 OK' }], { maxTokens: 8 });
      const latencyMs = this._elapsed(started);
      this.statusOk = true;
      this.statusText = `连接正常 · ${latencyMs}ms`;
      return { ok: true, latencyMs };
    } catch (e) {
      const latencyMs = this._elapsed(started);
      const error = shortError(e);
      this.statusOk = false;
      this.statusText = error;
      return { ok: false, latencyMs, error };
    }
  }

  _elapsed(started) {
    const elapsed = Number(this.now()) - Number(started);
    return Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed) : 0;
  }

  // ---------- 后台定时器 / 单会话整理 / 旧对话批处理 ----------
  /** 启动后台空闲检查定时器；重复 start 不会叠加定时器。 */
  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => {
      this.checkNow().catch(() => {});
    }, this.checkIntervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    return this;
  }

  /** 停止后台定时器（幂等）。 */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this;
  }

  /**
   * 手动触发一次空闲检查（定时器与单测共用）。同一时间只允许一轮检查，
   * 每轮内部串行调用 organizeConversation，因此同一时间只有一个 LLM 请求。
   */
  async checkNow() {
    if (this._checking) return 0;
    this._checking = true;
    try {
      if (!this._aiUsable()) {
        this._refreshUnorganizedCount();
        return 0;
      }
      const watermark = this._ensureWatermark();
      if (!watermark) return 0;
      if (!this.store || typeof this.store.listAiIdleCandidates !== 'function') return 0;
      const idleBefore = Number(this.now()) - this.idleMs;
      const rows = this.store.listAiIdleCandidates({ watermark, idleBefore, limit: 20 });
      let organized = 0;
      for (const row of rows) {
        if (!this.config.enabled || !this._aiUsable()) break;
        const r = await this.organizeConversation(row.id);
        if (r) organized++;
      }
      this._refreshUnorganizedCount();
      return organized;
    } finally {
      this._checking = false;
    }
  }

  /**
   * 单会话自动整理：读消息 → 脱敏截断 → 带活跃事项列表请求 → 解析 JSON → 严格写库。
   * 解析失败 / 网络失败 / 未启用均不写库；成功后才推进 ai_organized_at 与 ai_msg_watermark。
   */
  async organizeConversation(id) {
    if (!id || this.organizing || !this._aiUsable()) return null;
    this.organizing = true;
    try {
      const conv = this.store.getConversation(id, { fromSeq: 0, limit: 1 });
      if (!conv) return null;
      const messages = this._readAllMessages(id);
      if (!messages.length) return null;
      const transcript = prepareTranscriptForLLM(messages.map((m) => ({ role: m.role, content: m.content })));
      if (!transcript.trim()) return null;
      const projects = this.store.listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        workspace: p.workspace || '',
        state: p.state,
      }));
      const prompt = [
        '你是本地对话整理助手。请只输出一个 JSON 对象，不要输出 Markdown 说明。',
        '字段：shortTitle, summary, decisions, nextStep, projectMatch, pitfallCard。',
        'projectMatch.action 只能是 none / existing / new；existing 时必须使用下面列表中的真实事项 id；',
        '日常独立零散问答必须选 none。pitfallCard 仅在有明确故障根因与修复结论时给出，否则为 null。',
        `当前活跃推进事项：${JSON.stringify(projects)}`,
        '对话原文（已脱敏）：',
        transcript,
      ].join('\n');
      const text = await this.callChat([
        { role: 'system', content: '你只返回严格 JSON，不返回任何解释或代码围栏。' },
        { role: 'user', content: prompt },
      ], { maxTokens: 1600 });
      const data = parseLLMJson(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      // 水位用本次实际送审的消息条数，请求飞行期间新入库的消息留给下一轮
      const result = this._applyOrganization(conv, data, messages.length);
      if (result) this._refreshUnorganizedCount();
      return result;
    } catch (e) {
      this._lastError = shortError(e);
      return null;
    } finally {
      this.organizing = false;
    }
  }

  /** 按 SPEC 3.6 严格写入：标题/事项锁保护 + 仅踩坑分组 + 推进事项合并。 */
  _applyOrganization(conv, data, sentCount) {
    const fresh = this.store.getConversation(conv.id, { fromSeq: 0, limit: 1 });
    if (!fresh) return null;
    const patch = {};

    const shortTitle = nonEmptyString(data.shortTitle).slice(0, 300);
    if (shortTitle && Number(fresh.title_locked) === 0) patch.title = shortTitle;
    if (Number(fresh.summary_locked || 0) === 0) {
      if (data.summary !== undefined) {
        const nextSummary = nonEmptyString(data.summary);
        if (nextSummary || !nonEmptyString(fresh.summary)) patch.summary = nextSummary;
      }
      if (data.decisions !== undefined) {
        const nextDecisions = normalizeStringList(data.decisions);
        let had = [];
        try { had = JSON.parse(fresh.decisions_json || '[]'); } catch { had = []; }
        if (nextDecisions.length || !(Array.isArray(had) && had.length)) patch.decisions = nextDecisions;
      }
      if (data.nextStep !== undefined) patch.nextStep = nonEmptyString(data.nextStep);
    }

    // 事项锁：锁定后连事项合并/新建都不做，确保锁定事项字段完全不变。
    let projectId;
    if (Number(fresh.project_locked) === 0) projectId = this._applyProjectMatch(data.projectMatch);
    if (projectId !== undefined) patch.projectId = projectId;

    const pitfall = this._applyPitfallCard(fresh, data.pitfallCard);

    const organizedAt = Number(this.now());
    patch.aiOrganizedAt = Number.isFinite(organizedAt) && organizedAt > 0 ? organizedAt : Date.now();
    const sent = Number(sentCount);
    patch.aiMsgWatermark = Number.isFinite(sent) && sent >= 0 ? Math.min(sent, Number(fresh.message_count) || 0) : (Number(fresh.message_count) || 0);

    const row = this.store.applyAiOrganization(fresh.id, patch);
    return row ? {
      id: row.id,
      title: row.title,
      summary: row.summary,
      decisions: row.decisions,
      nextStep: row.next_step,
      projectId: row.project_id,
      pitfallCardId: pitfall ? pitfall.id : null,
      organizedAt: row.ai_organized_at,
      messageWatermark: row.ai_msg_watermark,
    } : null;
  }

  /** 合并已有事项（必须是真实未归档 id）或新建事项；返回要写入会话的 project_id。 */
  _applyProjectMatch(pm) {
    if (!pm || typeof pm !== 'object' || Array.isArray(pm)) return undefined;
    const action = nonEmptyString(pm.action).toLowerCase();
    if (action === 'existing') {
      const pid = nonEmptyString(pm.projectId);
      if (!pid) return undefined;
      const existing = this.store.getProject(pid);
      if (!existing || existing.archived) return undefined;
      const decisions = dedupeStrings([...(existing.decisions || []), ...normalizeStringList(pm.addedDecisions)]);
      const rejected = dedupeStrings([...(existing.rejected || []), ...normalizeStringList(pm.addedRejected)]);
      const state = nonEmptyString(pm.state) || existing.state;
      const progress = nonEmptyString(pm.progress) || existing.progress;
      const nextStep = nonEmptyString(pm.nextStep) || existing.nextStep;
      const changed = JSON.stringify(decisions) !== JSON.stringify(existing.decisions || [])
        || JSON.stringify(rejected) !== JSON.stringify(existing.rejected || [])
        || state !== existing.state
        || progress !== existing.progress
        || nextStep !== existing.nextStep;
      if (changed) {
        this.store.saveProject({
          id: existing.id,
          name: existing.name,
          state,
          workspace: existing.workspace,
          progress,
          decisions,
          rejected,
          nextStep,
          archived: existing.archived,
        });
      }
      return existing.id;
    }
    if (action === 'new') {
      const name = (nonEmptyString(pm.newProjectName) || nonEmptyString(pm.name)).slice(0, 120);
      if (!name) return undefined;
      const proj = this.store.saveProject({
        name,
        state: nonEmptyString(pm.state) || '推进中',
        progress: nonEmptyString(pm.progress),
        decisions: normalizeStringList(pm.addedDecisions),
        rejected: normalizeStringList(pm.addedRejected),
        nextStep: nonEmptyString(pm.nextStep),
      });
      return proj ? proj.id : undefined;
    }
    return undefined;
  }

  /**
   * 踩坑卡写入：分组硬编码为「踩坑与经验库」，绝不读取模型给出的 group/target 字段；
   * 同名卡按标题合并（body 更新记 superseded，tags/sourceIds 去重并集）。
   */
  _applyPitfallCard(conv, card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
    const title = nonEmptyString(card.title).slice(0, 120);
    const body = nonEmptyString(card.body);
    if (!title || !body) return null;
    const group = AI_PITFALL_GROUP;
    const tags = normalizeStringList(card.tags).slice(0, 20);
    const existing = this.store.listMemories({ group }).find((m) => String(m.title || '').trim() === title);
    if (!existing) {
      return this.store.saveMemory({
        group,
        title,
        body,
        tags,
        sourceIds: [conv.id],
        originLabel: 'AI 自动沉淀',
      });
    }
    const sameBody = existing.body === body;
    return this.store.saveMemory({
      id: existing.id,
      group,
      title,
      body: sameBody ? existing.body : body,
      tags: dedupeStrings([...(existing.tags || []), ...tags]),
      sourceIds: dedupeStrings([...(existing.sourceIds || []), conv.id]),
      originLabel: 'AI 自动沉淀',
      superseded: sameBody ? existing.superseded : existing.body,
    });
  }

  /**
   * 主动整理历史旧会话（用户点击「整理旧对话」才调用）。
   * 按 limit 串行逐条处理；中途 enabled 被关闭立即停止。
   */
  async organizeOldConversations({ limit } = {}) {
    const rawLimit = Number(limit);
    const batch = limit === undefined || limit === null || !Number.isFinite(rawLimit)
      ? DEFAULT_OLD_BATCH
      : Math.max(0, Math.min(Math.trunc(rawLimit), 500));
    if (!this._aiUsable()) {
      const remaining = this._refreshUnorganizedCount();
      return { organized: 0, remaining };
    }
    if (!batch) return { organized: 0, remaining: this._refreshUnorganizedCount() };
    const watermark = this._ensureWatermark();
    if (!watermark) return { organized: 0, remaining: 0 };
    if (!this.store || typeof this.store.listAiOldCandidates !== 'function') {
      return { organized: 0, remaining: this._refreshUnorganizedCount() };
    }
    const rows = this.store.listAiOldCandidates({ watermark, limit: batch });
    let organized = 0;
    for (const row of rows) {
      if (!this.config.enabled) break;
      const r = await this.organizeConversation(row.id);
      if (r) organized++;
      this._refreshUnorganizedCount();
    }
    return { organized, remaining: this._refreshUnorganizedCount() };
  }

  /**
   * 粘贴导入智能拆卡：AI 未启用 / 无 Key / 网络报错 / 返回非数组时无缝回退本地确定性切分。
   * target 只允许 4 个常驻分组或「新建推进事项」。
   */
  async splitImportWithAI(rawText, fallbackGroup) {
    const fallback = normalizeImportTarget('__invalid__', fallbackGroup);
    const raw = String(rawText == null ? '' : rawText).trim();
    if (!raw) return [];
    const local = () => splitPastedTextToDrafts(raw, fallback);
    if (!this._aiUsable()) return local();
    try {
      const redacted = redactSecretsForLLM(raw);
      const allowed = MEMORY_GROUPS.concat(NEW_PROJECT_TARGET).join(' / ');
      const text = await this.callChat([
        {
          role: 'system',
          content: `你是记忆拆卡助手。只返回 JSON 数组，每项 {"title","body","target"}；target 只能是：${allowed}。默认归属：${fallback}。不要输出解释。`,
        },
        { role: 'user', content: redacted },
      ], { maxTokens: 2000 });
      const data = parseLLMJson(text);
      if (!Array.isArray(data) || !data.length) return local();
      const drafts = data.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const title = nonEmptyString(item.title);
        const body = nonEmptyString(item.body);
        if (!title && !body) return null;
        return {
          title: title || deriveShortTitle(body),
          body: body || title,
          target: normalizeImportTarget(nonEmptyString(item.target), fallback),
        };
      }).filter(Boolean);
      return drafts.length ? drafts : local();
    } catch {
      return local();
    }
  }
}

module.exports = {
  AI_PRESETS,
  AI_CONFIG_KV,
  AI_KEY_KV,
  AI_ENABLE_WATERMARK_KV,
  AI_WATERMARK_KV: AI_ENABLE_WATERMARK_KV,
  NEW_PROJECT_TARGET,
  AI_PITFALL_GROUP,
  DEFAULT_OLD_BATCH,
  DEFAULT_TIMEOUT_MS,
  HEAD_KEEP,
  TAIL_KEEP,
  DEFAULT_MAX_CHARS,
  resolveChatCompletionsUrl,
  redactSecretsForLLM,
  prepareTranscriptForLLM,
  isLoopbackHost,
  normalizeImportTarget,
  parseLLMJson,
  parseOrganizerJson,
  deriveShortTitle,
  splitPastedTextToDrafts,
  AiOrganizer,
};