#!/usr/bin/env node
/**
 * 跨平台零隐私合成测试夹具生成脚本（纯 Node 标准库：node:fs, node:path, node:zlib, node:sqlite）
 *
 * 用法：
 *   node fixtures/build-fixtures.mjs [outputDir]
 *
 * 生成目录结构（全部为虚构合成数据，不含任何真实用户路径或密钥）：
 *   <outputDir>/
 *     dsh/proj-demo/sess-normal/session.v2.jsonl.zstd     (4 帧独立 Zstd 拼接正常会话)
 *     dsh/proj-demo/sess-subagent/session.v2.jsonl.zstd   (多帧大容量 subagent 会话，验证提前退出无 AbortError)
 *     antigravity/.gemini/antigravity/conversation_summaries.db
 *     antigravity/.gemini/antigravity/brain/ag-main-0001/.system_generated/logs/transcript.jsonl
 *     antigravity/.gemini/antigravity/brain/ag-sub-0002/.system_generated/logs/transcript.jsonl
 *     codex/session_index.jsonl
 *     codex/sessions/2026/11/15/rollout-2026-11-15T10-00-00-019a1111-2222-7333-8444-555555550001.jsonl
 *     codex/sessions/2026/11/15/rollout-2026-11-15T10-05-00-019a1111-2222-7333-8444-555555550002.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_TIME_MS = Date.UTC(2026, 10, 15, 10, 0, 0); // 2026-11-15T10:00:00Z
const PAST_MTIME_SEC = Math.floor((Date.now() - 120_000) / 1000);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAgedFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, PAST_MTIME_SEC, PAST_MTIME_SEC);
}

/**
 * 将每行 JSON 文本独立压缩为一个 Zstd Frame 后顺序拼接（复现真实 DeepSeek Harness 写入格式）
 */
function compressMultiFrameZstd(lines) {
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw new Error('当前 Node.js 版本不支持 zlib.zstdCompressSync（需 Node 22.15+ / 24+）');
  }
  const frames = lines.map((line) => {
    const raw = line.endsWith('\n') ? line : `${line}\n`;
    return zlib.zstdCompressSync(Buffer.from(raw, 'utf8'));
  });
  return Buffer.concat(frames);
}

