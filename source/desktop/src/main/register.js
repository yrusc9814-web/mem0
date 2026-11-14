'use strict';
/**
 * 一键把 mem0 的 MCP 接入本机 Agent（仅在用户点击时执行，不会自动改配置）。
 * 修改前在同目录写一份 .mem0-backup-<时间戳> 备份。
 * url 由主进程传入，已带 ?token=<访问密钥>；各客户端 status() 按完整地址比较，
 * 因此旧地址（没有当前 token 或 token 已变）会判为 stale，界面显示「更新配置」。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME = 'mem0';

function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.mem0-backup-${Date.now()}`);
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  try { fs.chmodSync(tmp, fs.statSync(file).mode & 0o777); } catch { /* 新文件 */ }
  fs.renameSync(tmp, file);
}

/** 读 JSON 对象配置；不存在 → {}；不是对象 → 抛错（不覆盖用户文件） */
function readJsonObject(f) {
  if (!fs.existsSync(f)) return {};
  const raw = fs.readFileSync(f, 'utf8');
  if (!raw.trim()) return {};
  const j = JSON.parse(raw);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${path.basename(f)} 格式不是对象`);
  return j;
}
/** 在 mcpServers 里写入/替换 mem0 一项，保留其他服务；内容没变就不写 */
function upsertServer(f, entry) {
  const j = readJsonObject(f);
  const next = { ...j, mcpServers: { ...(j.mcpServers || {}), [NAME]: entry } };
  const text = JSON.stringify(next, null, 2);
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text) return;
  backup(f);
  writeAtomic(f, text);
}
function removeServer(f) {
  if (!fs.existsSync(f)) return;
  const j = readJsonObject(f);
  if (!j.mcpServers?.[NAME]) return;
  backup(f);
  delete j.mcpServers[NAME];
  writeAtomic(f, JSON.stringify(j, null, 2));
}
function serverIn(f) {
  try { return readJsonObject(f).mcpServers?.[NAME] || null; } catch { return null; }
}

const ANTIGRAVITY_DIRS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
/** Antigravity 现行全局配置；旧版写在 ~/.gemini/antigravity/mcp_config.json，存在时一并写 */
const agMain = (home) => path.join(home, '.gemini', 'config', 'mcp_config.json');
const agLegacy = (home) => path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
const agFiles = (home) => [agMain(home), ...(fs.existsSync(agLegacy(home)) ? [agLegacy(home)] : [])];

const clients = {
  'claude-code': {
    label: 'Claude Code',
    file: (home) => path.join(home, '.claude.json'),
    status(home, url) {
      try {
        const j = JSON.parse(fs.readFileSync(this.file(home), 'utf8'));
        const s = j.mcpServers?.[NAME];
        return s ? (s.url === url ? 'connected' : 'stale') : 'not_connected';
      } catch { return fs.existsSync(path.join(home, '.claude')) ? 'not_connected' : 'not_installed'; }
    },
    connect(home, url) {
      const f = this.file(home);
      let j = {};
      if (fs.existsSync(f)) j = JSON.parse(fs.readFileSync(f, 'utf8'));
      backup(f);
      j.mcpServers = { ...(j.mcpServers || {}), [NAME]: { type: 'http', url } };
      writeAtomic(f, JSON.stringify(j, null, 2));
    },
    disconnect(home) {
      const f = this.file(home);
      if (!fs.existsSync(f)) return;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j.mcpServers?.[NAME]) return;
      backup(f);
      delete j.mcpServers[NAME];
      writeAtomic(f, JSON.stringify(j, null, 2));
    },
  },
  codex: {
    label: 'Codex',
    file: (home) => path.join(home, '.codex', 'config.toml'),
    status(home, url) {
      const f = this.file(home);
      if (!fs.existsSync(path.join(home, '.codex'))) return 'not_installed';
      const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      const { found, urls } = readTomlMem0(t);
      if (!found) return 'not_connected';
      return urls.length && urls.every((u) => u === url) ? 'connected' : 'stale';
    },
    connect(home, url) {
      const f = this.file(home);
      let t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      backup(f);
      const eol = detectEol(t);
      t = stripTomlTable(t, `mcp_servers.${NAME}`).replace(/(?:\r?\n)+$/, '');
      if (t) t += eol + eol;
      t += `[mcp_servers.${NAME}]${eol}url = ${tomlString(url)}${eol}`;
      writeAtomic(f, t);
    },
    disconnect(home) {
      const f = this.file(home);
      if (!fs.existsSync(f)) return;
      const t = fs.readFileSync(f, 'utf8');
      const n = stripTomlTable(t, `mcp_servers.${NAME}`);
      if (n !== t) { backup(f); writeAtomic(f, n); }
    },
  },
  workbuddy: {
    label: 'WorkBuddy',
    note: '重启 WorkBuddy 后生效',
    file: (home) => path.join(home, '.workbuddy', 'mcp.json'),
    status(home, url) {
      if (!fs.existsSync(path.join(home, '.workbuddy'))) return 'not_installed';
      try {
        const j = JSON.parse(fs.readFileSync(this.file(home), 'utf8'));
        const s = j.mcpServers?.[NAME];
        return s ? (s.url === url ? 'connected' : 'stale') : 'not_connected';
      } catch { return 'not_connected'; }
    },
    connect(home, url) {
      const f = this.file(home);
      let j = {};
      if (fs.existsSync(f)) j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('mcp.json 格式不是对象');
      const next = { ...j, mcpServers: { ...(j.mcpServers || {}), [NAME]: { type: 'http', url } } };
      const text = JSON.stringify(next, null, 2);
      if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text) return;
      backup(f);
      writeAtomic(f, text);
    },
    disconnect(home) {
      const f = this.file(home);
      if (!fs.existsSync(f)) return;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j.mcpServers?.[NAME]) return;
      backup(f);
      delete j.mcpServers[NAME];
      writeAtomic(f, JSON.stringify(j, null, 2));
    },
  },
  dimcode: {
    label: 'DimCode',
    note: '重启 DimCode 后生效',
    file: (home) => path.join(home, '.dimcode', 'v2', 'mcp.json'),
    status(home, url) {
      if (!fs.existsSync(path.join(home, '.dimcode'))) return 'not_installed';
      const s = serverIn(this.file(home));
      return s ? (s.url === url && s.enabled !== false ? 'connected' : 'stale') : 'not_connected';
    },
    connect(home, url) { upsertServer(this.file(home), { type: 'http', url, enabled: true }); },
    disconnect(home) { removeServer(this.file(home)); },
  },
  antigravity: {
    label: 'Antigravity',
    note: '重启 Antigravity 后生效',
    file: (home) => agMain(home),
    status(home, url) {
      const installed = ANTIGRAVITY_DIRS.some((d) => fs.existsSync(path.join(home, '.gemini', d))) || fs.existsSync(agMain(home));
      if (!installed) return 'not_installed';
      const found = agFiles(home).map(serverIn);
      if (found.every((s) => !s)) return 'not_connected';
      return found.every((s) => s && (s.serverUrl || s.url) === url) ? 'connected' : 'stale';
    },
    connect(home, url) { for (const f of agFiles(home)) upsertServer(f, { serverUrl: url }); },
    disconnect(home) { for (const f of agFiles(home)) removeServer(f); },
  },
};

/** 按文件首个换行判断风格，默认 LF */
function detectEol(text) {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/** 写 TOML 基本字符串（url 里可能有反斜杠/引号） */
function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 去掉行内注释（引号内的 # 不算） */
function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** 找引号外的指定字符；遇到注释视为没找到 */
function findUnquoted(s, ch, from) {
  let quote = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return -1;
    else if (c === ch) return i;
  }
  return -1;
}

/** 点号键/表名规范化：去引号、去每段两侧空格，如 mcp_servers . "mem0" → mcp_servers.mem0 */
function normalizeKeyPath(raw) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (quote === '"' && c === '\\') { cur += raw[++i] || ''; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '.') { parts.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  parts.push(cur.trim());
  return parts.some((p) => !p) ? '' : parts.join('.');
}

/** 解析 [table] / [[array]] 表头；不是表头行返回 null */
function parseTableHeader(line, start) {
  let i = start + 1;
  const array = line[i] === '[';
  if (array) i++;
  let raw = '';
  let quote = null;
  for (; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      raw += c;
      if (quote === '"' && c === '\\') { raw += line[++i] || ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; raw += c; continue; }
    if (c === ']') {
      if (array && line[i + 1] !== ']') return null;
      const rest = stripTomlComment(line.slice(i + (array ? 2 : 1))).trim();
      if (rest) return null;
      const name = normalizeKeyPath(raw);
      return name || null;
    }
    raw += c;
  }
  return null;
}

/** 解析等号右侧的值：去注释，并记录跨行字符串状态（state.ml） */
function parseTomlValue(raw, state) {
  let out = '';
  for (let i = 0; i < raw.length;) {
    if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) {
      const q = raw.slice(i, i + 3);
      const end = raw.indexOf(q, i + 3);
      if (end < 0) { state.ml = q; return out + raw.slice(i); }
      out += raw.slice(i, end + 3);
      i = end + 3;
      continue;
    }
    const c = raw[i];
    if (c === '#') break;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < raw.length) {
        if (c === '"' && raw[j] === '\\') { j += 2; continue; }
        if (raw[j] === c) { j++; break; }
        j++;
      }
      out += raw.slice(i, Math.min(j, raw.length));
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 读取一行：header / kv / blank / other；多行字符串内的行不当作表头 */
function scanTomlLine(line, state) {
  if (state.ml) {
    const end = line.indexOf(state.ml);
    if (end < 0) return { kind: 'other' };
    state.ml = null;
    return { kind: 'other' };
  }
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i >= line.length || line[i] === '#') return { kind: 'blank' };
  if (line[i] === '[') {
    const name = parseTableHeader(line, i);
    return name ? { kind: 'header', name } : { kind: 'other' };
  }
  const eq = findUnquoted(line, '=', i);
  if (eq < 0) return { kind: 'other' };
  const key = normalizeKeyPath(line.slice(i, eq).trim());
  if (!key) return { kind: 'other' };
  return { kind: 'kv', key, value: parseTomlValue(line.slice(eq + 1), state) };
}

/** 取 TOML 值的字符串内容（用于比较 url） */
function tomlValue(raw) {
  const v = String(raw).trim();
  if (v.startsWith('"""') || v.startsWith("'''")) {
    const q = v.slice(0, 3);
    const end = v.indexOf(q, 3);
    return end < 0 ? v.slice(3) : v.slice(3, end);
  }
  if (v.startsWith('"')) {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      const c = v[i];
      if (c === '"') break;
      if (c !== '\\') { out += c; continue; }
      const n = v[++i];
      if (n === undefined) break;
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === 'u' || n === 'U') {
        const len = n === 'u' ? 4 : 8;
        const hex = v.slice(i + 1, i + 1 + len);
        const code = parseInt(hex, 16);
        if (Number.isFinite(code)) out += String.fromCodePoint(code);
        i += len;
      } else out += n;
    }
    return out;
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end < 0 ? v.slice(1) : v.slice(1, end);
  }
  return v;
}

/** 从内联表 { url = "..." } 里取 url；不是内联表返回 null */
function inlineTableUrl(raw) {
  const v = String(raw).trim();
  if (!v.startsWith('{')) return null;
  const end = v.lastIndexOf('}');
  const body = end > 0 ? v.slice(1, end) : v.slice(1);
  let quote = null;
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  for (const p of parts) {
    const eq = findUnquoted(p, '=', 0);
    if (eq < 0) continue;
    if (normalizeKeyPath(p.slice(0, eq).trim()) === 'url') return tomlValue(p.slice(eq + 1));
  }
  return null;
}

/** 找出 mem0 的写法（标准表、子表、点号键），返回是否存在及 url 列表 */
function readTomlMem0(text) {
  const prefix = `mcp_servers.${NAME}`;
  const state = { ml: null };
  let current = '';
  let found = false;
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    const s = scanTomlLine(line, state);
    if (s.kind === 'header') {
      current = s.name;
      if (current === prefix || current.startsWith(`${prefix}.`)) found = true;
      continue;
    }
    if (s.kind !== 'kv') continue;
    const full = current ? `${current}.${s.key}` : s.key;
    if (full === prefix || full.startsWith(`${prefix}.`)) found = true;
    if (full === `${prefix}.url`) urls.push(tomlValue(s.value));
    else if (full === prefix) {
      const u = inlineTableUrl(s.value);
      if (u !== null) urls.push(u);
    }
  }
  return { found, urls };
}

/** 删除 TOML 中某个表、其子表及点号写法；保留其它段与换行风格 */
function stripTomlTable(text, table) {
  const eol = detectEol(text);
  const state = { ml: null };
  const out = [];
  let current = '';
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const s = scanTomlLine(line, state);
    if (s.kind === 'header') {
      current = s.name;
      skipping = current === table || current.startsWith(`${table}.`);
      if (!skipping) out.push(line);
      continue;
    }
    if (skipping) continue;
    if (s.kind === 'kv') {
      const full = current ? `${current}.${s.key}` : s.key;
      if (full === table || full.startsWith(`${table}.`)) continue;
    }
    out.push(line);
  }
  return out.join(eol);
}

function listClients(url, home = os.homedir()) {
  return Object.entries(clients).map(([id, c]) => ({ id, label: c.label, status: c.status(home, url), file: c.file(home), ...(c.note ? { note: c.note } : {}) }));
}
function connectClient(id, url, home = os.homedir()) {
  const c = clients[id];
  if (!c) throw new Error('unknown client');
  c.connect(home, url);
  return c.status(home, url);
}
function disconnectClient(id, home = os.homedir()) {
  const c = clients[id];
  if (!c) throw new Error('unknown client');
  c.disconnect(home);
}

/** 给其它客户端（Cursor、Cherry Studio 等）手动粘贴的配置 */
function manualConfig(url) {
  return JSON.stringify({ mcpServers: { [NAME]: { type: 'http', url } } }, null, 2);
}

module.exports = { listClients, connectClient, disconnectClient, manualConfig, stripTomlTable };
