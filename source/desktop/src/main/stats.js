'use strict';
/**
 * 托盘小窗用的只读统计（不改 db.js，只通过 store.db 读）。
 *
 * 「存入 X 条新消息」需要知道某个会话最近一次（今天）备份新增了多少条消息。现有表里没有这个信息：
 *   - messages.created_at 对本机来源是原始发送时间，不是备份时间；
 *   - conversations 只记 updated_at / message_count，不记增量。
 * 所以这里额外维护一张独立的小表 ui_ingest_log（与 db.js 的表结构互不影响，CREATE IF NOT EXISTS，
 * 外键 ON DELETE CASCADE 跟随会话删除）。每次 ingest（本机扫描的 'saved' 事件 / 插件桥 onSaved）调用 recordIngest。
 * 同一会话在同一天内多次新增会累加；跨天后从 0 重新计。
 * 表创建失败（只读库等）时退回进程内 Map，功能降级但不报错。
 */

const TABLE = 'ui_ingest_log';
/** 退路 Map 的上限：超出后按时间删最旧的，避免进程长期运行越积越多 */
const MAX_MEM_ENTRIES = 1000;

function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

class TrayStats {
  /**
   * @param {import('./db').Store} store
   * @param {{ now?: () => number, mcpCallsToday?: () => number }} [opts]
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.now = opts.now || (() => Date.now());
    this.mcpCallsOverride = opts.mcpCallsToday || null;
    this.mem = new Map(); // 退路：conversationId → { source, added, at }
    this.persist = false;
    try {
      store.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        added  INTEGER NOT NULL DEFAULT 0,
        at     INTEGER NOT NULL
      )`);
      this.persist = true;
    } catch { this.persist = false; }
  }

  /** 记录一次备份增量。added ≤ 0（只是内容更新）也会刷新时间，但不增加计数 */
  recordIngest({ conversationId, source, added = 0 } = {}) {
    if (!conversationId) return;
    const at = this.now();
    const t0 = startOfDay(at);
    this.pruneMem(t0);
    const n = Math.max(0, Number(added) || 0);
    if (this.persist) {
      try {
        const prev = this.store.db.prepare(`SELECT added, at FROM ${TABLE} WHERE conversation_id = ?`).get(conversationId);
        const total = prev && prev.at >= t0 ? prev.added + n : n;
        this.store.db.prepare(`INSERT INTO ${TABLE}(conversation_id, source, added, at) VALUES (?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET source = excluded.source, added = excluded.added, at = excluded.at`)
          .run(conversationId, String(source || ''), total, at);
        this.mem.delete(conversationId); // 已落库：清掉可能残留的内存项
        return;
      } catch { /* 会话已被删（外键失败）等：忽略，落到内存 */ }
    }
    const prev = this.mem.get(conversationId);
    this.mem.set(conversationId, { source, added: prev && prev.at >= t0 ? prev.added + n : n, at });
    this.pruneMem(t0);
  }

  /** 清理退路 Map：先删跨天的旧日期项，再按时间删最旧的，保持不超过 MAX_MEM_ENTRIES */
  pruneMem(t0) {
    for (const [id, row] of this.mem) {
      if (!row || !(row.at >= t0)) this.mem.delete(id);
    }
    if (this.mem.size <= MAX_MEM_ENTRIES) return;
    const oldestFirst = [...this.mem.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    const extra = this.mem.size - MAX_MEM_ENTRIES;
    for (let i = 0; i < extra; i++) this.mem.delete(oldestFirst[i][0]);
  }

  /** 今天新增（未跨天）的条数；没有记录或不是今天 → 0 */
  addedToday(conversationId) {
    const t0 = startOfDay(this.now());
    let row = null;
    if (this.persist) {
      try { row = this.store.db.prepare(`SELECT added, at FROM ${TABLE} WHERE conversation_id = ?`).get(conversationId) || null; } catch { row = null; }
    }
    if (!row) row = this.mem.get(conversationId) || null;
    return row && row.at >= t0 ? row.added : 0;
  }

  /** 今天备份的消息条数：今天产生的消息（与主窗口首页「新增 X 条消息」同口径，无时间戳的消息不计） */
  todayMessages() {
    try {
      return this.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?').get(startOfDay(this.now())).n;
    } catch { return 0; }
  }

  /** 今日 MCP 被读取次数。依赖另一模块提供的 store.getMcpCallsToday()；不存在时计 0 */
  mcpCallsToday() {
    try {
      if (this.mcpCallsOverride) return Number(this.mcpCallsOverride()) || 0;
      if (this.store && typeof this.store.getMcpCallsToday === 'function') return Number(this.store.getMcpCallsToday()) || 0;
    } catch { /* ignore */ }
    return 0;
  }

  /** 最近活动（默认 4 条），每条带今天的新增条数 */
  recent(limit = 4) {
    let rows = [];
    try {
      rows = this.store.db.prepare(`SELECT id, source, title, updated_at, message_count FROM conversations
        ORDER BY updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(limit, 20)));
    } catch { rows = []; }
    return rows.map((r) => ({
      id: r.id, source: r.source, title: r.title || '', updatedAt: r.updated_at || 0,
      messageCount: r.message_count || 0, addedToday: this.addedToday(r.id),
    }));
  }

  snapshot({ limit = 4 } = {}) {
    return { todayMessages: this.todayMessages(), mcpCallsToday: this.mcpCallsToday(), recent: this.recent(limit) };
  }
}

module.exports = { TrayStats, startOfDay, TABLE, MAX_MEM_ENTRIES };
