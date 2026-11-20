'use strict';
/**
 * 后台静默轻量 AI 自动整理：配置、密钥、网络、脱敏与截断基础设施（SPEC 3.1-3.4）。
 *
 * 本模块可同时在 Electron 主进程与纯 Node 单测环境运行：
 * - Electron 环境可注入 electron（safeStorage / net.fetch）；纯 Node 自动降级 b64 密钥与 globalThis.fetch。
 * - 双水位线 / 空闲防抖 / 严格写入边界 / 粘贴拆卡均在此实现（SPEC 3.5 / 3.6）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { MEMORY_GROUPS } = require('./db');
const { sourceRoots } = require('./paths');

/** 4 个内置快速预设（SPEC 3.1） */
const AI_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needKey: true },
  { id: 'gemini', label: 'Gemini Flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needKey: true },
  { id: 'openai', label: 'OpenAI 兼容 / 中转', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true },
  { id: 'ollama', label: '本地 Ollama（免 Key）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needKey: false },
];

/** OpenAI 双接口协议（SPEC 3.1 / AC2.1） */
const API_MODES = ['chat_completions', 'responses'];
const DEFAULT_API_MODE = 'chat_completions';
const CHAT_SUFFIX = '/chat/completions';
const RESPONSES_SUFFIX = '/responses';
/** 仅支持 Chat Completions 的内置预设：点这些胶囊必定切回 chat_completions（AC2.3） */
const CHAT_ONLY_PRESET_IDS = ['deepseek', 'gemini', 'ollama'];

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
/** 推理模型 / Responses 模式的默认全周期超时（AC5.4：90 秒） */
const REASONING_TIMEOUT_MS = 90_000;
/** 本地 Ollama /api/show 探针超时（回环地址，短超时避免拖慢模型列表） */
const OLLAMA_SHOW_TIMEOUT_MS = 5_000;
/** Ollama 档位结果缓存时长（同一模型短时间重复解析不重复探测） */
const OLLAMA_EFFORTS_TTL_MS = 30_000;
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

/** 合法化协议模式：非法值回退 fallback（默认 chat_completions）。 */
function normalizeApiMode(apiMode, fallback = DEFAULT_API_MODE) {
  if (API_MODES.includes(apiMode)) return apiMode;
  return API_MODES.includes(fallback) ? fallback : DEFAULT_API_MODE;
}

/**
 * 推理档位（AC4.3）：开放字符串直通，绝不按白名单裁剪。
 * 空串 `''` 表示「默认（不传参数）」，与显式 `'none'` 严格区分；非字符串一律归空串。
 */
function normalizeReasoningEffort(value) {
  return typeof value === 'string' ? value : '';
}

/** 当前协议对应的接口后缀。 */
function apiModeSuffix(apiMode) {
  return normalizeApiMode(apiMode) === 'responses' ? RESPONSES_SUFFIX : CHAT_SUFFIX;
}

/**
 * 解析接口地址（在 new URL() 之前剥离末尾 `#` 锁定标记，修复 new URL 吞 `#`）。
 * 返回 { locked, url, path } 或 null；path 已去掉末尾多余 `/`。
 */
function parseApiBase(baseUrl) {
  let s = String(baseUrl == null ? '' : baseUrl).trim();
  if (!s) return null;
  // 末尾 `#` 是「锁定」标记：new URL() 会把它吞成空 hash，必须在解析前剥离。
  const locked = /#$/.test(s);
  if (locked) s = s.slice(0, -1).trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(u.protocol)) return null;
  u.hash = '';
  const path = u.pathname.replace(/\/+$/, '');
  return { locked, url: u, path };
}

/** 剥离路径末尾已有的 /chat/completions 或 /responses。 */
function stripProtocolSuffix(path) {
  const p = String(path == null ? '' : path);
  if (/\/chat\/completions$/i.test(p)) return p.slice(0, -CHAT_SUFFIX.length);
  if (/\/responses$/i.test(p)) return p.slice(0, -RESPONSES_SUFFIX.length);
  return p;
}

/**
 * 最终请求 URL（SPEC / AC2.2）：
 * - 末尾 `#`：裸域名禁补 /v1，直接拼当前协议后缀；已有非根路径 100% 原样锁定；
 * - 无 `#`：裸域名补 /v1 + 后缀；已有路径先剥离 /chat/completions 或 /responses 再补当前后缀；
 * - 查询串（如 ?api-version=）始终保留且不会重复拼接路径。
 */
function buildEndpoint(baseUrl, apiMode) {
  const mode = normalizeApiMode(apiMode);
  const suffix = apiModeSuffix(mode);
  const parsed = parseApiBase(baseUrl);
  if (!parsed) return '';
  const { locked, url, path } = parsed;
  const isRoot = !path || path === '/';

  if (locked) {
    // 裸域名 + #：不补 /v1，直接拼协议后缀；已有非根路径：原样锁定，绝不追加。
    if (isRoot) url.pathname = suffix;
  } else if (isRoot) {
    url.pathname = `/v1${suffix}`;
  } else {
    url.pathname = `${stripProtocolSuffix(path)}${suffix}`;
  }
  return url.toString();
}

/**
 * [获取模型] 地址（AC2.2 第 3 点）：基于同一 pathname 推导 /models。
 * 裸域名（或剥离协议后缀后为空）补 /v1/models；末尾带 `#` 的裸域名与协议后缀锁定一致，禁补 /v1。
 */
function buildModelsUrl(baseUrl) {
  const parsed = parseApiBase(baseUrl);
  if (!parsed) return '';
  const { locked, url, path } = parsed;
  const basePath = stripProtocolSuffix(path).replace(/\/+$/, '');
  const isRoot = !basePath || basePath === '/';
  if (isRoot) url.pathname = locked ? '/models' : '/v1/models';
  else url.pathname = `${basePath}/models`;
  return url.toString();
}

/** 站点同源归一化（AC3.2 防旧 Key 跨站）：协议 + 主机 + 端口，非法地址返回 ''。 */
function normalizeOrigin(baseUrl) {
  const parsed = parseApiBase(baseUrl);
  if (!parsed) return '';
  return parsed.url.origin;
}

/**
 * 协议自动对齐（按地址后缀）：以 /responses 结尾 → responses；以 /chat/completions 结尾 → chat。
 * 其它地址保持当前模式，绝不猜测。
 */
