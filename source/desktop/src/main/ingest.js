'use strict';
/**
 * 本机会话采集：启动时全量扫描，之后定时增量（按文件 size+mtime 判断变化）。
 * 用轮询而不是 fs.watch：跨平台稳定，Agent 写文件很频繁，2 秒防抖足够实时。
 */
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const claudeCode = require('./sources/claude-code');
const codex = require('./sources/codex');
const deepseekHarness = require('./sources/deepseek-harness');
const antigravity = require('./sources/antigravity');
const zcode = require('./sources/zcode');
const dimcode = require('./sources/dimcode');
const workbuddy = require('./sources/workbuddy');

const ADAPTERS = Object.fromEntries([claudeCode, codex, deepseekHarness, antigravity, zcode, dimcode, workbuddy].map((a) => [a.id, a]));

const SLICE_MS = 15;

class LocalIngestor extends EventEmitter {
  constructor(store, roots, { intervalMs = 5000 } = {}) {
    super();
    this.store = store;
    this.roots = roots;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.idleWaiters = []; // stopAndWait 的等待者：在途扫描结束时唤醒
    this.claudeCleanV1Done = false; // 0.5.5 F2：Claude Code 旧游标清理只在本进程执行一次
    this.dshCleanV1Done = false; // 0.6.1：DSH 旧游标清理只在本进程执行一次
    this.status = Object.fromEntries(Object.keys(ADAPTERS).map((id) => [id, { found: false, files: 0, error: null, lastScanAt: null }]));
  }

  /** 0.5.5 F2：启动 ingest 时清一次 Claude Code 游标，让已入库的旧会话按新规则重读（库内 kv 标记保证只执行一次） */
  ensureClaudeCleanV1() {
    if (this.claudeCleanV1Done) return;
    if (typeof this.store.migrateClaudeCleanV1 === 'function') this.store.migrateClaudeCleanV1();
    this.claudeCleanV1Done = true;
  }

  /** 0.6.1：启动 ingest 时清一次 DSH 游标，让旧会话按新解析器重洗 thinking/tool_calls */
  ensureDshCleanV1() {
    if (this.dshCleanV1Done) return;
    if (typeof this.store.migrateDshCleanV1 === 'function') this.store.migrateDshCleanV1();
    this.dshCleanV1Done = true;
  }

  start() {
    this.stopped = false;
    this.ensureClaudeCleanV1();
    this.ensureDshCleanV1();
    const tick = async () => {
      if (this.stopped) return;
      await this.scanOnce().catch((e) => this.emit('error', e));
      // 扫描期间被 stop：不再安排下一轮
      if (this.stopped) return;
      this.timer = setTimeout(tick, this.intervalMs);
    };
    tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** 停止并等待在途扫描结束；最多等多久由调用方限时（退出时整体 3 秒） */
  async stopAndWait() {
    this.stop();
    if (!this.running) return;
    await new Promise((r) => this.idleWaiters.push(r));
  }

  async scanOnce() {
    if (this.running) return { changed: 0 };
    this.ensureClaudeCleanV1();
    this.ensureDshCleanV1();
    this.running = true;
    let changed = 0;
    const t0 = Date.now();
    // 分片：连续占用主线程超过 SLICE_MS 就让出一次事件循环，避免扫描大量文件时窗口卡顿
    let sliceStart = Date.now();
    const maybeYield = async () => {
      if (Date.now() - sliceStart < SLICE_MS) return;
      await new Promise((r) => setImmediate(r));
      sliceStart = Date.now();
    };
    try {
      for (const [id, adapter] of Object.entries(ADAPTERS)) {
        await maybeYield();
        const st = this.status[id];
        const root = this.roots[id];
        st.found = adapter.exists ? adapter.exists(root) : fs.existsSync(root);
        if (!st.found || !this.store.isSourceEnabled(id)) { st.lastScanAt = Date.now(); continue; }
        try {
          const files = await adapter.discover(root);
          st.files = files.length;
          for (const file of files) {
            await maybeYield();
            let s;
            try { s = adapter.signature ? adapter.signature(file) : await fs.promises.stat(file); } catch { continue; }
            const cur = this.store.getCursor(file);
            if (cur && cur.size === s.size && cur.mtime_ms === Math.floor(s.mtimeMs)) continue;
            // 文件还在被写入（2 秒内有改动）就等下一轮，避免读到半行
            if (Date.now() - s.mtimeMs < 2000 && cur) continue;
            try {
              const res = await adapter.read(file, root);
              const save = (conv) => {
                const r = this.store.upsertConversation(conv);
                if (r.changed) { changed++; this.emit('saved', { source: id, conversationId: r.id, added: r.added }); }
              };
              // 大多数来源一个文件一个会话；ZCode、DimCode 一个数据库里有全部会话（async generator 逐会话产出）
              if (res && typeof res[Symbol.asyncIterator] === 'function') {
                for await (const conv of res) {
                  await maybeYield();
                  save(conv);
                }
              } else {
                for (const conv of Array.isArray(res) ? res : res ? [res] : []) save(conv);
              }
              // 整个文件处理成功后才记游标；中途出错不写，下一轮重读
              this.store.setCursor(file, id, s.size, s.mtimeMs);
            } catch (e) {
              this.emit('error', Object.assign(e, { file }));
            }
          }
          st.error = null;
        } catch (e) {
          st.error = String(e.message || e);
        }
        st.lastScanAt = Date.now();
      }
    } finally {
      this.running = false;
      for (const r of this.idleWaiters.splice(0)) r();
    }
    if (changed) this.emit('changed', changed);
    this.emit('scanned', { changed, ms: Date.now() - t0 });
    return { changed };
  }

  getStatus() {
    return Object.entries(ADAPTERS).map(([id, a]) => ({
      id, label: a.label, root: this.roots[id], enabled: this.store.isSourceEnabled(id), ...this.status[id],
    }));
  }
}

module.exports = { LocalIngestor, ADAPTERS };
