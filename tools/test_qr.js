/*
 * 二维码编码器自检：和 Python `qrcode` 库生成的矩阵**逐模块比对**。
 *
 * 为什么不"扫一下看看能不能读出来"：扫得出来不代表编码正确（有些错误只有
 * 特定扫码器/特定版本才暴露）。逐比特比对才是有确定性的验证。
 *
 * 前置：python tools/gen_expected_qr.py > tools/expected_qr.json
 * 用法：node tools/test_qr.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const EXPECTED = path.join(ROOT, 'tools', 'expected_qr.json');

/* ------------------------------------------------ 拼 bundle 并跑起来 */

const FILES = ['00-util.js', '05-qr.js', '10-crypto.js'];
let bundle = '';
for (const f of FILES) bundle += fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';

const sandbox = {
  console: console,
  btoa: btoa,
  atob: atob,
  Math: Math,
  Date: Date,
  JSON: JSON,
  Object: Object,
  Array: Array,
  Number: Number,
  String: String,
  Boolean: Boolean,
  RegExp: RegExp,
  Error: Error,
  TypeError: TypeError,
  Uint8Array: Uint8Array,
  Uint32Array: Uint32Array,
  Int32Array: Int32Array,
  Promise: Promise,
  isNaN: isNaN,
  isFinite: isFinite,
  parseInt: parseInt,
  parseFloat: parseFloat
};
vm.createContext(sandbox);
sandbox.Host = {
  log: {
    info: function () { return Promise.resolve(true); },
    error: function () { return Promise.resolve(true); }
  }
};
vm.runInContext(bundle, sandbox, { filename: 'bundle.js' });

const { qrEncodeMatrix, qrMakePngDataUri } = sandbox;

/* ---------------------------------------------------------- 断言工具 */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    const line = name + (detail ? '  → ' + detail : '');
    failures.push(line);
    console.log('  \u2717 ' + line);
  }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

/* ------------------------------------------------------------- 用例 */

const cases = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));

console.log('矩阵逐模块比对（' + cases.length + ' 组：纠错等级 M/Q × 版本 1–10 × 8 种掩码）\n');

let compared = 0;
const badCases = [];

for (const c of cases) {
  const label = c.level + ' v' + c.version + ' mask' + c.mask + ' len' + c.len;
  const got = qrEncodeMatrix(c.text, c.mask, c.level);

  if (got.version !== c.version) {
    badCases.push(label + ' 版本不符 got v' + got.version);
    continue;
  }
  if (got.size !== c.size) {
    badCases.push(label + ' 尺寸不符 got ' + got.size);
    continue;
  }

  let diff = -1;
  for (let i = 0; i < c.rows.length && diff < 0; i++) {
    const row = c.rows[i];
    for (let j = 0; j < row.length; j++) {
      if (got.modules[i][j] !== (row.charAt(j) === '1' ? 1 : 0)) { diff = i * c.size + j; break; }
    }
  }
  if (diff >= 0) {
    badCases.push(label + ' 第 ' + diff + ' 个模块不符（行 ' + Math.floor(diff / c.size)
      + ' 列 ' + (diff % c.size) + '）');
  } else {
    compared += 1;
  }
}

ok('全部 ' + cases.length + ' 组矩阵与参考实现一致（' + compared + ' 组通过）',
  badCases.length === 0,
  badCases.length ? badCases.slice(0, 6).join(' | ') : '');

/* ---------------------------------------------- 自动选掩码（不指定） */

console.log('\n自动选掩码\n');

for (const c of cases.filter(function (x) { return x.mask === 0; })) {
  const tag = c.level + ' v' + c.version + ' len' + c.len;
  const got = qrEncodeMatrix(c.text, null, c.level);
  ok(tag + ' 自动选出的掩码在 0–7 内', got.mask >= 0 && got.mask <= 7, String(got.mask));
  ok(tag + ' 自动结果与「同掩码强制」一致',
    JSON.stringify(got.modules) === JSON.stringify(qrEncodeMatrix(c.text, got.mask, c.level).modules));
  ok(tag + ' 纠错等级被正确记录', got.level === c.level, String(got.level));
}

/* ------------------------------------------------------------ 边界 */

console.log('\n边界与错误处理\n');

let tooLong = null;
try {
  qrEncodeMatrix('x'.repeat(500));
} catch (e) {
  tooLong = e;
}
ok('内容超出上限时抛错（不静默截断）', tooLong !== null, tooLong ? '' : 'no throw');
ok('错误信息说明了原因', tooLong ? /太长/.test(String(tooLong.message)) : false,
  tooLong ? String(tooLong.message) : '');

eq('空串也能编码（v1）', qrEncodeMatrix('').version, 1);

/* ------------------------------------------------------- PNG 产物 */

console.log('\nPNG 产物\n');

const QR_TEXT = 'tuyaSmart--qrLogin?token=0123456789abcdef';
// 和插件实际用法一致：纠错等级 Q（要被人拿手机拍屏幕）、5 像素/模块
const uri = qrMakePngDataUri(QR_TEXT, 5, 4, 'Q');
ok('是 data:image/png;base64 URI', uri.indexOf('data:image/png;base64,') === 0,
  uri.substring(0, 40));

const b64 = uri.substring('data:image/png;base64,'.length);
const png = Buffer.from(b64, 'base64');
const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
let sigOk = png.length > 8;
for (let i = 0; i < 8; i++) if (png[i] !== SIG[i]) sigOk = false;
ok('PNG 签名正确', sigOk);

// 手工走一遍 chunk，顺便验每个 chunk 的 CRC（CRC 写错图就打不开）
function readChunks(buf) {
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    const crc = buf.readUInt32BE(p + 8 + len);
    out.push({ type: type, len: len, data: data, crc: crc, crcPos: p + 8 + len });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

const chunks = readChunks(png);
eq('chunk 顺序', chunks.map(function (c) { return c.type; }), ['IHDR', 'IDAT', 'IEND']);
eq('IHDR 长度 13', chunks[0].len, 13);
eq('位深 1', chunks[0].data[8], 1);
eq('颜色类型 0（灰度）', chunks[0].data[9], 0);

const w = chunks[0].data.readUInt32BE(0);
const h = chunks[0].data.readUInt32BE(4);
ok('宽高相等且 > 0', w === h && w > 0, w + 'x' + h);

// CRC 必须对（自己复算一遍，和 zlib 的实现无关）
function crc32js(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let crcBad = [];
for (const c of chunks) {
  const calc = crc32js(png.subarray(c.crcPos - c.len - 4, c.crcPos));
  if (calc !== c.crc) crcBad.push(c.type);
}
eq('所有 chunk 的 CRC 都正确', crcBad, []);

ok('体积够小（data URI < 12KB，登录视图塞得下）', uri.length < 12288,
  uri.length + ' 字符');

// 把 PNG 落盘，交给 Python 侧解出来比对像素（见 tools/check_qr_png.py）
const outDir = path.join(ROOT, 'tools');
fs.writeFileSync(path.join(outDir, 'qr_selftest.png'), png);
fs.writeFileSync(path.join(outDir, 'qr_selftest.txt'),
  JSON.stringify({ text: QR_TEXT, level: 'Q', scale: 5, quiet: 4 }));
console.log('  已落盘 tools/qr_selftest.png，交给 Python 侧解像素');

/* -------------------------------------------------------------- 汇总 */

console.log('\n' + '='.repeat(56));
console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fail > 0) {
  console.log('失败：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('二维码编码器自检全部通过 ♪');