function apiModeFromBaseUrl(baseUrl, fallback = DEFAULT_API_MODE) {
  const current = normalizeApiMode(fallback);
  const parsed = parseApiBase(baseUrl);
  if (!parsed) return current;
  if (/\/responses$/i.test(parsed.path)) return 'responses';
  if (/\/chat\/completions$/i.test(parsed.path)) return 'chat_completions';
  return current;
}

/**
 * 协议自动对齐（按 /models 返回的 New-API supported_endpoint_types）：
 * 非空且仅含 'openai-response'（不含 'openai'）→ responses；
 * 非空且仅含 'openai'（不含 'openai-response'）→ chat_completions；
 * 未返回端点类型 / 同时含两种 → 保持 fallback，绝不按模型名盲目暗切。
 */
function apiModeFromEndpointTypes(types, fallback = DEFAULT_API_MODE) {
  const current = normalizeApiMode(fallback);
  const list = (Array.isArray(types) ? types : [])
    .map((t) => nonEmptyString(t).toLowerCase())
    .filter(Boolean);
  if (!list.length) return current;
  const hasChat = list.includes('openai');
  const hasResponses = list.includes('openai-response');
  if (hasResponses && !hasChat) return 'responses';
  if (hasChat && !hasResponses) return 'chat_completions';
  return current;
}

/** 预设胶囊对齐：DeepSeek / Gemini Flash / 本地 Ollama 必定切回 chat_completions。 */
function apiModeForPreset(providerId, fallback = DEFAULT_API_MODE) {
  const id = nonEmptyString(providerId);
  if (CHAT_ONLY_PRESET_IDS.includes(id)) return 'chat_completions';
  return normalizeApiMode(fallback);
}

/** 读取模型项自带的端点类型（New-API supported_endpoint_types，兼容 metadata 包装）。 */
function endpointTypesOf(item) {
  if (!item || typeof item !== 'object') return [];
  let types = item.supported_endpoint_types;
  if (!Array.isArray(types) && item.metadata && typeof item.metadata === 'object') {
    types = item.metadata.supported_endpoint_types;
  }
  if (!Array.isArray(types)) return [];
  return types.map((t) => nonEmptyString(t)).filter(Boolean);
}

/**
 * 双向智能对齐总入口：端点类型优先于 URL 后缀，预设胶囊强制 chat_completions 优先于两者。
 * @param {{ provider?: string, baseUrl?: string, endpointTypes?: string[], currentMode?: string, presetTouched?: boolean }} input
 */
function alignApiMode(input = {}) {
  const opts = input && typeof input === 'object' ? input : {};
  const current = normalizeApiMode(opts.currentMode);
  if (opts.presetTouched === true) return apiModeForPreset(opts.provider, current);
  if (Array.isArray(opts.endpointTypes) && opts.endpointTypes.length) {
    return apiModeFromEndpointTypes(opts.endpointTypes, current);
  }
  return apiModeFromBaseUrl(opts.baseUrl, current);
}

// ---------- 推理档位识别（AC4.1 / AC4.2） ----------

/**
 * 归一化模型 ID（AC4.2）：依次剥离 `provider/` 前缀、`:tag` 路由标签与 `-2025-01-01` 日期后缀，统一小写。
 * 例：`openai/gpt-5.2-pro:beta-2025-08-07` → `gpt-5.2-pro`。
 */
function normalizeModelId(modelId) {
  let s = nonEmptyString(modelId).trim();
  if (!s) return '';
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  const colon = s.indexOf(':');
  if (colon > 0) s = s.slice(0, colon);
  s = s.replace(/-202\d-\d{2}-\d{2}$/i, '');
  return s.trim().toLowerCase();
}

