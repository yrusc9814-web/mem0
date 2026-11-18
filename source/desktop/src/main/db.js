'use strict';
/**
 * 本地存储：node:sqlite + FTS5(trigram) 全文检索。
 * trigram 分词对中文、英文、代码都能做子串搜索（关键词需 ≥3 个字符；更短的走 LIKE 兜底）。
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const SCHEMA_VERSION = 2;
/** 跨设备记忆包格式版本（SPEC 2.2 第 4 点） */
const MEMORY_PACK_VERSION = 'mem0-memory-pack-v1';

/** 4 个固定常驻抽屉分组（顺序与界面一致；后台自动整理只允许写「踩坑与经验库」） */
const MEMORY_GROUPS = [
  '个人与职业背景',
  '协作与沟通准则',
  '环境与工作流',
  '踩坑与经验库',
];

/** 跨分组列表按 MEMORY_GROUPS 固定顺序排列 */
const MEMORY_GROUP_ORDER = `CASE group_name ${MEMORY_GROUPS.map((g, i) => `WHEN '${g.replace(/'/g, "''")}' THEN ${i}`).join(' ')} ELSE ${MEMORY_GROUPS.length} END`;
const MEMORY_COLS = 'id, group_name, title, body, tags_json, source_ids_json, origin_label, superseded, sort_order, created_at, updated_at';
const PROJECT_COLS = 'id, name, state, archived, workspace, progress, decisions_json, rejected_json, next_step, created_at, updated_at';

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
    // 已升到 v2 的旧库补列（幂等）：手动改摘要/决策/下一步后的静默锁
    this.ensureColumn('conversations', 'summary_locked', 'INTEGER NOT NULL DEFAULT 0');
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
    // v1：基础建表（空库与 v1 存量库都不会重复执行，语句本身也全部 IF NOT EXISTS）
    if (v < 1) this.db.exec(`
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
    // v2：conversations 补 10 列 + 推进事项 / 记忆卡表；逐列检查，任何状态重入都幂等
    if (v < 2) {
      const convColumns = [
        ['project_id', 'TEXT DEFAULT NULL'],
        ['summary', "TEXT NOT NULL DEFAULT ''"],
        ['decisions_json', "TEXT NOT NULL DEFAULT '[]'"],
        ['next_step', "TEXT NOT NULL DEFAULT ''"],
        ['original_title', 'TEXT DEFAULT NULL'],
        ['title_locked', 'INTEGER NOT NULL DEFAULT 0'],
        ['project_locked', 'INTEGER NOT NULL DEFAULT 0'],
        ['stripped_blocks', 'INTEGER NOT NULL DEFAULT 0'],
        ['ai_organized_at', 'INTEGER DEFAULT NULL'],
        ['ai_msg_watermark', 'INTEGER NOT NULL DEFAULT 0'],
        ['summary_locked', 'INTEGER NOT NULL DEFAULT 0'],
      ];
      for (const [col, ddl] of convColumns) this.ensureColumn('conversations', col, ddl);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS projects (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          state          TEXT NOT NULL DEFAULT '推进中',
          archived       INTEGER NOT NULL DEFAULT 0,
          workspace      TEXT DEFAULT NULL,
          progress       TEXT NOT NULL DEFAULT '',
          decisions_json TEXT NOT NULL DEFAULT '[]',
          rejected_json  TEXT NOT NULL DEFAULT '[]',
          next_step      TEXT NOT NULL DEFAULT '',
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_proj_updated ON projects(archived, updated_at DESC);

        CREATE TABLE IF NOT EXISTS memories (
          id              TEXT PRIMARY KEY,
          group_name      TEXT NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          tags_json       TEXT NOT NULL DEFAULT '[]',
          source_ids_json TEXT NOT NULL DEFAULT '[]',
          origin_label    TEXT NOT NULL DEFAULT '手动录入',
          superseded      TEXT NOT NULL DEFAULT '',
          sort_order      INTEGER NOT NULL DEFAULT 0,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mem_group ON memories(group_name, sort_order ASC, created_at ASC);

        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          title, body, tags_json, content='memories', content_rowid='rowid', tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, body, tags_json) VALUES (new.rowid, new.title, new.body, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, body, tags_json) VALUES ('delete', old.rowid, old.title, old.body, old.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, body, tags_json) VALUES ('delete', old.rowid, old.title, old.body, old.tags_json);
          INSERT INTO memories_fts(rowid, title, body, tags_json) VALUES (new.rowid, new.title, new.body, new.tags_json);
        END;
      `);
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** PRAGMA table_info 检查后仅补缺失列（migrate 可重入） */
  ensureColumn(table, col, ddl) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
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

  /**
   * 0.5.5 F2：一次性清掉 Claude Code 的文件游标，让已入库的旧会话按新解析规则重读。
   * 用 kv 标记保证只执行一次；返回本次是否执行。
   */
  migrateClaudeCleanV1() {
    if (this.getKv('claude_clean_v1')) return false;
    return this.tx(() => {
      this.db.prepare("DELETE FROM file_cursors WHERE source = 'claude-code'").run();
      this.setKv('claude_clean_v1', '1');
      return true;
    });
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
      const existing = this.db.prepare('SELECT id, title, title_locked, project_id, project_locked, stripped_blocks, original_title FROM conversations WHERE id = ?').get(id);
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
      let title = (conv.title || deriveTitle(messages) || '').slice(0, 300);
      // 手动改过标题：保留库内标题，忽略采集器重新推算的标题
      if (existing && existing.title_locked === 1) title = existing.title || '';
      // 原始首句：首次插入时记录（显式传入优先，否则 deriveTitle / title），之后不再改动
      const incomingOriginal = conv.originalTitle === undefined || conv.originalTitle === null
        ? ''
        : String(conv.originalTitle).slice(0, 300);
      const originalTitle = existing
        ? (existing.original_title == null ? null : existing.original_title)
        : (incomingOriginal || String(deriveTitle(messages) || title || '').slice(0, 300)) || null;
      // 采集侧剥离块数量单调不减：重新采集到更少的旧统计不应该把已有值改小
      const strippedBlocks = Math.max(
        existing ? Number(existing.stripped_blocks) || 0 : 0,
        Number(conv.strippedBlocks) || 0,
      );
      let projectId = existing && existing.project_id != null ? existing.project_id : null;
      if (!existing) {
        // 新会话：按工作区自动归属；显式传入的 projectId 仅在未命中时兜底
        const matched = conv.workspace ? this.matchProjectByWorkspace(conv.workspace) : null;
        projectId = matched ? matched.id : (conv.projectId || null);
        this.db.prepare(`INSERT INTO conversations(id, source, external_id, title, url, workspace, created_at, updated_at, message_count, ingest_method,
          original_title, stripped_blocks, project_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(id, source, externalId, title, conv.url || null, conv.workspace || null,
          createdAt, updatedAt, ingestMethod, originalTitle, strippedBlocks, projectId);
      } else if (existing.project_locked === 1) {
        // 已静默锁定：保留库内 project_id，不做工作区自动覆盖
      } else if (conv.projectId !== undefined) {
        // 内部路径显式指定归属
        projectId = conv.projectId || null;
      } else if (!projectId && (conv.workspace || existing.workspace)) {
        // 未静默锁定且尚未关联：工作区命中活跃事项时自动关联
        const matched = this.matchProjectByWorkspace(conv.workspace || existing.workspace);
        if (matched) projectId = matched.id;
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
      // 网页端会话被截断/编辑重发时删掉多余尾部；
      // Claude Code 每次读到的是完整快照，0.5.5 起解析规则会过滤掉工具内容，变短时同步删掉旧行。
      // 其它本地来源（工具可能自行清理旧记录）和网页 align 路径保持原行为，不做截断。
      if (oldCount > messages.length && (conv.authoritative || (source === 'claude-code' && !conv.align))) {
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND seq >= ?').run(id, messages.length);
        changed = true;
      }
      const projectChanged = (!existing ? !!projectId : (existing.project_id == null ? null : existing.project_id) !== projectId);
      // 剥离块统计变大（同一会话重新采集到更多降噪块）也算需要落库的变更，但不影响 changed 语义
      const strippedGrew = strippedBlocks > (existing ? Number(existing.stripped_blocks) || 0 : 0);
      if (changed || projectChanged || strippedGrew) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id).n;
        // title_locked=1 时 title 已在上面换成库内值，这里写回不会产生改动
        this.db.prepare(`UPDATE conversations SET title = COALESCE(NULLIF(?, ''), title), url = COALESCE(?, url),
          workspace = COALESCE(?, workspace), updated_at = MAX(COALESCE(updated_at,0), ?), message_count = ?,
          project_id = ?, original_title = COALESCE(original_title, ?), stripped_blocks = MAX(COALESCE(stripped_blocks, 0), ?) WHERE id = ?`)
          .run(title, conv.url || null, conv.workspace || null, updatedAt, count, projectId, originalTitle, strippedBlocks, id);
      }
      return { id, changed, added };
    });
  }

  // ---------- 查询 ----------
  /**
   * 会话列表：支持来源 / 事项 / 时间过滤，返回记录页与详情页需要的全部字段。
   * first_prompt 为首条提问的简短预览（空白折叠后截断），供无 summary 时展示副标题。
   */
  listConversations({ sources, projectId, limit = 300, offset = 0, since, until } = {}) {
    const where = [];
    const args = [];
    if (sources && sources.length) {
      where.push(`c.source IN (${sources.map(() => '?').join(',')})`);
      args.push(...sources);
    }
    if (projectId !== undefined && projectId !== null) {
      where.push('c.project_id = ?'); args.push(projectId);
    }
    if (since) { where.push('c.updated_at >= ?'); args.push(since); }
    if (until) { where.push('c.updated_at <= ?'); args.push(until); }
    const sql = `SELECT c.id, c.source, c.title, c.original_title, c.url, c.workspace, c.created_at, c.updated_at,
        c.message_count, c.ingest_method, c.project_id, c.summary, c.decisions_json, c.next_step, c.stripped_blocks,
        (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
          ORDER BY (m.role = 'user') DESC, m.seq LIMIT 1) AS first_prompt
      FROM conversations c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...args, Math.min(limit, 500), offset).map((r) => ({
      ...r,
      first_prompt: String(r.first_prompt || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    }));
  }

  /**
   * 手动编辑会话元数据（前端胶囊切换 / 编辑框保存）：
   *   title      → 更新标题并静默置 title_locked = 1
   *   projectId  → 更新归属（含 null 取消关联）并静默置 project_locked = 1，同步刷新事项 updated_at
   *   summary / decisions / nextStep 同步写入
   * 返回最新会话行，会话不存在时返回 null。
   */
  updateConversationMeta(id, patch = {}) {
    const p = patch && typeof patch === 'object' ? patch : {};
    return this.tx(() => {
      const existing = this.db.prepare('SELECT id, title, project_id FROM conversations WHERE id = ?').get(id);
      if (!existing) return null;
      const sets = [];
      const args = [];
      if (p.title !== undefined) {
        const nextTitle = String(p.title == null ? '' : p.title).slice(0, 300);
        if (nextTitle && nextTitle !== existing.title) {
          // 首次手动改标题：把采集阶段的旧标题存进 original_title（已有则保留最早的首句）
          sets.push('original_title = COALESCE(NULLIF(original_title, \'\'), ?)');
          args.push(String(existing.title || '').slice(0, 300));
          sets.push('title = ?');
          args.push(nextTitle);
          sets.push('title_locked = 1');
        }
      }
      if (p.projectId !== undefined) {
        const nextProject = p.projectId || null;
        sets.push('project_id = ?');
        args.push(nextProject);
        sets.push('project_locked = 1');
        if (nextProject) this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), nextProject);
      }
      if (p.summary !== undefined) { sets.push('summary = ?'); args.push(String(p.summary == null ? '' : p.summary)); }
      if (p.decisions !== undefined) { sets.push('decisions_json = ?'); args.push(JSON.stringify(normalizeList(p.decisions))); }
      if (p.nextStep !== undefined) { sets.push('next_step = ?'); args.push(String(p.nextStep == null ? '' : p.nextStep)); }
      if (p.summary !== undefined || p.decisions !== undefined || p.nextStep !== undefined) sets.push('summary_locked = 1');
      if (sets.length) this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      const row = this.db.prepare(`SELECT id, source, title, original_title, url, workspace, created_at, updated_at, message_count,
        ingest_method, project_id, summary, decisions_json, next_step, stripped_blocks, title_locked, project_locked,
        summary_locked, ai_organized_at, ai_msg_watermark FROM conversations WHERE id = ?`).get(id);
      return row ? { ...row, decisions: parseJsonArray(row.decisions_json) } : null;
    });
  }

  getConversation(id, { fromSeq = 0, limit = 200 } = {}) {
    const conv = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conv) return null;
    conv.messages = this.db.prepare('SELECT seq, role, content, created_at FROM messages WHERE conversation_id = ? AND seq >= ? ORDER BY seq LIMIT ?')
      .all(id, fromSeq, Math.min(limit, 2000));
    return conv;
  }

  // ---------- AI 自动整理（SPEC 3.5 / 3.6） ----------
  /**
   * 旧会话候选：启用水位线之前、尚未自动整理、且至少有 2 条消息。
   * 后台定时器绝不自动处理这些会话，仅在用户主动「整理旧对话」时按批串行处理。
   */
  listAiOldCandidates({ watermark, limit = 20 } = {}) {
    const wm = Number(watermark);
    if (!Number.isFinite(wm)) return [];
    const n = Math.max(1, Math.min(Math.trunc(Number(limit) || 20), 500));
    return this.db.prepare(`SELECT id, source, title, original_title, workspace, created_at, updated_at,
      message_count, project_id, summary, decisions_json, next_step, title_locked, project_locked,
      ai_organized_at, ai_msg_watermark
      FROM conversations
      WHERE updated_at < ? AND ai_organized_at IS NULL AND message_count >= 2
      ORDER BY updated_at ASC, id ASC LIMIT ?`).all(wm, n);
  }

  /** 旧会话未整理条数（只统计，不触发任何请求）。 */
  countAiOldCandidates(watermark) {
    const wm = Number(watermark);
    if (!Number.isFinite(wm)) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM conversations
      WHERE updated_at < ? AND ai_organized_at IS NULL AND message_count >= 2`).get(wm);
    return Number(row && row.n) || 0;
  }

  /**
   * 新活跃会话候选：水位线之后、消息数 >= 2、消息数超过上次整理水位，
   * 且最后活动时间不晚于 idleBefore（即已停更满空闲阈值）。
   */
  listAiIdleCandidates({ watermark, idleBefore, limit = 50 } = {}) {
    const wm = Number(watermark);
    const before = Number(idleBefore);
    if (!Number.isFinite(wm) || !Number.isFinite(before)) return [];
    const n = Math.max(1, Math.min(Math.trunc(Number(limit) || 50), 500));
    return this.db.prepare(`SELECT id, source, title, original_title, workspace, created_at, updated_at,
      message_count, project_id, summary, decisions_json, next_step, title_locked, project_locked,
      ai_organized_at, ai_msg_watermark
      FROM conversations
      WHERE updated_at >= ? AND updated_at <= ? AND message_count >= 2 AND message_count > ai_msg_watermark
      ORDER BY updated_at ASC, id ASC LIMIT ?`).all(wm, before, n);
  }

  /**
   * 写回自动整理结果（单事务）。红线在 SQL 写入前再次校验：
   * - title_locked = 1 时绝不改 title / original_title；
   * - project_locked = 1 时绝不改 project_id；
   * - projectId 必须是真实存在且未归档的事项；
   * - 只更新会话元数据，不触碰 messages 表，也不改 updated_at。
   */
  applyAiOrganization(id, { title, summary, decisions, nextStep, projectId, aiOrganizedAt, aiMsgWatermark } = {}) {
    return this.tx(() => {
      const existing = this.db.prepare(`SELECT id, title, original_title, title_locked, project_id, project_locked, message_count,
        summary, decisions_json, summary_locked FROM conversations WHERE id = ?`).get(id);
      if (!existing) return null;
      const sets = [];
      const args = [];
      if (title !== undefined) {
        const nextTitle = String(title == null ? '' : title).trim().slice(0, 300);
        if (nextTitle && Number(existing.title_locked) === 0 && nextTitle !== existing.title) {
          sets.push("original_title = COALESCE(NULLIF(original_title, ''), ?)");
          args.push(String(existing.title || '').slice(0, 300));
          sets.push('title = ?');
          args.push(nextTitle);
        }
      }
      // summary_locked = 1：用户手动改过摘要/决策/下一步，后台 AI 绝不覆写这三项
      const summaryOpen = Number(existing.summary_locked) === 0;
      if (summaryOpen && summary !== undefined) {
        const nextSummary = String(summary == null ? '' : summary);
        // 模型给空摘要时不清空已有非空摘要
        if (nextSummary.trim() || !String(existing.summary || '').trim()) { sets.push('summary = ?'); args.push(nextSummary); }
      }
      if (summaryOpen && decisions !== undefined) {
        const nextDecisions = normalizeList(decisions);
        // 模型给空结论数组时不清空已有非空结论
        if (nextDecisions.length || !parseJsonArray(existing.decisions_json).length) { sets.push('decisions_json = ?'); args.push(JSON.stringify(nextDecisions)); }
      }
      if (summaryOpen && nextStep !== undefined) { sets.push('next_step = ?'); args.push(String(nextStep == null ? '' : nextStep)); }
      if (projectId !== undefined && Number(existing.project_locked) === 0) {
        const pid = projectId || null;
        if (pid === null) {
          sets.push('project_id = NULL');
        } else {
          const proj = this.db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').get(pid);
          if (proj) { sets.push('project_id = ?'); args.push(proj.id); }
        }
      }
      if (aiOrganizedAt !== undefined) { sets.push('ai_organized_at = ?'); args.push(Number(aiOrganizedAt) || 0); }
      if (aiMsgWatermark !== undefined) { sets.push('ai_msg_watermark = ?'); args.push(Number(aiMsgWatermark) || 0); }
      if (sets.length) this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      const row = this.db.prepare(`SELECT id, source, title, original_title, url, workspace, created_at, updated_at, message_count,
        ingest_method, project_id, summary, decisions_json, next_step, stripped_blocks, title_locked, project_locked,
        summary_locked, ai_organized_at, ai_msg_watermark FROM conversations WHERE id = ?`).get(id);
      return row ? { ...row, decisions: parseJsonArray(row.decisions_json) } : null;
    });
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
    // 正文未命中，但标题 / 摘要 / 拍板结论 / 下一步 / 所属事项名命中全部关键词时也纳入结果（hits 为空数组）
    if (byConv.size < limit) {
      for (const r of this._searchMetaHits(terms, { sources, since, until }, limit - byConv.size)) {
        if (!byConv.has(r.id)) byConv.set(r.id, { conversationId: r.id, source: r.source, title: r.title, url: r.url, updatedAt: r.updated_at, hits: [] });
      }
    }
    return [...byConv.values()];
  }

  /** 元数据命中：标题 / 摘要 / 拍板结论 / 下一步 / 所属事项名需同时包含全部关键词 */
  _searchMetaHits(terms, { sources, since, until } = {}, limit = 20) {
    if (!(limit > 0) || !terms.length) return [];
    const likes = terms.map(() => `(c.title LIKE ? ESCAPE '\\' OR c.summary LIKE ? ESCAPE '\\'
      OR c.decisions_json LIKE ? ESCAPE '\\' OR c.next_step LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')`).join(' AND ');
    const args = [];
    for (const t of terms) {
      const like = `%${t.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`;
      args.push(like, like, like, like, like);
    }
    const filters = [];
    if (sources && sources.length) { filters.push(`c.source IN (${sources.map(() => '?').join(',')})`); args.push(...sources); }
    if (since) { filters.push('c.updated_at >= ?'); args.push(since); }
    if (until) { filters.push('c.updated_at <= ?'); args.push(until); }
    return this.db.prepare(`SELECT c.id, c.source, c.title, c.url, c.updated_at
      FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
      WHERE ${likes}${filters.length ? ' AND ' + filters.join(' AND ') : ''}
      ORDER BY c.updated_at DESC LIMIT ?`).all(...args, limit);
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
    // 本机确定性降噪累计：全部会话已剥离块数，以及近 7 天有更新的会话剥离块数
    const strippedBlocksTotal = this.db.prepare('SELECT COALESCE(SUM(stripped_blocks), 0) AS n FROM conversations').get().n;
    const strippedBlocksWeek = this.db.prepare('SELECT COALESCE(SUM(stripped_blocks), 0) AS n FROM conversations WHERE updated_at >= ?')
      .get(Date.now() - 7 * 86400_000).n;
    return { total, messages, today, todayMessages, bySource, messagesBySource, todayBySource, strippedBlocksTotal, strippedBlocksWeek };
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

  // ---------- 记忆卡（memories）：4 个固定常驻分组 ----------
  /** 按分组（可选）列出卡片；跨分组时按 MEMORY_GROUPS 顺序，组内按 sort_order */
  listMemories({ group } = {}) {
    if (group !== undefined && group !== null) {
      return this.db.prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE group_name = ? ORDER BY sort_order ASC, created_at ASC`)
        .all(group).map(memoryRow);
    }
    return this.db.prepare(`SELECT ${MEMORY_COLS} FROM memories ORDER BY ${MEMORY_GROUP_ORDER}, sort_order ASC, created_at ASC`)
      .all().map(memoryRow);
  }

  getMemory(id) {
    return memoryRow(this.db.prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE id = ?`).get(id));
  }

  /**
   * 新建或更新卡片（id 不存在时按给定 id 插入，供删除后的「撤销」原位恢复）。
   * 新卡 sort_order 追加到分组末尾；JSON 列统一以数组入参、数组出参。
   */
  saveMemory({ id, group, title, body = '', tags = [], sourceIds = [], originLabel = '手动录入', superseded = '' } = {}) {
    if (!MEMORY_GROUPS.includes(group)) throw new Error(`unknown memory group: ${group}`);
    const name = String(title == null ? '' : title).trim();
    if (!name) throw new Error('memory title required');
    const tagsJson = JSON.stringify(normalizeList(tags));
    const sourceJson = JSON.stringify(normalizeList(sourceIds));
    const label = String(originLabel || '手动录入');
    const oldBody = String(superseded || '');
    const now = Date.now();
    return this.tx(() => {
      const existing = id ? this.db.prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE id = ?`).get(id) : null;
      if (existing) {
        const moved = existing.group_name !== group;
        const order = moved
          ? this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM memories WHERE group_name = ?').get(group).n
          : existing.sort_order;
        this.db.prepare(`UPDATE memories SET group_name = ?, title = ?, body = ?, tags_json = ?, source_ids_json = ?,
          origin_label = ?, superseded = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
          .run(group, name, String(body == null ? '' : body), tagsJson, sourceJson, label, oldBody, order, now, id);
        return this.getMemory(id);
      }
      const newId = id || crypto.randomUUID();
      const order = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM memories WHERE group_name = ?').get(group).n;
      this.db.prepare(`INSERT INTO memories(id, group_name, title, body, tags_json, source_ids_json, origin_label,
        superseded, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId, group, name, String(body == null ? '' : body), tagsJson, sourceJson, label, oldBody, order, now, now);
      return this.getMemory(newId);
    });
  }

  /** 删除卡片并返回被删快照（供前端 Toast 撤销后原样恢复） */
  deleteMemory(id) {
    return this.tx(() => {
      const row = this.getMemory(id);
      if (!row) return null;
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return row;
    });
  }

  /**
   * 移动卡片：{ targetGroup } 跨常驻分组移到目标组末尾；
   * { delta, scopeIds } 在 scopeIds 给出的可见顺序内上下移动 delta 位，再整体重排组内 sort_order。
   */
  moveMemory(id, { delta, scopeIds, targetGroup } = {}) {
    return this.tx(() => {
      const row = this.db.prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE id = ?`).get(id);
      if (!row) return null;
      if (targetGroup !== undefined) {
        if (!MEMORY_GROUPS.includes(targetGroup)) throw new Error(`unknown memory group: ${targetGroup}`);
        const order = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM memories WHERE group_name = ?').get(targetGroup).n;
        this.db.prepare('UPDATE memories SET group_name = ?, sort_order = ?, updated_at = ? WHERE id = ?')
          .run(targetGroup, order, Date.now(), id);
        return this.getMemory(id);
      }
      const d = Math.trunc(Number(delta) || 0);
      if (!d) return memoryRow(row);
      const ids = this.db.prepare('SELECT id FROM memories WHERE group_name = ? ORDER BY sort_order ASC, created_at ASC')
        .all(row.group_name).map((r) => r.id);
      let base = ids;
      if (Array.isArray(scopeIds) && scopeIds.length) {
        const inGroup = new Set(ids);
        const scoped = scopeIds.filter((x) => inGroup.has(x));
        if (scoped.includes(id)) base = scoped;
      }
      const at = base.indexOf(id);
      if (at < 0) return memoryRow(row);
      const to = Math.max(0, Math.min(base.length - 1, at + d));
      if (to === at) return memoryRow(row);
      base.splice(to, 0, base.splice(at, 1)[0]);
      // 作用域之外的卡片保持原有相对顺序，接在作用域之后
      const finalIds = base.concat(ids.filter((x) => !base.includes(x)));
      const upd = this.db.prepare('UPDATE memories SET sort_order = ? WHERE id = ?');
      finalIds.forEach((cid, i) => upd.run(i, cid));
      return this.getMemory(id);
    });
  }

  // ---------- 推进事项（projects） ----------
  listProjects({ includeArchived = false } = {}) {
    const where = includeArchived ? '' : ' WHERE archived = 0';
    return this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects${where} ORDER BY updated_at DESC, created_at DESC`)
      .all().map(projectRow);
  }

  getProject(id) {
    return projectRow(this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id));
  }

  /** 未归档且设置了非空 workspace 的事项（工作区归属候选） */
  _workspaceProjects() {
    return this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects
      WHERE archived = 0 AND workspace IS NOT NULL AND TRIM(workspace) <> ''`).all();
  }

  /**
   * 按工作区路径为会话找最具体的活跃事项。
   * 归一化：反斜杠 → /、去尾部 /、Windows 盘符路径转小写；
   * 路径相等或位于事项目录的子目录即命中，多个命中取归一化路径最长（最具体）的事项。
   * 已归档事项不参与匹配。返回 projectRow，未命中返回 null。
   */
  matchProjectByWorkspace(workspace) {
    const target = normWorkspacePath(workspace);
    if (!target) return null;
    let best = null;
    let bestLen = -1;
    for (const row of this._workspaceProjects()) {
      const base = normWorkspacePath(row.workspace);
      if (!base) continue;
      if (target !== base && !target.startsWith(base === '/' ? '/' : base + '/')) continue;
      if (base.length > bestLen) { best = row; bestLen = base.length; }
    }
    return best ? projectRow(best) : null;
  }

  /** 把存量「未静默锁定且未关联」的会话按工作区重新归属到最具体的活跃事项，返回关联条数 */
  _autoAssignConversations() {
    const rows = this.db.prepare(`SELECT id, workspace FROM conversations
      WHERE project_locked = 0 AND project_id IS NULL AND workspace IS NOT NULL AND TRIM(workspace) <> ''`).all();
    const upd = this.db.prepare('UPDATE conversations SET project_id = ? WHERE id = ? AND project_locked = 0 AND project_id IS NULL');
    let n = 0;
    for (const r of rows) {
      const m = this.matchProjectByWorkspace(r.workspace);
      if (m) n += Number(upd.run(m.id, r.id).changes || 0);
    }
    return n;
  }

  /** 新建或更新推进事项；未传的字段在更新时保持原值 */
  saveProject({ id, name, state, workspace, progress, decisions, rejected, nextStep, archived } = {}) {
    const nm = String(name == null ? '' : name).trim();
    if (!nm) throw new Error('project name required');
    const now = Date.now();
    return this.tx(() => {
      const existing = id ? this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) : null;
      if (existing) {
        const next = {
          name: nm,
          state: state === undefined ? existing.state : String(state || existing.state || '推进中'),
          workspace: workspace === undefined ? existing.workspace : (workspace ? String(workspace) : null),
          progress: progress === undefined ? existing.progress : String(progress == null ? '' : progress),
          decisions: decisions === undefined ? parseJsonArray(existing.decisions_json) : normalizeList(decisions),
          rejected: rejected === undefined ? parseJsonArray(existing.rejected_json) : normalizeList(rejected),
          nextStep: nextStep === undefined ? existing.next_step : String(nextStep == null ? '' : nextStep),
          archived: archived === undefined ? existing.archived : (archived ? 1 : 0),
        };
        this.db.prepare(`UPDATE projects SET name = ?, state = ?, workspace = ?, progress = ?, decisions_json = ?,
          rejected_json = ?, next_step = ?, archived = ?, updated_at = ? WHERE id = ?`)
          .run(next.name, next.state, next.workspace, next.progress, JSON.stringify(next.decisions),
            JSON.stringify(next.rejected), next.nextStep, next.archived, now, id);
        // 事项设置/修改了非空工作区：把存量「未锁定且未关联」的会话按工作区补关联
        if (next.workspace) this._autoAssignConversations();
        return this.getProject(id);
      }
      const newId = id || crypto.randomUUID();
      this.db.prepare(`INSERT INTO projects(id, name, state, workspace, progress, decisions_json, rejected_json,
        next_step, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId, nm, String(state || '推进中'), workspace ? String(workspace) : null,
          String(progress == null ? '' : progress), JSON.stringify(normalizeList(decisions)),
          JSON.stringify(normalizeList(rejected)), String(nextStep == null ? '' : nextStep), archived ? 1 : 0, now, now);
      if (workspace) this._autoAssignConversations();
      return this.getProject(newId);
    });
  }

  /** 删除推进事项：关联会话 project_id 置 NULL，返回被删快照 */
  deleteProject(id) {
    return this.tx(() => {
      const row = this.getProject(id);
      if (!row) return null;
      this.db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return row;
    });
  }

  // ---------- 跨设备记忆包（mem0-memory-pack-v1，SPEC 2.2 第 4 点） ----------
  /** 导出全部常驻卡片与推进事项（含已归档）为可序列化记忆包，memories/projects 均为 JS 数组 */
  exportMemoryPack() {
    return {
      version: MEMORY_PACK_VERSION,
      exportedAt: new Date().toISOString(),
      memories: this.listMemories(),
      projects: this.listProjects({ includeArchived: true }),
    };
  }

  /**
   * 把记忆包幂等合并进当前库（单事务）。版本不符抛明确错误。
   *   projects：按 id 再按同名匹配；不存在则插入；已存在则合并 decisions/rejected 去重，
   *             导入项 updatedAt 更新时覆盖非空 state/progress/nextStep/workspace/archived。
   *   memories：仅接受 MEMORY_GROUPS 内的合法分组（其它分组跳过）；按 id 或 group+title 匹配；
   *             不存在则插入到该分组末尾；已存在且 body 不同且导入项更新时，把原 body 记入 superseded 再更新 body/tags。
   * 返回新建或实际发生合并更新的条数 { importedMemories, importedProjects }。
   */
  importMemoryPack(pack) {
    if (!pack || typeof pack !== 'object' || pack.version !== MEMORY_PACK_VERSION) {
      throw new Error(`invalid memory pack: version must be ${MEMORY_PACK_VERSION}`);
    }
    return this.tx(() => {
      let importedProjects = 0;
      let importedMemories = 0;

      for (const raw of Array.isArray(pack.projects) ? pack.projects : []) {
        if (!raw || typeof raw !== 'object') continue;
        const name = String(raw.name == null ? '' : raw.name).trim();
        if (!name) continue;
        const incomingAt = Number(raw.updatedAt) || 0;
        const local = raw.id ? this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(String(raw.id)) : null;
        const existing = local || this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE name = ?`).get(name);
        if (!existing) {
          const id = raw.id ? String(raw.id) : crypto.randomUUID();
          const at = incomingAt || Date.now();
          this.db.prepare(`INSERT INTO projects(id, name, state, archived, workspace, progress, decisions_json, rejected_json,
            next_step, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, name, String(raw.state || '推进中'), raw.archived ? 1 : 0,
              raw.workspace ? String(raw.workspace) : null,
              String(raw.progress == null ? '' : raw.progress),
              JSON.stringify(normalizeList(raw.decisions)), JSON.stringify(normalizeList(raw.rejected)),
              String(raw.nextStep == null ? '' : raw.nextStep), Number(raw.createdAt) || at, at);
          importedProjects++;
          continue;
        }
        const decisions = dedupeList([...parseJsonArray(existing.decisions_json), ...normalizeList(raw.decisions)]);
        const rejected = dedupeList([...parseJsonArray(existing.rejected_json), ...normalizeList(raw.rejected)]);
        const arraysChanged = JSON.stringify(decisions) !== existing.decisions_json
          || JSON.stringify(rejected) !== existing.rejected_json;
        const newer = incomingAt > (Number(existing.updated_at) || 0);
        const next = {
          name: existing.name, state: existing.state, workspace: existing.workspace,
          progress: existing.progress, nextStep: existing.next_step, archived: existing.archived,
          updatedAt: Number(existing.updated_at) || 0,
        };
        if (newer) {
          next.name = name;
          if (raw.state) next.state = String(raw.state);
          if (raw.progress) next.progress = String(raw.progress);
          if (raw.nextStep) next.nextStep = String(raw.nextStep);
          if (raw.workspace) next.workspace = String(raw.workspace);
          next.archived = raw.archived ? 1 : 0;
          if (incomingAt > next.updatedAt) next.updatedAt = incomingAt;
        } else {
          next.name = existing.name;
        }
        if (arraysChanged || newer) {
          this.db.prepare(`UPDATE projects SET name = ?, state = ?, workspace = ?, progress = ?, decisions_json = ?,
            rejected_json = ?, next_step = ?, archived = ?, updated_at = ? WHERE id = ?`)
            .run(next.name, next.state, next.workspace, next.progress, JSON.stringify(decisions),
              JSON.stringify(rejected), next.nextStep, next.archived, next.updatedAt, existing.id);
          importedProjects++;
        }
      }

      for (const raw of Array.isArray(pack.memories) ? pack.memories : []) {
        if (!raw || typeof raw !== 'object') continue;
        const group = raw.group;
        if (!MEMORY_GROUPS.includes(group)) continue; // 非法分组直接跳过
        const title = String(raw.title == null ? '' : raw.title).trim();
        if (!title) continue;
        const body = String(raw.body == null ? '' : raw.body);
        const incomingAt = Number(raw.updatedAt) || 0;
        const local = raw.id ? this.db.prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE id = ?`).get(String(raw.id)) : null;
        const existing = local || this.db.prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE group_name = ? AND title = ?`).get(group, title);
        if (!existing) {
          const id = raw.id ? String(raw.id) : crypto.randomUUID();
          const at = incomingAt || Date.now();
          const order = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM memories WHERE group_name = ?').get(group).n;
          this.db.prepare(`INSERT INTO memories(id, group_name, title, body, tags_json, source_ids_json, origin_label,
            superseded, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, group, title, body, JSON.stringify(normalizeList(raw.tags)), JSON.stringify(normalizeList(raw.sourceIds)),
              String(raw.originLabel || '手动录入'), String(raw.superseded || ''), order, Number(raw.createdAt) || at, at);
          importedMemories++;
          continue;
        }
        // 已存在：仅当导入项更新且 body 确实不同时，把原 body 存入 superseded 再更新 body/tags
        if (!(incomingAt > (Number(existing.updated_at) || 0)) || existing.body === body) continue;
        this.db.prepare('UPDATE memories SET body = ?, tags_json = ?, superseded = ?, updated_at = ? WHERE id = ?')
          .run(body, JSON.stringify(normalizeList(raw.tags)), String(existing.body || ''), incomingAt, existing.id);
        importedMemories++;
      }

      return { importedMemories, importedProjects };
    });
  }

  close() { this.db.close(); }
}