export function buildFixtures(outputDir) {
  const outRoot = path.resolve(outputDir);
  ensureDir(outRoot);

  // =========================================================================
  // 1. DeepSeek Harness (dsh/)
  // =========================================================================
  const dshRoot = path.join(outRoot, 'dsh');
  const dshNormalFile = path.join(dshRoot, 'proj-demo', 'sess-normal', 'session.v2.jsonl.zstd');
  const dshNormalLines = [
    JSON.stringify({
      type: 'session',
      id: 'dsh-mf-normal-01',
      version: 2,
      createdAt: BASE_TIME_MS,
      cwd: '/workspace/order-service',
    }),
    JSON.stringify({
      type: 'user/message',
      seq: 1,
      time: BASE_TIME_MS + 1000,
      surfaceOp: 'append',
      data: {
        id: 'u-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '第一轮提问：为什么 Zstd 多帧会话之前只读到了第一行 header？' }],
      },
    }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 2,
      time: BASE_TIME_MS + 2000,
      surfaceOp: 'append',
      data: {
        message: {
          id: 'a-1',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '分析 Node zlib.createZstdDecompress 遇到单帧结束符的行为。' },
            { type: 'text', text: '第一轮回答：因为 createZstdDecompress 读完第 1 个 Zstd 帧就会触发 end，必须按 bytesWritten 循环消费剩余字节流。' },
          ],
        },
      },
    }),
    JSON.stringify({
      type: 'user/message',
      seq: 3,
      time: BASE_TIME_MS + 3000,
      surfaceOp: 'append',
      data: {
        id: 'u-2',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '第二轮追问：那遇到 subagent 首行提前退出时要注意什么？' }],
      },
    }),
  ];
  writeAgedFile(dshNormalFile, compressMultiFrameZstd(dshNormalLines));

  // 多帧大容量 subagent 文件（超过 64KB 流缓冲区，验证首行 return null 时不会触发 compose AbortError）
  const dshSubagentFile = path.join(dshRoot, 'proj-demo', 'sess-subagent', 'session.v2.jsonl.zstd');
  const filler = 'subagent-stream-payload-padding-'.repeat(1200);
  const dshSubagentLines = [
    JSON.stringify({
      type: 'session',
      id: 'dsh-mf-subagent-02',
      version: 2,
      createdAt: BASE_TIME_MS + 5000,
      cwd: '/workspace/order-service',
      origin: 'subagent',
    }),
    JSON.stringify({
      type: 'user/message',
      seq: 1,
      time: BASE_TIME_MS + 6000,
      surfaceOp: 'append',
      data: {
        id: 'sub-u1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `子代理内部指令不应入库 ${filler}` }],
      },
    }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 2,
      time: BASE_TIME_MS + 7000,
      surfaceOp: 'append',
      data: {
        message: {
          id: 'sub-a1',
          role: 'assistant',
          content: [{ type: 'text', text: `子代理内部输出不应入库 ${filler}` }],
        },
      },
    }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 3,
      time: BASE_TIME_MS + 8000,
      surfaceOp: 'append',
      data: {
        message: {
          id: 'sub-a2',
          role: 'assistant',
          content: [{ type: 'text', text: `子代理后续帧填充 ${filler}` }],
        },
      },
    }),
  ];
  writeAgedFile(dshSubagentFile, compressMultiFrameZstd(dshSubagentLines));

  // =========================================================================
  // 2. Antigravity (antigravity/.gemini/antigravity/)
  // =========================================================================
  const agVariantDir = path.join(outRoot, 'antigravity', '.gemini', 'antigravity');
  ensureDir(agVariantDir);
  const agDbPath = path.join(agVariantDir, 'conversation_summaries.db');
  if (fs.existsSync(agDbPath)) fs.rmSync(agDbPath, { force: true });

  {
    const db = new DatabaseSync(agDbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        created_at_ns INTEGER NOT NULL DEFAULT 0,
        updated_at_ns INTEGER NOT NULL DEFAULT 0
      );
    `);
    const ins = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth, created_at_ns, updated_at_ns
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // 1) 正常顶层会话：带 URL 编码的 workspace_uris + 原生 title + 超出 JS 安全整数上限的纳秒时间戳（SELECT * 会抛 ERR_OUT_OF_RANGE）
    ins.run(
      'ag-main-0001',
      '订单服务缓存架构重构',
      JSON.stringify(['file:///d%3A/demo-workspace/order-service']),
      '',
      0,
      1763200800123456789n,
      1763200950987654321n
    );
    // 2) 子代理会话：parent_conversation_id 非空且 nesting_depth = 1（应跳过不入库）
    ins.run(
      'ag-sub-0002',
      '子代理：检索缓存调用点',
      JSON.stringify(['file:///d%3A/demo-workspace/order-service']),
      'ag-main-0001',
      1,
      1763200810123456789n,
      1763200890987654321n
    );
    db.close();
  }
  fs.utimesSync(agDbPath, PAST_MTIME_SEC, PAST_MTIME_SEC);

  const agMainTranscript = path.join(
    agVariantDir,
    'brain',
    'ag-main-0001',
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  writeAgedFile(
    agMainTranscript,
    [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-15T10:00:00Z',
        content: '<USER_REQUEST>帮我梳理订单服务 Redis 缓存雪崩的兜底改造步骤</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-15T10:00:05Z',
        thinking: '先看现有过期策略',
        tool_calls: [{ name: 'read_file', args: { Path: 'cache.js' } }],
        content: '建议增加随机抖动 TTL 与本地短时互斥锁回源保护。',
      }),
      JSON.stringify({
        step_index: 2,
        source: 'SYSTEM',
        type: 'TOOL_RUN_COMMAND',
        created_at: '2026-11-15T10:00:08Z',
        content: 'npm test',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-15T10:00:12Z',
        content: '已完成互斥锁与过期时间随机偏移验证。',
      }),
    ].join('\n') + '\n'
  );

  // 同时放一份脑目录 task.md 验证数据库原生 title 优先级高于 titleFromBrain
  writeAgedFile(
    path.join(agVariantDir, 'brain', 'ag-main-0001', 'task.md'),
    '# 旧脑目录回退标题（应优先取数据库的原生标题）\n'
  );

  const agSubTranscript = path.join(
    agVariantDir,
    'brain',
    'ag-sub-0002',
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  writeAgedFile(
    agSubTranscript,
    [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-11-15T10:01:00Z',
        content: '<USER_REQUEST>扫描全部 getCache 调用点</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-15T10:01:05Z',
        content: '子代理扫描完毕，共 12 处。',
      }),
    ].join('\n') + '\n'
  );

  // =========================================================================
  // 3. Codex (codex/)
  // =========================================================================
  const codexRoot = path.join(outRoot, 'codex');
  const codexMainId = '019a1111-2222-7333-8444-555555550001';
  const codexSubId = '019a1111-2222-7333-8444-555555550002';

  writeAgedFile(
    path.join(codexRoot, 'session_index.jsonl'),
    [
      JSON.stringify({ id: codexMainId, thread_name: 'Postgres 索引在线创建检查' }),
      JSON.stringify({ id: codexSubId, thread_name: '子代理：SQL 语法复核' }),
    ].join('\n') + '\n'
  );

  const codexDayDir = path.join(codexRoot, 'sessions', '2026', '11', '15');
  writeAgedFile(
    path.join(codexDayDir, `rollout-2026-11-15T10-00-00-${codexMainId}.jsonl`),
    [
      JSON.stringify({
        timestamp: '2026-11-15T10:00:00Z',
        type: 'session_meta',
        payload: { id: codexMainId, cwd: '/workspace/order-service', source: 'cli' },
      }),
      JSON.stringify({
        timestamp: '2026-11-15T10:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>cwd=/workspace/order-service</environment_context>' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-15T10:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '大表加复合索引怎样避免锁表阻塞线上写入？' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-15T10:00:05Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"cat migrations/01.sql"}' },
      }),
      JSON.stringify({
        timestamp: '2026-11-15T10:00:06Z',
        type: 'response_item',
        payload: { type: 'function_call_output', output: 'CREATE INDEX ...' },
      }),
      JSON.stringify({
        timestamp: '2026-11-15T10:00:09Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '使用 CREATE INDEX CONCURRENTLY，并确保该语句不在显式事务块内执行。' }],
        },
      }),
    ].join('\n') + '\n'
  );

  writeAgedFile(
    path.join(codexDayDir, `rollout-2026-11-15T10-05-00-${codexSubId}.jsonl`),
    [
      JSON.stringify({
        timestamp: '2026-11-15T10:05:00Z',
        type: 'session_meta',
        payload: {
          id: codexSubId,
          cwd: '/workspace/order-service',
          source: { subagent: { parent_thread_id: codexMainId, role: 'reviewer' } },
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-15T10:05:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '子代理任务：检查 SQL 迁移脚本语法' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-15T10:05:04Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '子代理复核无误。' }],
        },
      }),
    ].join('\n') + '\n'
  );

  return {
    outputDir: outRoot,
    roots: {
      dsh: dshRoot,
      antigravity: path.join(outRoot, 'antigravity', '.gemini'),
      codex: codexRoot,
    },
    files: {
      dshNormalFile,
      dshSubagentFile,
      agDbPath,
      agMainTranscript,
      agSubTranscript,
    },
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const targetDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '.generated-sample');
  const res = buildFixtures(targetDir);
  console.log(JSON.stringify({ ok: true, outputDir: res.outputDir, roots: res.roots }, null, 2));
}