/** 通配匹配：`*` 匹配任意字符，整串锚定（AC4.2 规则库专用）。 */
function globMatch(pattern, value) {
  const p = String(pattern || '').toLowerCase();
  if (!p) return false;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * 第 2 级家族规则库（AC4.2）：具体变体排在主家族之前，逐条对应 SPEC 原文。
 * 命中返回新数组（可为显式 `[]`），未命中返回 null。
 */
const FAMILY_EFFORT_RULES = [
  // 显式无档位
  { patterns: ['gpt-4o*', 'o1-mini*', 'o1-preview*', '*-chat-latest', 'deepseek-chat', 'deepseek-reasoner'], efforts: [] },
  // GPT-5 / GPT-6：pro / codex-max 等具体变体优先于主家族
  { patterns: ['gpt-5.2-pro*', 'gpt-5.4-pro*'], efforts: ['medium', 'high', 'xhigh'] },
  { patterns: ['gpt-5-pro*', 'o1-pro*', 'o3-pro*'], efforts: ['high'] },
  { patterns: ['gpt-5.1-codex-max*'], efforts: ['low', 'medium', 'high', 'xhigh'] },
  { patterns: ['gpt-5.2*', 'gpt-5.3*', 'gpt-5.4*'], efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { patterns: ['gpt-5.1*'], efforts: ['none', 'low', 'medium', 'high'] },
  { patterns: ['gpt-5*'], efforts: ['minimal', 'low', 'medium', 'high'] },
  { patterns: ['gpt-6*'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  // o 系列（pro / mini / preview 已在上面优先命中）
  { patterns: ['o1*', 'o3*', 'o4-mini*'], efforts: ['low', 'medium', 'high'] },
  // Gemini
  { patterns: ['gemini-2.5-flash*'], efforts: ['none', 'low', 'medium', 'high'] },
  { patterns: ['gemini-2.5-pro*'], efforts: ['low', 'medium', 'high'] },
  { patterns: ['gemini-3*-flash*'], efforts: ['minimal', 'low', 'medium', 'high'] },
  { patterns: ['gemini-3*-pro*', 'gemini-4*'], efforts: ['low', 'medium', 'high'] },
  // Claude
  { patterns: ['claude-opus-4-7*'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { patterns: ['claude-opus-4-6*'], efforts: ['low', 'medium', 'high', 'max'] },
  { patterns: ['claude-sonnet-4-6*', 'claude-*-4-5*', 'claude-3-7-sonnet*'], efforts: ['low', 'medium', 'high'] },
  // 其它家族
  { patterns: ['grok-3-mini*'], efforts: ['low', 'high'] },
  { patterns: ['deepseek-v4*', 'deepseek-flash*'], efforts: ['none', 'low', 'medium', 'high', 'max'] },
  { patterns: ['qwen3*', 'qwq*', 'glm-4.5*', 'glm-z1*'], efforts: ['none', 'low', 'medium', 'high'] },
];

/** 第 2 级：按归一化模型家族匹配档位（AC4.2）。未命中返回 null。 */
function familyEfforts(modelId) {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  for (const rule of FAMILY_EFFORT_RULES) {
    if (rule.patterns.some((p) => globMatch(p, id))) return rule.efforts.slice();
  }
  return null;
}

/**
 * 档位数组归一化：字符串直取；`{ effort | level }` 对象取字段；布尔值按 Ollama 语义映射
 * （false → 'none'，true → 'high'）。非数组返回 null（表示该字段不存在，区别于空数组）。
 */
function normalizeEffortList(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const entry of value) {
    let name = '';
    if (typeof entry === 'string') name = entry;
    else if (typeof entry === 'boolean') name = entry ? 'high' : 'none';
    else if (entry && typeof entry === 'object') {
      name = nonEmptyString(entry.effort || entry.level || entry.id || entry.name || entry.value);
    }
    name = String(name || '').trim().toLowerCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 第 1 级：解析 `/models` 响应项自带的网关元数据（AC4.1）：
 * OpenRouter `reasoning.supported_efforts`（mandatory 时剔除 'none'）、
 * Codex `supported_reasoning_levels` / `supported_reasoning_efforts`、`thinking.levels`。
 * 字段存在即视为权威结果（可为 `[]`），完全不存在返回 null。
 */
function effortsFromModelMeta(item) {
  if (!item || typeof item !== 'object') return null;
  const holders = [item];
  if (item.metadata && typeof item.metadata === 'object') holders.push(item.metadata);
  for (const holder of holders) {
    const reasoning = holder.reasoning;
    if (reasoning && typeof reasoning === 'object') {
      const list = normalizeEffortList(reasoning.supported_efforts);
      if (list) return reasoning.mandatory === true ? list.filter((e) => e !== 'none') : list;
    }
    for (const key of ['supported_reasoning_levels', 'supported_reasoning_efforts']) {
      const list = normalizeEffortList(holder[key]);
      if (list) return list;
    }
    const thinking = holder.thinking;
    if (thinking && typeof thinking === 'object') {
      const list = normalizeEffortList(thinking.levels);
      if (list) return list;
    }
  }
  return null;
}

/**
 * 第 1 级：解析本地 Ollama `POST /api/show` 响应（AC4.1）。
 * `thinking.values` 字符串数组直取；布尔数组 `[false, true]` 映射为 `['none', 'high']`。
 */
function effortsFromOllamaShow(data) {
  if (!data || typeof data !== 'object') return null;
  const thinking = data.thinking;
  const values = thinking && typeof thinking === 'object' && !Array.isArray(thinking) ? thinking.values : thinking;
  return normalizeEffortList(values);
}

/** Codex models_cache.json 解析缓存（按文件 mtime 失效，只读，绝不写盘）。 */
let codexModelsCache = { file: '', mtimeMs: -1, size: -1, entries: [] };

/** 读取并缓存 Codex models_cache.json 的模型条目（容忍数组 / models / data / 对象映射四种结构）。 */
function readCodexModelsCache(file) {
  try {
    const stat = fs.statSync(file);
    if (codexModelsCache.file === file && codexModelsCache.mtimeMs === stat.mtimeMs && codexModelsCache.size === stat.size) return codexModelsCache.entries;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 兼容数组 / { models } / { data } / 以模型 ID 为键的对象映射
    const asList = (value) => {
      if (Array.isArray(value)) return value;
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value)
        .map(([key, entry]) => (entry && typeof entry === 'object' ? { id: key, ...entry } : null))
        .filter(Boolean);
    };
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && raw.models !== undefined) list = asList(raw.models);
    else if (raw && raw.data !== undefined) list = asList(raw.data);
    else if (raw && typeof raw === 'object') list = asList(raw);
    codexModelsCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, entries: list.filter((e) => e && typeof e === 'object') };
  } catch {
    codexModelsCache = { file, mtimeMs: -1, size: -1, entries: [] };
  }
  return codexModelsCache.entries;
}

/**
 * 第 1 级：只读解析 `${sourceRoots().codex}/models_cache.json` 里该模型的 supported_reasoning_levels（AC4.1）。
 * 必须经 paths.sourceRoots() 保持测试隔离，禁止硬编码用户主目录；文件缺失 / 损坏一律返回 null。
 */
function readCodexModelEfforts(modelId, roots = sourceRoots()) {
  const wanted = normalizeModelId(modelId);
  if (!wanted) return null;
  const codexRoot = roots && typeof roots === 'object' ? nonEmptyString(roots.codex) : '';
  if (!codexRoot) return null;
  const entries = readCodexModelsCache(path.join(codexRoot, 'models_cache.json'));
  for (const entry of entries) {
    const id = normalizeModelId(entry.slug || entry.id || entry.model || entry.name || entry.key);
    if (id && id === wanted) {
      const efforts = effortsFromModelMeta(entry);
      if (efforts) return efforts;
    }
  }
  return null;
}

/**
 * 三级漏斗（AC4.1 → AC4.2）：第 1 级（网关元数据 / 本机 Ollama / Codex 缓存）有结果就用，
 * 否则落到第 2 级家族规则；仍未命中返回 null（未知，区别于 `[]` 显式无档位）。
 * 第 3 级「开放字符串直通」由前端 UI 负责，本函数只给出模型原生档位。
 * 支持 `resolveEfforts({ modelId, item, ollamaEfforts, codexEfforts })` 与
 * `resolveEfforts(modelId, item, ollamaEfforts, codexEfforts)` 两种调用方式。
 * @param {{ modelId?: string, id?: string, model?: string, item?: object, ollamaEfforts?: string[], codexEfforts?: string[] }|string} input
 */
function resolveEfforts(input = {}, item, ollamaEfforts, codexEfforts) {
  const opts = input && typeof input === 'object'
    ? input
    : { modelId: input, item, ollamaEfforts, codexEfforts };
  const modelId = nonEmptyString(opts.modelId || opts.id || opts.model);
  if (!modelId) return null;
  const meta = effortsFromModelMeta(opts.item || opts.raw);
  if (meta) return meta;
  const ollama = normalizeEffortList(opts.ollamaEfforts);
  if (ollama) return ollama;
  const codex = normalizeEffortList(opts.codexEfforts);
  if (codex) return codex;
  return familyEfforts(modelId);
}

/** Chat Completions URL 规范化（保留旧导出，语义等价于 buildEndpoint(baseUrl, 'chat_completions')）。 */
function resolveChatCompletionsUrl(baseUrl) {
  return buildEndpoint(baseUrl, 'chat_completions');
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

/**
 * 构造自动整理的用户 Prompt（纯函数，便于单测）。
 * 明确列出完整 JSON 结构与全部子字段，并保留活跃推进事项列表与对话原文。
 */
function buildOrganizePrompt(projects, transcript) {
  return [
    '你是本地对话整理助手。请只输出一个 JSON 对象，不要输出 Markdown 说明。',
    'JSON 结构（必须严格按此字段名与类型输出）：',
    '{',
    '  "shortTitle": string,',
    '  "summary": string,',
    '  "decisions": string[],',
    '  "nextStep": string,',
    '  "projectMatch": {',
    '    "action": "none" | "existing" | "new",',
    '    "projectId"?: string,',
    '    "newProjectName"?: string,',
    '    "state"?: "推进中" | "卡住" | "待验证",',
    '    "progress"?: string,',
    '    "addedDecisions"?: string[],',
    '    "addedRejected"?: string[],',
    '    "nextStep"?: string',
    '  },',
    '  "pitfallCard": null | {',
    '    "title": string,',
    '    "body": string,',
    '    "tags": string[]',
    '  }',
    '}',
    '字段说明：',
    '- shortTitle: string（简明中文短标题）',
    '- summary: string（1~2 句话核心摘要）',
    '- decisions: string[]（已拍板结论，无则 []）',
    '- nextStep: string（下一步待办，无则 ""）',
    '- projectMatch.action 只能是 none / existing / new；action="existing" 时 projectId 必须填下面活跃推进事项列表里的真实 id；日常零散独立问答选 "none"。',
    '- pitfallCard: null 或对象；对话包含明确故障现象/踩坑根因与有效修复结论时输出对象，body 简明写清「根因 → 修复方法」，tags 给 1~3 个短标签；普通对话输出 null。',
    `当前活跃推进事项：${JSON.stringify(projects)}`,
    '对话原文（已脱敏）：',
    String(transcript == null ? '' : transcript),
  ].join('\n');
}

/** 开头连续 think / thought 思考块（AC5.5：仅锚定字符串开头剥离，绝不扫描正文内部）。 */
const LEADING_THINK_RE = /^\s*(?:<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>\s*)+/;

/**
 * 提取 JSON 候选文本（AC5.5）。
 * 只在字符串开头剥离 think / thought 思考块，不再从正文中间搜 `{` / `[`；
 * 整串代码围栏仍按首尾锚定剥一层，避免模型把 JSON 包在 ```json 里时解析失败。
 */
function extractJsonCandidate(text) {
  let s = String(text == null ? '' : text).replace(LEADING_THINK_RE, '').trim();
  if (!s) return '';
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(s);
  if (fence && fence[1] && fence[1].trim()) s = fence[1].trim();
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

// ---------- AC5：双协议请求体构造 ----------

/** AC5.2：Chat Completions 请求体（默认不发 max_tokens / temperature / top_p）。 */
function buildChatRequestBody(cfg, messages, effort) {
  const body = { model: cfg.model, messages };
  if (effort) body.reasoning_effort = effort;
  return body;
}

/** AC5.3：Responses 请求体（system / developer 抽为 instructions，其余转 input，默认 store: false）。 */
function buildResponsesRequestBody(cfg, messages, effort) {
  const instructions = [];
  const input = [];
  for (const message of messages) {
    const role = message && message.role ? String(message.role) : 'user';
    const content = message && typeof message.content === 'string'
      ? message.content
      : String(message && message.content != null ? message.content : '');
    if (role === 'system' || role === 'developer') {
      instructions.push(content);
      continue;
    }
    input.push({
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }],
    });
  }
  const body = { model: cfg.model, input, store: false };
  if (instructions.length) body.instructions = instructions.join('\n\n');
  if (effort) body.reasoning = { effort };
  return body;
}

// ---------- AC5.5：双模响应解析（标准 JSON / 无 res.text 的 mock / SSE 流） ----------

/** 响应头取值：兼容 Headers 实例与普通对象。 */
function responseHeader(res, name) {
  const headers = res && res.headers;
  if (!headers) return '';
  const target = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? '' : String(value);
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      return value == null ? '' : String(value);
    }
  }
  return '';
}

function apiErrorText(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  const msg = error.message || error.detail || error.code || error.type;
  if (msg) return String(msg);
  try { return JSON.stringify(error); } catch { return String(error); }
}

/** 顶层 `{ error }` / `type: 'error'` / `status: 'failed'` 一律抛出（AC5.5）。 */
function throwIfApiError(data) {
  if (!data || typeof data !== 'object') return;
  if (data.error) throw new Error(`AI 接口返回错误：${apiErrorText(data.error)}`);
  if (data.type === 'error') throw new Error(`AI 接口返回错误：${apiErrorText(data)}`);
  if (data.status === 'failed') throw new Error(`AI 接口返回失败：${apiErrorText(data.error || data)}`);
}

/** Responses 输出全文：优先 output_text，其次 output[].content[] 中的 output_text / text 片段。 */
function extractResponsesText(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.output_text === 'string' && node.output_text) return node.output_text;
  if (!Array.isArray(node.output)) return '';
  const parts = [];
  for (const item of node.output) {
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part || typeof part.text !== 'string') continue;
      if (part.type && part.type !== 'output_text' && part.type !== 'text') continue;
      parts.push(part.text);
    }
  }
  return parts.join('');
}

