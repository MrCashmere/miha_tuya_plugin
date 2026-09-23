/*
 * 打包：把 plugin.json + main.js 打成宿主能直接导入的 zip。
 *
 * 两条硬要求（写错了宿主会说"插件包结构不对"，但不告诉你差在哪）：
 *   ① zip 的**根目录**下直接是 plugin.json 和 main.js，
 *      不能是 tuya-local/plugin.json（多套一层目录）。
 *   ② plugin.json 里的 `entry` 必须真的在包里。
 *
 * 这里手写 ZIP（store 模式，不压缩）而不引第三方依赖：一是保持工具链纯 Node、
 * 零安装；二是 store 模式产物是确定性的 —— 同样的输入永远得到同样的字节，
 * 便于比对和校验和。几十行就够。
 *
 * 用法：node tools/package.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/* ---------------------------------------------------------------- CRC32 */

const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------------------------------------------------ ZIP */

/** 拼一个 store 模式（不压缩）的 zip。 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  // 固定时间戳，保证产物可复现
  const dosTime = 0;
  const dosDate = (2026 - 1980) << 9 | (1 << 5) | 1;

  entries.forEach(function (e) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header 签名
    local.writeUInt16LE(20, 4);           // version needed = 2.0
    local.writeUInt16LE(0x0800, 6);       // flag: 文件名是 UTF-8
    local.writeUInt16LE(0, 8);            // method = 0（store）
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length

    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central directory 签名
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk number
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0, 38);              // external attrs
    cd.writeUInt32LE(offset, 42);         // 对应的 local header 偏移
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  });

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory 签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}

/* ----------------------------------------------------------------- main */

function main() {
  const manifestPath = path.join(ROOT, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('找不到 plugin.json');
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error('plugin.json 不是合法 JSON：' + e.message);
    process.exit(1);
  }

  const entry = manifest.entry || 'main.js';
  const entryPath = path.join(ROOT, entry);
  if (!fs.existsSync(entryPath)) {
    console.error('plugin.json 的 entry（' + entry + '）不存在，先跑一遍 node tools/build.js');
    process.exit(1);
  }

  // ⚠️ 只放这两个文件：zip 根目录下必须直接是 plugin.json 和 main.js
  const entries = [
    { name: 'plugin.json', data: fs.readFileSync(manifestPath) },
    { name: entry, data: fs.readFileSync(entryPath) }
  ];

  const iconPath = path.join(ROOT, 'icon.png');
  if (fs.existsSync(iconPath)) {
    entries.push({ name: 'icon.png', data: fs.readFileSync(iconPath) });
  }

  const zip = makeZip(entries);
  const outName = (manifest.id || 'plugin') + '-' + (manifest.version || '0.0.0') + '.zip';
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, outName);
  fs.writeFileSync(outPath, zip);

  // 校验：把刚写的 zip 读回来，确认根目录下就是那两个文件
  const raw = fs.readFileSync(outPath);
  const names = [];
  for (let i = 0; i < raw.length - 4; i++) {
    if (raw.readUInt32LE(i) === 0x02014b50) {
      const nameLen = raw.readUInt16LE(i + 28);
      names.push(raw.slice(i + 46, i + 46 + nameLen).toString('utf8'));
    }
  }
  const expected = entries.map(function (e) { return e.name; }).sort().join(',');
  const actual = names.slice().sort().join(',');
  if (actual !== expected) {
    console.error('zip 内容校验失败：期望 [' + expected + ']，实际 [' + actual + ']');
    process.exit(1);
  }
  const nested = names.filter(function (n) { return n.indexOf('/') >= 0; });
  if (nested.length > 0) {
    console.error('zip 里出现了目录层级（宿主要求根目录下直接是插件文件）：' + nested.join(','));
    process.exit(1);
  }

  console.log('已打包 ' + path.relative(ROOT, outPath));
  console.log('  文件 ' + names.join(', '));
  console.log('  大小 ' + zip.length + ' 字节（' + (zip.length / 1024).toFixed(1) + ' KB）');
  console.log('  zip 根目录下直接是插件文件，没有多套一层目录 ✓');
}

main();
