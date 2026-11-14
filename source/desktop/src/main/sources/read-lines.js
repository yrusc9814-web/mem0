'use strict';
/**
 * 逐行读取文本文件：用流 + readline，避免把大会话文件整体读进内存。
 * decompress 可选，用于 .zstd 等压缩输入（返回一个解压 Transform 流）。
 */
const fs = require('node:fs');
const readline = require('node:readline');
const { compose } = require('node:stream');

async function* readLines(file, { decompress } = {}) {
  const input = fs.createReadStream(file);
  let stream;
  try {
    if (decompress) {
      const dec = decompress();
      dec.setEncoding('utf8');
      stream = compose(input, dec);
    } else {
      input.setEncoding('utf8');
      stream = input;
    }
  } catch (e) {
    input.destroy();
    throw e;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    // 提前结束（如 header 不合法）时及时释放文件句柄
    stream.destroy();
    if (stream !== input) input.destroy();
  }
}

module.exports = { readLines };