function extractTextFromJson(data, apiMode) {
  throwIfApiError(data);
  if (apiMode === 'responses') {
    const text = extractResponsesText(data);
    if (text) return text;
  }
  return extractChatText(data);
}

/** 按 SSE 规范切分事件（兼容 CRLF；`:` 开头为注释 / keep-alive，直接忽略）。 */
function parseSseEvents(raw) {
  const events = [];
  let event = '';
  let dataLines = [];
  const flush = () => {
    if (!event && !dataLines.length) return;
    events.push({ event, data: dataLines.join('\n') });
    event = '';
    dataLines = [];
  };
  for (const line of String(raw == null ? '' : raw).split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx < 0 ? line : line.slice(0, idx);
    let value = idx < 0 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value.trim();
    else if (field === 'data') dataLines.push(value);
  }
  flush();
  return events;
}

function tryJsonObject(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s === '[DONE]') return null;
  try {
    const data = JSON.parse(s);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** Chat Completions SSE：只累加 delta.content / message.content，思考增量与 keep-alive 一律过滤。 */
function parseChatSse(raw) {
  let text = '';
  let saw = false;
  for (const ev of parseSseEvents(raw)) {
    if (/keep-?alive/i.test(ev.event)) continue;
    const data = tryJsonObject(ev.data);
    if (!data) continue;
    throwIfApiError(data);
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) continue;
    const delta = choice.delta || choice.message || null;
    let piece = '';
    if (delta && typeof delta.content === 'string') {
      piece = delta.content;
    } else if (delta && Array.isArray(delta.content)) {
      piece = delta.content.map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      }).join('');
    } else if (!delta && typeof choice.text === 'string') {
      piece = choice.text;
    }
    if (!piece) continue;
    text += piece;
    saw = true;
  }
  if (!saw) throw new Error('AI 接口响应缺少文本内容');
  return text;
}

