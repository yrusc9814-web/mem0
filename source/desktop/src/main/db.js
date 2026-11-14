'use strict';
/**
 * 本地存储：node:sqlite + FTS5(trigram) 全文检索。
 * trigram 分词对中文、英文、代码都能做子串搜索（关键词需 ≥3 个字符；更短的走 LIKE 兜底）。
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const SCHEMA_VERSION = 1;

const LOCAL_SOURCES = ['claude-code', 'codex', 'deepseek-harness', 'antigravity', 'zcode', 'dimcode', 'workbuddy'];
const WEB_SOURCES = ['chatgpt', 'claude', 'gemini', 'deepseek', 'doubao', 'yuanbao', 'kimi', 'qianwen', 'google-ai-mode', 'grok', 'hark'];
const ALL_SOURCES = [...LOCAL_SOURCES, ...WEB_SOURCES.map((s) => `${s}-web`)];

function hash(...parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.ensureMcpTables();
  }

  /**
   * MCP 附加表（独立于 SCHEMA_VERSION 迁移，IF NOT EXISTS 幂等创建，不影响既有表结构）：
   *   mcp_recall_delivered  recall 按 process_id 记录已交付的片段坐标（消息 id + 字符区间），24h TTL
   *   mcp_calls_daily       「今天互通」：按本地时区日期累计 MCP 工具成功调用次数
   */
  ensureMcpTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_recall_delivered (
        process_id   TEXT NOT NULL,
        msg_id       TEXT NOT NULL,
        start        INTEGER NOT NULL,
        end          INTEGER NOT NULL,
        delivered_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_delivered_pid ON mcp_recall_delivered(process_id, msg_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_delivered_at ON mcp_recall_delivered(delivered_at);
      CREATE TABLE IF NOT EXISTS mcp_calls_daily (
        day   TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  static open(dir) {
    return new Store(path.join(dir, 'mem0.db'));
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        title         TEXT,
        url           TEXT,
        workspace     TEXT,
        created_at    INTEGER,
        updated_at    INTEGER,
        message_count INTEGER NOT NULL DEFAULT 0,
        ingest_method TEXT NOT NULL CHECK (ingest_method IN ('local','browser-extension')),
        UNIQUE(source, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conv_source ON conversations(source, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        created_at      INTEGER,
        UNIQUE(conversation_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      -- 本机会话文件的增量游标
      CREATE TABLE IF NOT EXISTS file_cursors (
        path      TEXT PRIMARY KEY,
        source    TEXT NOT NULL,
        size      INTEGER NOT NULL,
        mtime_ms  INTEGER NOT NULL
      );

      -- 来源开关（是否保存）
      CREATE TABLE IF NOT EXISTS source_settings (
        source  TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

      -- 用户删除过的会话。ZCode、DimCode 等把所有会话存在一个文件里，文件一变就会整体重读，
      -- 没有这张表的话，删掉的会话会被当成新会话再导入回来。
      -- 只有原会话的消息数超过删除时的数量（有了新消息）才重新备份。
      CREATE TABLE IF NOT EXISTS deleted_conversations (
        id          TEXT PRIMARY KEY,
        msg_count   INTEGER NOT NULL,
        deleted_at  INTEGER NOT NULL
      );
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- 设置 ----------
  isSourceEnabled(source) {
    const row = this.db.prepare('SELECT enabled FROM source_settings WHERE source = ?').get(source);
    return row ? !!row.enabled : true;
  }
  setSourceEnabled(source, enabled) {
    this.db.prepare('INSERT INTO source_settings(source, enabled) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled')
      .run(source, enabled ? 1 : 0);
  }
  getKv(k) {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return row ? row.v : null;
  }
  setKv(k, v) {
    this.db.prepare('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ---------- 文件游标 ----------
  getCursor(p) {
    return this.db.prepare('SELECT size, mtime_ms FROM file_cursors WHERE path = ?').get(p) || null;
  }
  setCursor(p, source, size, mtimeMs) {
    this.db.prepare(`INSERT INTO file_cursors(path, source, size, mtime_ms) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms`).run(p, source, size, Math.floor(mtimeMs));
  }

  /**
   * 写入/更新一个完整会话（幂等）。messages 为该会话目前的全部消息，按顺序。
   * 已存在的消息内容不变则跳过；末尾新增追加；内容变化则更新（网页端流式回答会变化）。
   * 返回 { changed, added }
   */
  upsertConversation(conv) {
    const { source, externalId, ingestMethod } = conv;
    if (!ALL_SOURCES.includes(source)) throw new Error(`unknown source: ${source}`);
    if (!externalId) throw new Error('externalId required');
    const id = hash(source, externalId);
    let messages = (conv.messages || []).filter((m) => m && typeof m.content === 'string' && m.content.trim());
    return this.tx(() => {
      const existing = this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
      if (!existing) {
        const tomb = this.db.prepare('SELECT msg_count FROM deleted_conversations WHERE id = ?').get(id);
        if (tomb) {
          if (messages.length <= tomb.msg_count) return { id, changed: false, added: 0, skipped: 'deleted' };
          this.db.prepare('DELETE FROM deleted_conversations WHERE id = ?').run(id);
        }
      }
      // 网页长对话常常只渲染最近一部分消息（往上滚才加载更早的）。
      // 这时上报的列表不是从第 0 条开始的，要先和已存的对齐，避免覆盖掉前面的内容。
      if (existing && conv.align && messages.length) {
        const same = (a, b) => a && b && a.role === b.role && a.content === b.content;
        // 流式对齐：只记「候选起点 -> 已连续匹配条数」，不把旧正文整段读进内存。
        // 选与快照连续重合最长的位置对齐（内容可能重复，如多次“继续”，不能只取第一个相同的）
        const runs = new Map();
        let k = -1; let best = 0; let storedLen = 0;
        const rows = this.db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq').iterate(id);
        for (const row of rows) {
          const i = storedLen++;
          for (const [start, n] of runs) {
            const next = i - start;
            if (next < messages.length && same(row, messages[next])) {
              const len = n + 1;
              runs.set(start, len);
              if (len > best) { best = len; k = start; }
            } else {
              runs.delete(start);
            }
          }
          if (same(row, messages[0])) {
            runs.set(i, 1);
            if (best < 1) { best = 1; k = i; }
          }
        }
        const prefixRows = (limit) => this.db.prepare(`SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY seq${limit ? ' LIMIT ?' : ''}`)
          .all(...(limit ? [id, limit] : [id]))
          .map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at ?? undefined }));
        if (storedLen && k !== 0) {
          if (k > 0) {
            messages = prefixRows(k).concat(messages);
          } else {
            // 完全没有重叠（快照首条在已存消息里找不到）：快照整体是已存内容之后的新消息，按位置全部追加。
            // 不能按文本去重：两轮都回“好的”这类同文的新消息也是独立的消息。
            messages = prefixRows(0).concat(messages);
          }
          conv = { ...conv, authoritative: false };
        }
      }
      const times = messages.map((m) => m.createdAt).filter(Number.isFinite);
      const createdAt = conv.createdAt ?? (times.length ? Math.min(...times) : Date.now());
      const updatedAt = conv.updatedAt ?? (times.length ? Math.max(...times) : Date.now());
      const title = (conv.title || deriveTitle(messages) || '').slice(0, 300);
      if (!existing) {
        this.db.prepare(`INSERT INTO conversations(id, source, external_id, title, url, workspace, created_at, updated_at, message_count, ingest_method)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(id, source, externalId, title, conv.url || null, conv.workspace || null, createdAt, updatedAt, ingestMethod);
      }
      // 旧正文逐行比较，比较完即丢，不把整段历史读进内存；行数在迭代中顺带统计
      let changed = !existing;
      let added = 0;
      let oldCount = 0;
      const ins = this.db.prepare('INSERT INTO messages(id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      const upd = this.db.prepare('UPDATE messages SET role = ?, content = ?, created_at = ? WHERE conversation_id = ? AND seq = ?');
      const oldIter = this.db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq').iterate(id);
      for (const prev of oldIter) {
        const m = messages[oldCount];
        if (m && (prev.content !== m.content || prev.role !== m.role)) {
          upd.run(m.role, m.content, m.createdAt ?? null, id, oldCount);
          changed = true;
        }
        oldCount++;
      }
      for (let seq = oldCount; seq < messages.length; seq++) {
        const m = messages[seq];
        // 网页消息不带时间戳：按备份时刻记，首页「今日新增」才能统计到
        ins.run(hash(id, String(seq)), id, seq, m.role, m.content, m.createdAt ?? (ingestMethod === 'browser-extension' ? Date.now() : null));
        added++;
        changed = true;
      }
      // 网页端会话被截断/编辑重发时，删掉多余尾部
      if (conv.authoritative && oldCount > messages.length) {
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND seq >= ?').run(id, messages.length);
        changed = true;
      }
      if (changed) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id).n;
        this.db.prepare(`UPDATE conversations SET title = COALESCE(NULLIF(?, ''), title), url = COALESCE(?, url),
          workspace = COALESCE(?, workspace), updated_at = MAX(COALESCE(updated_at,0), ?), message_count = ? WHERE id = ?`)
          .run(title, conv.url || null, conv.workspace || null, updatedAt, count, id);
      }
      return { id, changed, added };
    });
  }

  // ---------- 查询 ----------
  listConversations({ sources, limit = 50, offset = 0, since, until } = {}) {
    const where = [];
    const args = [];
    if (sources && sources.length) {
      where.push(`source IN (${sources.map(() => '?').join(',')})`);
      args.push(...sources);
    }
    if (since) { where.push('updated_at >= ?'); args.push(since); }
    if (until) { where.push('updated_at <= ?'); args.push(until); }
    const sql = `SELECT id, source, title, url, workspace, created_at, updated_at, message_count, ingest_method
      FROM conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...args, Math.min(limit, 500), offset);
  }

  getConversation(id, { fromSeq = 0, limit = 200 } = {}) {
    const conv = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conv) return null;
    conv.messages = this.db.prepare('SELECT seq, role, content, created_at FROM messages WHERE conversation_id = ? AND seq >= ? ORDER BY seq LIMIT ?')
      .all(id, fromSeq, Math.min(limit, 2000));
    return conv;
  }

  /** 全文搜索，返回命中的消息片段（按会话聚合） */
  search(query, { sources, limit = 20, since, until } = {}) {
    const q = String(query || '').replace(/\u0000/g, ' ').trim();
    if (!q) return [];
    if (!(limit > 0)) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const filters = [];
    const fargs = [];
    if (sources && sources.length) { filters.push(`c.source IN (${sources.map(() => '?').join(',')})`); fargs.push(...sources); }
    if (since) { filters.push('c.updated_at >= ?'); fargs.push(since); }
    if (until) { filters.push('c.updated_at <= ?'); fargs.push(until); }
    const extra = filters.length ? ' AND ' + filters.join(' AND ') : '';
    let stmt; let params;
    if (terms.every((t) => [...t].length >= 3)) {
      const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
      stmt = this.db.prepare(`SELECT m.conversation_id, m.seq, m.role, m.content, m.created_at, c.source, c.title, c.url, c.updated_at,
          bm25(messages_fts) AS score
        FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ?${extra}
        ORDER BY score LIMIT ?`);
      params = [match, ...fargs, limit * 5];
    } else {
      const likes = terms.map(() => 'm.content LIKE ? ESCAPE \'\\\'').join(' AND ');
      const largs = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      stmt = this.db.prepare(`SELECT m.conversation_id, m.seq, m.role, m.content, m.created_at, c.source, c.title, c.url, c.updated_at, 0 AS score
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE ${likes}${extra} ORDER BY c.updated_at DESC LIMIT ?`);
      params = [...largs, ...fargs, limit * 5];
    }
    // 逐行生成摘要（不把 limit×5 条正文整份读进数组）；已满且每会话 3 条时提前结束
    const byConv = new Map();
    for (const r of stmt.iterate(...params)) {
      let g = byConv.get(r.conversation_id);
      if (!g) {
        if (byConv.size >= limit) continue;
        g = { conversationId: r.conversation_id, source: r.source, title: r.title, url: r.url, updatedAt: r.updated_at, hits: [] };
        byConv.set(r.conversation_id, g);
      }
      if (g.hits.length < 3) g.hits.push({ seq: r.seq, role: r.role, createdAt: r.created_at, snippet: snippet(r.content, terms) });
      if (byConv.size >= limit) {
        let full = true;
        for (const x of byConv.values()) if (x.hits.length < 3) { full = false; break; }
        if (full) break;
      }
    }
    return [...byConv.values()];
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
    const messages = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const today = this.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE updated_at >= ?').get(startOfDay.getTime()).n;
    const bySource = Object.fromEntries(this.db.prepare('SELECT source, COUNT(*) AS n FROM conversations GROUP BY source').all().map((r) => [r.source, r.n]));
    const messagesBySource = Object.fromEntries(this.db.prepare('SELECT c.source, COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id GROUP BY c.source').all().map((r) => [r.source, r.n]));
    // 今日：按来源统计今天有更新的会话数，以及今天产生的消息数（无时间戳的消息不计）
    const todayBySource = {};
    for (const r of this.db.prepare('SELECT source, COUNT(*) AS n FROM conversations WHERE updated_at >= ? GROUP BY source').all(startOfDay.getTime())) todayBySource[r.source] = { conversations: r.n, messages: 0 };
    for (const r of this.db.prepare('SELECT c.source, COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.created_at >= ? GROUP BY c.source').all(startOfDay.getTime())) {
      (todayBySource[r.source] ||= { conversations: 0, messages: 0 }).messages = r.n;
    }
    const todayMessages = Object.values(todayBySource).reduce((a, x) => a + x.messages, 0);
    return { total, messages, today, todayMessages, bySource, messagesBySource, todayBySource };
  }

  deleteConversation(id) {
    this.tx(() => {
      const row = this.db.prepare('SELECT (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) AS n, EXISTS(SELECT 1 FROM conversations WHERE id = ?) AS e').get(id, id);
      if (!row.e) return;
      this.db.prepare('INSERT OR REPLACE INTO deleted_conversations (id, msg_count, deleted_at) VALUES (?, ?, ?)').run(id, row.n, Date.now());
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    });
  }

  // ---------- MCP：今日互通计数 ----------
  /** 今日（本地时区）MCP 工具成功调用次数 +1，返回新计数 */
  bumpMcpCall(now = Date.now()) {
    const day = localDay(now);
    return this.db.prepare(`INSERT INTO mcp_calls_daily(day, count) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET count = count + 1 RETURNING count`).get(day).count;
  }
  getMcpCallsToday(now = Date.now()) {
    const row = this.db.prepare('SELECT count FROM mcp_calls_daily WHERE day = ?').get(localDay(now));
    return row ? row.count : 0;
  }

  // ---------- MCP：recall 去重 ----------
  pruneDelivered(ttlMs = 24 * 3600_000, now = Date.now()) {
    this.db.prepare('DELETE FROM mcp_recall_delivered WHERE delivered_at < ?').run(now - ttlMs);
  }
  /** 返回 Map<msg_id, [[start, end], ...]> */
  getDelivered(processId) {
    const map = new Map();
    for (const r of this.db.prepare('SELECT msg_id, start, end FROM mcp_recall_delivered WHERE process_id = ?').all(processId)) {
      if (!map.has(r.msg_id)) map.set(r.msg_id, []);
      map.get(r.msg_id).push([r.start, r.end]);
    }
    return map;
  }
  addDelivered(processId, ranges, now = Date.now()) {
    if (!ranges.length) return;
    const ins = this.db.prepare('INSERT INTO mcp_recall_delivered(process_id, msg_id, start, end, delivered_at) VALUES (?, ?, ?, ?, ?)');
    this.tx(() => { for (const r of ranges) ins.run(processId, r.msgId, r.start, r.end, now); });
  }

  // ---------- MCP：检索原料（纯本地，无任何改写） ----------
  _recallFilters({ sources, since, until } = {}) {
    const f = []; const a = [];
    if (sources && sources.length) { f.push(`c.source IN (${sources.map(() => '?').join(',')})`); a.push(...sources); }
    if (since != null) { f.push('COALESCE(m.created_at, c.updated_at) >= ?'); a.push(since); }
    if (until != null) { f.push('COALESCE(m.created_at, c.updated_at) <= ?'); a.push(until); }
    return { sql: f.length ? ' AND ' + f.join(' AND ') : '', args: a };
  }

  /**
   * 单个检索词命中的消息：≥3 字符走 FTS5 trigram 短语匹配，更短的走 LIKE 子串兜底。
   * 返回消息行（含会话元数据），按相关度/时间截取 limit 条。
   */
  recallTermHits(term, { sources, since, until, limit = 300 } = {}) {
    const t = String(term || '').replace(/\u0000/g, ' ').trim();
    if (!t) return [];
    const { sql, args } = this._recallFilters({ sources, since, until });
    const cols = `m.id, m.conversation_id, m.seq, m.role, m.content, m.created_at,
      c.source, c.title, c.workspace, c.updated_at, c.message_count, c.ingest_method`;
    if ([...t].length >= 3) {
      return this.db.prepare(`SELECT ${cols} FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ?${sql} ORDER BY bm25(messages_fts) LIMIT ?`).all(`"${t.replace(/"/g, '""')}"`, ...args, limit);
    }
    return this.db.prepare(`SELECT ${cols} FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.content LIKE ? ESCAPE '\\'${sql} ORDER BY COALESCE(m.created_at, c.updated_at) DESC LIMIT ?`)
      .all(`%${t.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`, ...args, limit);
  }

  /** 标题命中某词的会话（标题不在 FTS 里，用 LIKE） */
  recallTitleHits(term, { sources, since, until, limit = 50 } = {}) {
    const t = String(term || '').trim();
    if (!t) return [];
    const f = ["c.title LIKE ? ESCAPE '\\'"]; const a = [`%${t.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`];
    if (sources && sources.length) { f.push(`c.source IN (${sources.map(() => '?').join(',')})`); a.push(...sources); }
    if (since != null) { f.push('c.updated_at >= ?'); a.push(since); }
    if (until != null) { f.push('COALESCE(c.created_at, c.updated_at) <= ?'); a.push(until); }
    return this.db.prepare(`SELECT c.id, c.source, c.title, c.workspace, c.updated_at, c.message_count, c.ingest_method
      FROM conversations c WHERE ${f.join(' AND ')} ORDER BY c.updated_at DESC LIMIT ?`).all(...a, limit);
  }

  /** 会话内按 seq 取若干条消息 */
  getMessagesBySeq(conversationId, seqs) {
    if (!seqs.length) return [];
    return this.db.prepare(`SELECT id, conversation_id, seq, role, content, created_at FROM messages
      WHERE conversation_id = ? AND seq IN (${seqs.map(() => '?').join(',')}) ORDER BY seq`).all(conversationId, ...seqs);
  }
  firstMessage(conversationId) {
    return this.db.prepare(`SELECT id, conversation_id, seq, role, content, created_at FROM messages
      WHERE conversation_id = ? ORDER BY (role = 'user') DESC, seq LIMIT 1`).get(conversationId) || null;
  }

  /**
   * 时间范围内有活动的会话及其消息时间（不含正文），供 list_conversations 按本地日期整理。
   * 按（会话, 时间戳）在 SQL 里聚合计数，再逐行迭代归到每个会话；本地日期分组仍由 mcp.js 完成。
   * 有时间戳的消息按消息时间；完全没有时间戳的会话按会话更新时间。
   * 返回 { activity: Map<cid, [{ at, n, untimed? }]>, meta }
   */
  conversationActivity({ since, until, sources } = {}) {
    const sf = sources && sources.length ? ` AND c.source IN (${sources.map(() => '?').join(',')})` : '';
    const sa = sources && sources.length ? sources : [];
    const activity = new Map();
    const rows = this.db.prepare(`SELECT m.conversation_id AS cid, m.created_at AS at, COUNT(*) AS n FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.created_at >= ? AND m.created_at <= ?${sf}
      GROUP BY m.conversation_id, m.created_at ORDER BY m.conversation_id`).iterate(since, until, ...sa);
    for (const r of rows) {
      let list = activity.get(r.cid);
      if (!list) { list = []; activity.set(r.cid, list); }
      list.push({ at: r.at, n: r.n });
    }
    const untimed = this.db.prepare(`SELECT c.id AS cid, c.updated_at AS at FROM conversations c
      WHERE c.updated_at >= ? AND c.updated_at <= ?${sf}
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.created_at IS NOT NULL)`).iterate(since, until, ...sa);
    for (const r of untimed) activity.set(r.cid, [{ at: r.at, n: 0, untimed: true }]);
    const ids = [...activity.keys()];
    const meta = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const c of this.db.prepare(`SELECT id, source, title, workspace, message_count, updated_at, ingest_method
        FROM conversations WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) meta.set(c.id, c);
    }
    return { activity, meta };
  }

  close() { this.db.close(); }
}

/** 本地时区日期 YYYY-MM-DD */
function localDay(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function deriveTitle(messages) {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '';
  return first.content.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function snippet(text, terms, radius = 80) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { at = lower.indexOf(t.toLowerCase()); if (at >= 0) break; }
  if (at < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

module.exports = { Store, LOCAL_SOURCES, WEB_SOURCES, ALL_SOURCES, hash, localDay };
