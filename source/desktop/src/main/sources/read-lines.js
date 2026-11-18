'use strict';
/**
 * 逐行读取文本文件：用流 + readline，避免把大会话文件整体读进内存。
 * decompress 可选，用于 .zstd 等压缩输入（返回一个解压 Transform 流）。
 *
 * DeepSeekRuntime 的 .jsonl.zstd 是「每行 JSONL 独立压缩成一个 Zstd Frame 后顺序拼接」的多帧字节流。
 * Node 的 createZstdDecompress() 读完第 1 个 Frame 就会触发 end，所以这里先按 Zstd Frame 结构切分
 * 压缩字节（可跨块读取），再为每帧新建一个解压流，用 dec.bytesWritten 推进偏移，循环读到 EOF。
 */
const fs = require('node:fs');
const readline = require('node:readline');
const { StringDecoder } = require('node:string_decoder');

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;
const READ_CHUNK = 256 * 1024;

/**
 * 解析 buf[offset] 起的一个 Zstd Frame 的总字节数。
 * 数据还没读全时返回 null；帧头/块头非法时直接抛错。
 */
function frameLength(buf, offset) {
  const rest = buf.length - offset;
  if (rest < 4) return null;
  const magic = buf.readUInt32LE(offset);
  if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
    if (rest < 8) return null;
    const size = buf.readUInt32LE(offset + 4);
    if (rest < 8 + size) return null;
    return 8 + size;
  }
  if (magic !== ZSTD_MAGIC) throw new Error('不是合法的 Zstd 数据（帧魔数不匹配）');
  let p = offset + 4;
  if (buf.length - p < 1) return null;
  const descriptor = buf[p++];
  if (descriptor & 0x08) throw new Error('不是合法的 Zstd 数据（帧头保留位非零）');
  const fcsFlag = descriptor >>> 6;
  const singleSegment = (descriptor >>> 5) & 1;
  const checksum = (descriptor >>> 2) & 1;
  const dictSize = [0, 1, 2, 4][descriptor & 3];
  if (!singleSegment) p += 1; // Window_Descriptor
  p += dictSize;
  p += fcsFlag === 0 && singleSegment ? 1 : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (buf.length - p < 3) return null;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = header & 1;
    const type = (header >>> 1) & 3;
    const size = header >>> 3;
    if (type === 3) throw new Error('不是合法的 Zstd 数据（保留块类型）');
    p += type === 1 ? 1 : size; // RLE 块只占 1 字节，其余按 Block_Size 跳过
    if (last) break;
  }
  if (checksum) p += 4;
  if (buf.length < p) return null;
  return p - offset;
}

/** 用全新的解压流解压单个 Frame，返回解压文本与已消费的压缩字节数 */
function decompressFrame(frame, decompress) {
  return new Promise((resolve, reject) => {
    const dec = decompress();
    const parts = [];
    dec.on('data', (c) => parts.push(c));
    dec.on('error', reject);
    dec.on('end', () => {
      const consumed = dec.bytesWritten;
      if (!(consumed > 0)) {
        reject(new Error('Zstd 帧解压失败（bytesWritten <= 0）'));
        return;
      }
      resolve({ text: Buffer.concat(parts), consumed });
    });
    dec.end(frame);
  });
}

/** 多帧 Zstd 文件逐行读取：按帧解压，提前退出时只关闭文件句柄，不销毁组合流。 */
async function* zstdLines(file, decompress) {
  const fh = await fs.promises.open(file, 'r');
  const decoder = new StringDecoder('utf8');
  let pending = Buffer.alloc(0);
  let carry = '';
  let eof = false;
  const emit = function* (text) {
    if (!text) return;
    const lines = (carry + text).split('\n');
    carry = lines.pop();
    for (const line of lines) yield line.endsWith('\r') ? line.slice(0, -1) : line;
  };
  try {
    for (;;) {
      let len = null;
      while (!eof) {
        len = frameLength(pending, 0);
        if (len !== null) break;
        const chunk = Buffer.allocUnsafe(READ_CHUNK);
        const { bytesRead } = await fh.read(chunk, 0, READ_CHUNK, null);
        if (!bytesRead) { eof = true; break; }
        pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      }
      if (len === null) {
        if (!pending.length && eof) break;
        throw new Error('Zstd 数据不完整（帧被截断）');
      }
      const frame = pending.subarray(0, len);
      if ((frame.readUInt32LE(0) & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
        pending = pending.subarray(len);
        continue; // skippable frame 不含正文
      }
      const { text, consumed } = await decompressFrame(frame, decompress);
      if (consumed !== len) throw new Error('Zstd 帧边界异常（bytesWritten 与帧长度不一致）');
      pending = pending.subarray(consumed);
      yield* emit(decoder.write(text));
    }
    yield* emit(decoder.end());
    if (carry) {
      yield carry.endsWith('\r') ? carry.slice(0, -1) : carry;
      carry = '';
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

async function* plainLines(file) {
  const input = fs.createReadStream(file);
  input.setEncoding('utf8');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    // 提前结束（如 header 不合法）时及时释放文件句柄
    input.destroy();
  }
}

async function* readLines(file, { decompress } = {}) {
  if (decompress) {
    yield* zstdLines(file, decompress);
    return;
  }
  yield* plainLines(file);
}

module.exports = { readLines };