/** Responses SSE：response.completed 全文优先，否则累加 response.output_text.delta，绝不双倍拼接。 */
function parseResponsesSse(raw) {
  let deltaText = '';
  let completedText = '';
  for (const ev of parseSseEvents(raw)) {
    if (/keep-?alive/i.test(ev.event)) continue;
    const data = tryJsonObject(ev.data);
    if (!data) continue;
    const type = typeof data.type === 'string' ? data.type : ev.event;
    if (type === 'response.failed') {
      const response = data.response && typeof data.response === 'object' ? data.response : null;
      throw new Error(`AI 接口返回失败：${apiErrorText((response && response.error) || data.error || data)}`);
    }
    if (type === 'error') throw new Error(`AI 接口返回错误：${apiErrorText(data.error || data)}`);
    throwIfApiError(data);
    if (type === 'response.completed') {
      const text = extractResponsesText(data.response) || extractResponsesText(data);
      if (text) completedText = text;
      continue;
    }
    if (type === 'response.output_text.delta' && typeof data.delta === 'string') deltaText += data.delta;
  }
  if (completedText) return completedText;
  if (deltaText) return deltaText;
  throw new Error('AI 接口响应缺少文本内容');
}

function isSsePayload(raw, contentType) {
  if (/text\/event-stream/i.test(String(contentType || ''))) return true;
  const firstLine = String(raw == null ? '' : raw).split(/\r?\n/).find((line) => line.trim() !== '') || '';
  return /^(?:event|data):/.test(firstLine.trim());
}

/** 读取响应体：真实 Response 走 text()，无 res.text 的单测 mock 回退 json()（AC5.5 嗅探）。 */
async function readResponsePayload(res) {
  if (res && typeof res.text === 'function') {
    return { kind: 'text', text: String(await res.text()) };
  }
  if (res && typeof res.json === 'function') {
    return { kind: 'json', data: await res.json() };
  }
  return { kind: 'none' };
}

async function readErrorDetail(res) {
  if (!res || typeof res.text !== 'function') return '';
  try { return String(await res.text()); } catch { return ''; }
}

function httpErrorOf(res, detail) {
  const status = Number(res && res.status) || 0;
  const label = `HTTP ${status}${res && res.statusText ? ` ${res.statusText}` : ''}`;
  const snippet = detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : '';
  return new Error(`${label}${snippet}`);
}

/** 成功响应 → 文本（SSE 或标准 JSON 双模）。 */
async function consumeSuccessResponse(res, apiMode) {
  const payload = await readResponsePayload(res);
  if (payload.kind === 'json') {
    if (!payload.data || typeof payload.data !== 'object') throw new Error('AI 接口返回的不是合法 JSON');
    return extractTextFromJson(payload.data, apiMode);
  }
  if (payload.kind !== 'text') throw new Error('AI 接口响应无法读取');
  if (isSsePayload(payload.text, responseHeader(res, 'content-type'))) {
    return apiMode === 'responses' ? parseResponsesSse(payload.text) : parseChatSse(payload.text);
  }
  let data = null;
  try { data = JSON.parse(payload.text); } catch { data = null; }
  if (!data || typeof data !== 'object') throw new Error('AI 接口返回的不是合法 JSON');
  return extractTextFromJson(data, apiMode);
}

/**
 * Responses 上游 HTTP 400 时的单次重试体（AC5.3）：
 * 要求必须 stream: true 就补上，拒绝 store 就剥离；两者都不命中则返回 null（不重试）。
 */