/**
 * 工作区路径归一化：反斜杠 → /、去尾部 /（保留根路径 /）、Windows 盘符路径转小写。
 * 非字符串或空白返回 ''，便于调用方直接判空。
 */
function normWorkspacePath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim().replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (/^[a-zA-Z]:(?:\/|$)/.test(s)) s = s.toLowerCase();
  return s;
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

/** JSON 列 → JS 数组（空值/非法内容一律回退空数组，绝不向上抛） */
function parseJsonArray(text) {
  if (Array.isArray(text)) return text;
  if (text == null || text === '') return [];
  try {
    const v = JSON.parse(String(text));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/** 入参数组归一化：去掉 null/undefined/空白项并转字符串 */
function normalizeList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x != null && String(x).trim() !== '').map((x) => String(x));
}

/** 合并导入时对字符串数组去重（保留首次出现顺序） */
function dedupeList(v) {
  const seen = new Set();
  const out = [];
  for (const x of normalizeList(v)) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/** memories 行 → 对外对象（tags / sourceIds 解析成数组） */
function memoryRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    group: r.group_name,
    title: r.title,
    body: r.body,
    tags: parseJsonArray(r.tags_json),
    sourceIds: parseJsonArray(r.source_ids_json),
    originLabel: r.origin_label,
    superseded: r.superseded || '',
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** projects 行 → 对外对象（decisions / rejected 解析成数组，archived 为布尔） */
function projectRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    state: r.state,
    archived: !!r.archived,
    workspace: r.workspace == null ? null : r.workspace,
    progress: r.progress || '',
    decisions: parseJsonArray(r.decisions_json),
    rejected: parseJsonArray(r.rejected_json),
    nextStep: r.next_step || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = { Store, MEMORY_GROUPS, LOCAL_SOURCES, WEB_SOURCES, ALL_SOURCES, hash, localDay };