function responsesRetryBody(body, detail) {
  const text = String(detail == null ? '' : detail);
  if (!text) return null;
  const next = { ...body };
  let changed = false;
  if (!next.stream && /(stream|流式)/i.test(text) && /(true|required|require|must|only|必须|需要)/i.test(text)) {
    next.stream = true;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'store') && /store/i.test(text)
    && /(unsupported|not support|unknown|invalid|unrecognized|not allowed|must|reject|forbid|不支持|不允许|无效|禁止)/i.test(text)) {
    delete next.store;
    changed = true;
  }
  return changed ? next : null;
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
    this._ollamaEffortCache = new Map();
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
    const cfg = { enabled: false, provider: fallback.id, baseUrl: fallback.baseUrl, model: fallback.model, apiMode: DEFAULT_API_MODE, reasoningEffort: '' };
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
      if (API_MODES.includes(parsed.apiMode)) cfg.apiMode = parsed.apiMode;
      cfg.reasoningEffort = normalizeReasoningEffort(parsed.reasoningEffort);
    }
    this.config = cfg;
  }

  _persistConfig() {
    this._setKv(AI_CONFIG_KV, JSON.stringify({
      enabled: !!this.config.enabled,
      provider: this.config.provider,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      apiMode: normalizeApiMode(this.config.apiMode),
      reasoningEffort: normalizeReasoningEffort(this.config.reasoningEffort),
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
   * 保存配置。apiKey 为空/未传/掩码占位时复用库内旧 Key（仅同源，AC3.2）；
   * 仅显式新 Key 覆盖，`{ clearKey: true }` 才清空。返回不含 apiKey 的公开状态。
   */
  saveConfig(cfg = {}) {
    const input = cfg && typeof cfg === 'object' ? cfg : {};
    const prevProvider = this.config.provider;
    const prevOrigin = normalizeOrigin(this.config.baseUrl);
    const next = { ...this.config };
    next.apiMode = normalizeApiMode(next.apiMode);
    next.reasoningEffort = normalizeReasoningEffort(next.reasoningEffort);

    if (Object.prototype.hasOwnProperty.call(input, 'enabled')) next.enabled = !!input.enabled;
    if (input.provider !== undefined) {
      const provider = String(input.provider == null ? '' : input.provider).trim();
      if (provider) next.provider = provider;
    }
    if (input.apiMode !== undefined) next.apiMode = normalizeApiMode(input.apiMode, next.apiMode);
    // 推理档位是开放字符串：原样保存（含大小写与自定义值），空串代表默认不传
    if (Object.prototype.hasOwnProperty.call(input, 'reasoningEffort')) {
      next.reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
    }

    const preset = presetOf(next.provider);
    if (next.provider !== prevProvider && preset) {
      if (input.baseUrl === undefined) next.baseUrl = preset.baseUrl;
      if (input.model === undefined) next.model = preset.model;
    }
    // 预设胶囊（含重复点击当前预设）缺省切回 chat_completions
    if (input.provider !== undefined && preset && input.apiMode === undefined) {
      next.apiMode = apiModeForPreset(next.provider, next.apiMode);
    }
    if (input.baseUrl !== undefined) {
      const baseUrl = String(input.baseUrl == null ? '' : input.baseUrl).trim();
      next.baseUrl = baseUrl || (preset ? preset.baseUrl : next.baseUrl);
      // 用户手输的地址后缀（/responses 或 /chat/completions）优先对齐协议
      if (input.apiMode === undefined) next.apiMode = apiModeFromBaseUrl(next.baseUrl, next.apiMode);
    }
    if (input.model !== undefined) {
      const model = String(input.model == null ? '' : input.model).trim();
      next.model = model || (preset ? preset.model : next.model);
    }
    if (!next.baseUrl) next.baseUrl = (presetOf('deepseek') || {}).baseUrl || '';
    if (!next.model) next.model = (preset || presetOf('deepseek') || {}).model || '';

    this.config = next;
    this._persistConfig();

    // AC3.2 红线：草稿 Key 为空且域名变化时，绝不复用旧域名 Key。
    const originChanged = normalizeOrigin(next.baseUrl) !== prevOrigin;
    if (input.clearKey === true) {
      this._setApiKey('');
    } else if (input.apiKey !== undefined && input.apiKey !== null) {
      const provided = String(input.apiKey);
      if (provided.trim() && !isMaskedKey(provided)) this._setApiKey(provided.trim());
      else if (originChanged) this._setApiKey('');
    } else if (originChanged) {
      this._setApiKey('');
    }
    // 其它情况（同源下空字符串 / 未传 / 掩码）自动复用旧 Key，无需重写。

    this._refreshStatus();
    this._ensureWatermark();
    this._refreshUnorganizedCount();
    return this.getPublicState();
  }

  /**
   * AC3.2：草稿 Key 决定规则。显式新 Key 优先；草稿 Key 为空时，
   * 仅当草稿地址与库内已保存地址同源才复用库内 Key，域名变化一律返回空串。
   */
  _keyForDraft(draftCfg, baseUrl) {
    const input = draftCfg && typeof draftCfg === 'object' ? draftCfg : {};
    const provided = input.apiKey === undefined || input.apiKey === null ? '' : String(input.apiKey);
    if (provided.trim() && !isMaskedKey(provided)) return provided.trim();
    const stored = this.getApiKey();
    if (!stored) return '';
    const draftOrigin = normalizeOrigin(baseUrl);
    return draftOrigin && draftOrigin === normalizeOrigin(this.config.baseUrl) ? stored : '';
  }

  /** SPEC 3.3：仅返回公开字段，绝不包含 apiKey。 */
  getPublicState() {
    const apiKey = this.getApiKey();
    return {
      enabled: !!this.config.enabled,
      provider: this.config.provider,
      baseUrl: this.config.baseUrl,
      apiMode: normalizeApiMode(this.config.apiMode),
      reasoningEffort: normalizeReasoningEffort(this.config.reasoningEffort),
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
   * 调 AI 接口并返回首条文本（AC5：双协议请求体 + 全周期超时 + 双模响应解析）。
   * 默认 30 秒超时；启用推理档位或 Responses 模式放宽至 90 秒。
   * @param {Array<{role:string, content:string}>} messages
   * @param {{ maxTokens?: number, timeoutMs?: number }} [options] 仅在显式传入时才发送 token 上限
   */
  async callChat(messages, options = {}) {
    // 入口浅拷贝配置快照：请求飞行期间 saveConfig 不改变本次请求语义（AC5.1）。
    const cfg = { ...this.config };
    const apiMode = normalizeApiMode(cfg.apiMode);
    const url = buildEndpoint(cfg.baseUrl, apiMode);
    if (!url) throw new Error('AI 接口地址无效');

    const list = Array.isArray(messages)
      ? messages
      : [{ role: 'user', content: String(messages == null ? '' : messages) }];
    const apiKey = this.getApiKey();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const effort = normalizeReasoningEffort(cfg.reasoningEffort);
    const body = apiMode === 'responses'
      ? buildResponsesRequestBody(cfg, list, effort)
      : buildChatRequestBody(cfg, list, effort);
    // 默认不发 max_tokens / max_output_tokens / temperature / top_p，仅显式要求时映射到当前协议字段。
    const requestedMaxTokens = Number(options && options.maxTokens);
    if (options && options.maxTokens !== undefined && Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0) {
      const capped = Math.trunc(requestedMaxTokens);
      if (apiMode === 'responses') body.max_output_tokens = capped;
      else body.max_tokens = capped;
    }

    const requestedTimeout = Number(options && options.timeoutMs);
    const fallbackTimeout = (apiMode === 'responses' || effort) ? REASONING_TIMEOUT_MS : this.timeoutMs;
    const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : fallbackTimeout;
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

    const send = (payload) => Promise.resolve().then(() => picked.fn.call(picked.ctx, url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    }));
    const isHttpFailure = (res) => !!res && (res.ok === false || Number(res.status) >= 400);

    // 全周期：fetch + 读完正文 / SSE 流都在 Promise.race 内，半开流也会按超时失败（AC5.4）。
    const run = async () => {
      let res = await send(body);
      if (!res) throw new Error('AI 接口无响应');
      if (isHttpFailure(res)) {
        const detail = await readErrorDetail(res);
        // AC5.3：Responses 上游 400 要求 stream: true 或拒绝 store 时，仅重试一次。
        if (apiMode === 'responses' && Number(res.status) === 400) {
          const retry = responsesRetryBody(body, detail);
          if (retry) {
            res = await send(retry);
            if (!res) throw new Error('AI 接口无响应');
            if (isHttpFailure(res)) throw httpErrorOf(res, await readErrorDetail(res));
            return await consumeSuccessResponse(res, apiMode);
          }
        }
        throw httpErrorOf(res, detail);
      }
      return await consumeSuccessResponse(res, apiMode);
    };

    try {
      // Promise.race 兜底：即使注入的 fetchImpl 不响应 AbortSignal，也会按超时失败。
      return await Promise.race([run(), timeoutPromise]);
    } catch (e) {
      if (e === timeoutError || controller.signal.aborted) throw timeoutError;
      throw e;
    } finally {
      // 读完正文 / 流之后才清计时器：超时覆盖整个请求周期。
      if (timer) clearTimeout(timer);
    }
  }

  /** 发送最小连通性探针并保存配置；返回 { ok, latencyMs, error? }。 */
  async testConfig(cfg = {}) {
    this.saveConfig(cfg);
    const started = this.now();
    try {
      await this.callChat([{ role: 'user', content: '请只回复 OK' }]);
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

  /**
   * 第 1 级：本地 Ollama `POST /api/show` 读取 thinking.values（AC4.1）。
   * 仅回环地址或 ollama 预设调用；失败 / 超时一律返回 null，绝不阻断模型列表。
   */
  async _ollamaShowEfforts(modelId, baseUrl, options = {}) {
    const origin = normalizeOrigin(baseUrl);
    if (!origin || !modelId) return null;
    const key = `${origin}::${modelId}`;
    const now = Number(this.now()) || 0;
    const cached = this._ollamaEffortCache.get(key);
    if (cached && now - cached.at < OLLAMA_EFFORTS_TTL_MS) return cached.efforts;

    const requested = Number(options && options.timeoutMs);
    const timeout = Number.isFinite(requested) && requested > 0 ? requested : OLLAMA_SHOW_TIMEOUT_MS;
    const url = `${origin}/api/show`;
    const controller = new AbortController();
    let timer = null;
    const timeoutError = new Error('Ollama /api/show 超时');
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, timeout);
    });

    let efforts = null;
    // 全周期：fetch + 读完正文都在 Promise.race 内（与 callChat 一致），正文永不结束也会按超时收敛为 null。
    const probe = async () => {
      const picked = this._fetchFor(url);
      const res = await Promise.resolve().then(() => picked.fn.call(picked.ctx, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
        signal: controller.signal,
      }));
      if (!res || res.ok === false || Number(res.status) >= 400) return null;
      try {
        const data = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        return effortsFromOllamaShow(data);
      } catch {
        return null;
      }
    };
    try {
      efforts = await Promise.race([probe(), timeoutPromise]);
    } catch {
      efforts = null;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (efforts) {
      if (this._ollamaEffortCache.size > 200) this._ollamaEffortCache.clear();
      this._ollamaEffortCache.set(key, { efforts, at: now });
    }
    return efforts;
  }

  /**
   * 单个模型的档位解析：第 1 级网关元数据 → 本机 Ollama / Codex 缓存 → 第 2 级家族规则。
   * 未命中返回 null（未知），与显式 `[]`（无档位）严格区分。
   */
  async _effortsForModel(modelId, item, ctx = {}) {
    const meta = effortsFromModelMeta(item);
    if (meta) return meta;
    const ollamaEfforts = ctx.ollama === true
      ? await this._ollamaShowEfforts(modelId, ctx.baseUrl, ctx.options)
      : null;
    const codexEfforts = ollamaEfforts ? null : readCodexModelEfforts(modelId);
    return resolveEfforts({ modelId, ollamaEfforts, codexEfforts });
  }

  /**
   * 只读解析单个模型的推理档位（IPC 用，AC4.1 / AC4.2）：
   * 返回 { ok, modelId, efforts, error? }；efforts 为 null 表示未知（交给前端开放字符串直通）。
   */
  async resolveModelEfforts(draftCfg = {}, modelId = '', options = {}) {
    const input = draftCfg && typeof draftCfg === 'object' ? draftCfg : {};
    const id = nonEmptyString(modelId) || nonEmptyString(input.model);
    const result = { ok: false, modelId: id, efforts: null, error: '' };
    if (!id) {
      result.error = '模型名称无效';
      return result;
    }
    const provider = nonEmptyString(input.provider) || this.config.provider;
    const baseUrl = nonEmptyString(input.baseUrl) || this.config.baseUrl;
    const item = input.item && typeof input.item === 'object' ? input.item : null;
    result.efforts = await this._effortsForModel(id, item, {
      baseUrl,
      ollama: provider === 'ollama' || isLoopbackUrl(baseUrl),
      options,
    });
    result.ok = true;
    return result;
  }

  /**
   * 只读获取模型列表（AC3.1）：GET /models，绝不调用 saveConfig，不污染后台运行态。
   * 返回 { ok, models: [{ id, endpointTypes, efforts, raw }], apiMode, baseUrl, modelsUrl, count?, error? }。
   * apiMode 由 /models 的 supported_endpoint_types 反推（无端点类型时保持地址后缀推导结果）。
   */
  async fetchAiModels(draftCfg = {}, options = {}) {
    const input = draftCfg && typeof draftCfg === 'object' ? draftCfg : {};
    const provider = nonEmptyString(input.provider) || this.config.provider;
    const preset = presetOf(provider);
    let baseUrl = nonEmptyString(input.baseUrl);
    if (!baseUrl) baseUrl = (provider !== this.config.provider && preset) ? preset.baseUrl : this.config.baseUrl;
    const apiMode = input.apiMode !== undefined
      ? normalizeApiMode(input.apiMode, this.config.apiMode)
      : apiModeFromBaseUrl(baseUrl, this.config.apiMode);
    const modelsUrl = buildModelsUrl(baseUrl);
    const result = { ok: false, models: [], apiMode, baseUrl, modelsUrl, error: '' };
    if (!modelsUrl) {
      result.error = 'AI 接口地址无效';
      return result;
    }

    const apiKey = this._keyForDraft(input, baseUrl);
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const requestedTimeout = Number(options && options.timeoutMs);
    const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : this.timeoutMs;
    const picked = this._fetchFor(modelsUrl);
    const controller = new AbortController();
    let timer = null;
    const timeoutError = new Error(`获取模型列表超时（${Math.round(timeout / 1000)} 秒）`);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, timeout);
    });

    // 全周期：fetch + 读完正文都在 Promise.race 内，正文读取不会无限挂起（与 callChat 一致）。
    const run = async () => {
      const res = await Promise.resolve().then(() => picked.fn.call(picked.ctx, modelsUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      }));
      if (!res) return { error: '模型列表无响应' };
      const status = Number(res.status) || 0;
      if (res.ok === false || status >= 400) {
        let detail = '';
        if (typeof res.text === 'function') {
          try { detail = String(await res.text()); } catch { detail = ''; }
        }
        const label = `HTTP ${status}${res.statusText ? ` ${res.statusText}` : ''}`;
        const snippet = detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 300)}` : '';
        return { error: `${label}${snippet}` };
      }
      try {
        const data = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        return { data };
      } catch {
        return { error: '模型列表返回的不是合法 JSON' };
      }
    };

    let fetched;
    try {
      fetched = await Promise.race([run(), timeoutPromise]);
    } catch (e) {
      result.error = shortError(e === timeoutError || controller.signal.aborted ? timeoutError : e);
      return result;
    } finally {
      // 读完正文之后才清计时器：超时覆盖整个请求周期。
      if (timer) clearTimeout(timer);
    }
    if (fetched.error) {
      result.error = fetched.error;
      return result;
    }
    const data = fetched.data;

    const rawList = Array.isArray(data) ? data
      : (data && Array.isArray(data.data) ? data.data
        : (data && Array.isArray(data.models) ? data.models : []));
    const models = [];
    const typeUnion = [];
    // 本地 Ollama（回环地址或 ollama 预设）才探测 /api/show 读取 thinking.values（AC4.1）
    const ollama = provider === 'ollama' || isLoopbackUrl(baseUrl);
    for (const item of rawList) {
      if (item == null) continue;
      if (typeof item === 'string' || typeof item === 'number') {
        const id = nonEmptyString(item);
        if (id) {
          const efforts = await this._effortsForModel(id, item, { baseUrl, ollama, options });
          models.push({ id, endpointTypes: [], efforts, raw: item });
        }
        continue;
      }
      if (typeof item !== 'object') continue;
      const id = nonEmptyString(item.id || item.name || item.model);
      if (!id) continue;
      const endpointTypes = endpointTypesOf(item);
      typeUnion.push(...endpointTypes);
      const efforts = await this._effortsForModel(id, item, { baseUrl, ollama, options });
      models.push({ id, endpointTypes, efforts, raw: item });
    }

    result.ok = true;
    result.models = models;
    result.count = models.length;
    result.apiMode = apiModeFromEndpointTypes(typeUnion, apiMode);
    return result;
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
      const prompt = buildOrganizePrompt(projects, transcript);
      const text = await this.callChat([
        { role: 'system', content: '你只返回严格 JSON，不返回任何解释或代码围栏。' },
        { role: 'user', content: prompt },
      ]);
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
      const pid = nonEmptyString(pm.projectId) || nonEmptyString(pm.id);
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
    // 兼容模型返回的多种字段名：正文/标题任一为空即视为无效卡
    const firstStr = (...vs) => vs.map(nonEmptyString).find(Boolean) || '';
    let body = firstStr(card.body, card.content, card.description);
    if (!body) {
      // 模型拆成「问题 + 修复」两段时拼成完整正文；只给 solution/fix 一段时直接用它
      const problem = firstStr(card.problem, card.rootCause, card.issue);
      const fix = firstStr(card.fix, card.solution, card.resolution);
      body = problem && fix ? `${problem} → ${fix}` : fix;
    }
    let title = firstStr(card.title, card.name, card.summary).slice(0, 120);
    if (!title && body) title = deriveShortTitle(body).slice(0, 120);
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
      ]);
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
  API_MODES,
  DEFAULT_API_MODE,
  CHAT_ONLY_PRESET_IDS,
  AI_CONFIG_KV,
  AI_KEY_KV,
  AI_ENABLE_WATERMARK_KV,
  AI_WATERMARK_KV: AI_ENABLE_WATERMARK_KV,
  NEW_PROJECT_TARGET,
  AI_PITFALL_GROUP,
  DEFAULT_OLD_BATCH,
  DEFAULT_TIMEOUT_MS,
  REASONING_TIMEOUT_MS,
  HEAD_KEEP,
  TAIL_KEEP,
  DEFAULT_MAX_CHARS,
  normalizeApiMode,
  normalizeReasoningEffort,
  buildOrganizePrompt,
  buildEndpoint,
  buildModelsUrl,
  normalizeOrigin,
  apiModeFromBaseUrl,
  apiModeFromEndpointTypes,
  apiModeForPreset,
  alignApiMode,
  resolveChatCompletionsUrl,
  normalizeModelId,
  familyEfforts,
  effortsFromModelMeta,
  effortsFromOllamaShow,
  readCodexModelEfforts,
  resolveEfforts,
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