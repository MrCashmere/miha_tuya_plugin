/* ============================================================================
 * §0.5  二维码编码器（纯 JS：字节模式 / 纠错等级 M / 版本 1–10）
 *
 * ## 为什么这个插件里会有二维码编码器
 *
 * 涂鸦的扫码登录接口只返回一个 **token 字符串**，不返回图片：
 *
 *     POST apigw.iotbing.com/v1.0/m/life/home-assistant/qrcode/tokens?...  → {qrcode: "<token>"}
 *
 * 而宿主只接受 `imageUrl`（http(s) 地址或 `data:` URI），二维码得我们自己画。
 *
 * ⚠️ **绝不能图省事去调第三方在线二维码服务** —— 那等于把登录 token 送给外人。
 *    自己编码是唯一安全的选择，代价就是下面这 400 行。
 *
 * ## 实现要点（ISO/IEC 18004）
 *
 *   - 字节模式（模式指示符 0100），字符计数 8 位（v1–9）/ 16 位（v10+）
 *   - 纠错等级 M，版本按内容长度自适应
 *   - Reed-Solomon 在 GF(256) 上，本原多项式 0x11D
 *   - 8 种掩码全部评估，取罚分最低的（掩码选错有些老扫码器会读不出来）
 *   - 输出 **1 位灰度 PNG**（每像素 1 bit），体积最小
 *
 * ## 怎么证明它是对的
 *
 * 不看"能不能扫出来"，而是**和参考实现逐模块比对**：
 * Python 的 `qrcode` 库对同一段文本生成同版本的矩阵，两边 bit 逐一相等才算过。
 * 见 `tools/gen_expected_qr.py` + `tools/test_qr.js`。
 * ========================================================================== */

/* ---------------------------------------------------------- GF(256) 与 RS */

const QR_GF_EXP = new Uint8Array(512);
const QR_GF_LOG = new Uint8Array(256);

(function qrInitGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    QR_GF_EXP[i] = x;
    QR_GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) QR_GF_EXP[i] = QR_GF_EXP[i - 255];
})();

function qrGfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return QR_GF_EXP[QR_GF_LOG[a] + QR_GF_LOG[b]];
}

/** 生成多项式 ∏(x - α^i)，系数按降幂排列，长度 n+1。 */
function qrGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= qrGfMul(poly[j], QR_GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 对 data 求 ecLen 个纠错码字（综合除法取余）。 */
function qrRsEncode(data, ecLen) {
  const gen = qrGenPoly(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) {
      buf[i + j] ^= qrGfMul(gen[j], coef);
    }
  }
  return buf.subarray(data.length);
}

/* ------------------------------------------------------------------ 表 */

/*
 * 纠错分块表：等级 → 版本 → 每块纠错码字数 + 两组（块数, 每块数据码字数）。
 * 数据码字总数 = g1[0]*g1[1] + g2[0]*g2[1]。
 *
 * 只列 M 和 Q 两级 —— 够用，而且每一级都有对照向量验过。
 * M 是通行默认；Q 用在扫码登录上（那个二维码要被人拿手机拍屏幕，
 * 反光和摩尔纹是常态，HA 主线选的就是 QUARTILE）。
 */
const QR_EC = {
  M: {
    1: { ec: 10, g1: [1, 16], g2: [0, 0] },
    2: { ec: 16, g1: [1, 28], g2: [0, 0] },
    3: { ec: 26, g1: [1, 44], g2: [0, 0] },
    4: { ec: 18, g1: [2, 32], g2: [0, 0] },
    5: { ec: 24, g1: [2, 43], g2: [0, 0] },
    6: { ec: 16, g1: [4, 27], g2: [0, 0] },
    7: { ec: 18, g1: [4, 31], g2: [0, 0] },
    8: { ec: 22, g1: [2, 38], g2: [2, 39] },
    9: { ec: 22, g1: [3, 36], g2: [2, 37] },
    10: { ec: 26, g1: [4, 43], g2: [1, 44] }
  },
  Q: {
    1: { ec: 13, g1: [1, 13], g2: [0, 0] },
    2: { ec: 22, g1: [1, 22], g2: [0, 0] },
    3: { ec: 18, g1: [2, 17], g2: [0, 0] },
    4: { ec: 26, g1: [2, 24], g2: [0, 0] },
    5: { ec: 18, g1: [2, 15], g2: [2, 16] },
    6: { ec: 24, g1: [4, 19], g2: [0, 0] },
    7: { ec: 18, g1: [2, 14], g2: [4, 15] },
    8: { ec: 22, g1: [4, 18], g2: [2, 19] },
    9: { ec: 20, g1: [4, 16], g2: [4, 17] },
    10: { ec: 24, g1: [6, 19], g2: [2, 20] }
  }
};

/** 纠错等级的 2 位指示符。 */
const QR_EC_INDICATOR = { L: 1, M: 0, Q: 3, H: 2 };

function qrLevel(level) {
  const key = String(level || 'M').trim().toUpperCase();
  return QR_EC[key] ? key : 'M';
}

const QR_ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

/** v7+ 的版本信息（18 位 BCH），直接查表比现算省事。 */
const QR_VERSION_INFO = {
  7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3
};

/* ------------------------------------------------------------ 数据编码 */

function qrDataCodewords(version, level) {
  const t = QR_EC[level][version];
  return t.g1[0] * t.g1[1] + t.g2[0] * t.g2[1];
}

function qrCountBits(version) {
  return version <= 9 ? 8 : 16;
}

/** 选最小的、装得下的版本。装不下就抛错（别默默截断）。 */
function qrPickVersion(byteLen, level) {
  for (let v = 1; v <= 10; v++) {
    const capacityBits = qrDataCodewords(v, level) * 8;
    const needBits = 4 + qrCountBits(v) + byteLen * 8;
    if (needBits <= capacityBits) return v;
  }
  throw new Error(
    '二维码内容太长（' + byteLen + ' 字节，纠错等级 ' + level + '），超出本编码器的版本 10 上限'
  );
}

/** 编码成最终的码字序列（含分块 + RS + 交织）。 */
function qrCodewords(bytes, version, level) {
  const total = qrDataCodewords(version, level);
  const bits = [];
  function push(value, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  }

  push(0x4, 4);                       // 字节模式
  push(bytes.length, qrCountBits(version));
  for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);

  // 结束符：最多 4 个 0
  const cap = total * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(total);
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    data[i >> 3] = b;
  }
  // 交替填充字节
  for (let i = bits.length >> 3, alt = 0; i < total; i++, alt++) {
    data[i] = alt % 2 === 0 ? 0xec : 0x11;
  }

  // 分块
  const t = QR_EC[level][version];
  const blocks = [];
  let off = 0;
  for (let i = 0; i < t.g1[0]; i++) {
    blocks.push({ data: data.subarray(off, off + t.g1[1]), ec: null });
    off += t.g1[1];
  }
  for (let i = 0; i < t.g2[0]; i++) {
    blocks.push({ data: data.subarray(off, off + t.g2[1]), ec: null });
    off += t.g2[1];
  }
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].ec = qrRsEncode(blocks[i].data, t.ec);
  }

  // 交织：先按列取数据码字，再按列取纠错码字
  const out = new Uint8Array(total + blocks.length * t.ec);
  let p = 0;
  const maxData = Math.max.apply(null, blocks.map(function (b) { return b.data.length; }));
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < blocks[b].data.length) out[p++] = blocks[b].data[i];
    }
  }
  for (let i = 0; i < t.ec; i++) {
    for (let b = 0; b < blocks.length; b++) out[p++] = blocks[b].ec[i];
  }
  return out;
}

/* -------------------------------------------------------------- 矩阵构建 */

function qrPlaceFinder(m, isFn, row, col, n) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= n || c < 0 || c >= n) continue;
      isFn[r][c] = true;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      let v = 0;
      if (inRing) {
        const edge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        v = edge || core ? 1 : 0;
      }
      m[r][c] = v;
    }
  }
}

function qrPlaceAlignment(m, isFn, version, n) {
  const centers = QR_ALIGN[version] || [];
  const last = centers.length - 1;
  for (let a = 0; a < centers.length; a++) {
    for (let b = 0; b < centers.length; b++) {
      const cr = centers[a];
      const cc = centers[b];
      // 与三个定位图形重叠的角不画
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const r = cr + dr;
          const c = cc + dc;
          isFn[r][c] = true;
          m[r][c] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
        }
      }
    }
  }
}

function qrFormatBits(mask, level) {
  const data = (QR_EC_INDICATOR[level] << 3) | mask; // 5 位
  let d = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((d >> i) & 1) d ^= 0x537 << (i - 10);
  }
  return (((data << 10) | d) ^ 0x5412) & 0x7fff;
}

function qrMaskBit(mask, i, j) {
  switch (mask) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
  }
}

/**
 * 按指定掩码生成完整矩阵。
 * 0 = 浅色，1 = 深色。
 */
function qrComposeMatrix(version, codewords, mask, level) {
  const n = version * 4 + 17;
  const m = [];
  const isFn = [];
  for (let i = 0; i < n; i++) {
    m.push(new Array(n).fill(0));
    isFn.push(new Array(n).fill(false));
  }

  qrPlaceFinder(m, isFn, 0, 0, n);
  qrPlaceFinder(m, isFn, n - 7, 0, n);
  qrPlaceFinder(m, isFn, 0, n - 7, n);

  // 定时图形
  for (let c = 8; c < n - 8; c++) {
    if (!isFn[6][c]) { isFn[6][c] = true; m[6][c] = c % 2 === 0 ? 1 : 0; }
  }
  for (let r = 8; r < n - 8; r++) {
    if (!isFn[r][6]) { isFn[r][6] = true; m[r][6] = r % 2 === 0 ? 1 : 0; }
  }

  qrPlaceAlignment(m, isFn, version, n);

  // 预留格式信息区（先占位，最后再写值）
  for (let c = 0; c <= 8; c++) if (!isFn[8][c]) isFn[8][c] = true;
  for (let r = 0; r <= 8; r++) if (!isFn[r][8]) isFn[r][8] = true;
  for (let c = n - 8; c < n; c++) if (!isFn[8][c]) isFn[8][c] = true;
  for (let r = n - 7; r < n; r++) if (!isFn[r][8]) isFn[r][8] = true;
  isFn[n - 8][8] = true; // 固定深色模块

  if (version >= 7) {
    for (let r = 0; r < 6; r++) {
      for (let c = n - 11; c <= n - 9; c++) isFn[r][c] = true;
    }
    for (let r = n - 11; r <= n - 9; r++) {
      for (let c = 0; c < 6; c++) isFn[r][c] = true;
    }
  }

  // ---- 数据按之字形填入 ----
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // 跳过定时列
    for (let k = 0; k < n; k++) {
      const row = upward ? n - 1 - k : k;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (isFn[row][cc]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
        }
        bitIndex++;
        if (qrMaskBit(mask, row, cc)) bit ^= 1;
        m[row][cc] = bit;
      }
    }
    upward = !upward;
  }

  // ---- 格式信息 ----
  //
  // ⚠️ 布局极易写转置：这里 setFunctionModule 的语义是 (列, 行)，不是 (行, 列)。
  //    第一份横竖各一段（绕着左上定位图形），第二份分给另外两个角。
  //    写反了不会报错，只是**所有**版本、**所有**掩码都差那么几个模块。
  const fmt = qrFormatBits(mask, level);
  for (let i = 0; i <= 5; i++) m[i][8] = (fmt >> i) & 1;      // 列 8，行 0..5
  m[7][8] = (fmt >> 6) & 1;
  m[8][8] = (fmt >> 7) & 1;
  m[8][7] = (fmt >> 8) & 1;
  for (let i = 9; i <= 14; i++) m[8][14 - i] = (fmt >> i) & 1; // 行 8，列 5..0
  for (let i = 0; i <= 7; i++) m[8][n - 1 - i] = (fmt >> i) & 1;   // 行 8，列 n-1..n-8
  for (let i = 8; i <= 14; i++) m[n - 15 + i][8] = (fmt >> i) & 1; // 列 8，行 n-7..n-1

  // ---- 固定深色模块 ----
  m[n - 8][8] = 1;

  // ---- 版本信息（v7+） ----
  if (version >= 7) {
    const vi = QR_VERSION_INFO[version];
    for (let i = 0; i < 18; i++) {
      const bit = (vi >> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      m[n - 11 + c][r] = bit;
      m[r][n - 11 + c] = bit;
    }
  }

  return m;
}

/** 掩码罚分（4 条规则）。分数越低越好。 */
function qrPenalty(m) {
  const n = m.length;
  let score = 0;

  // 规则 1：行 / 列上连续同色 ≥5
  for (let i = 0; i < n; i++) {
    let rowRun = 1;
    let colRun = 1;
    for (let j = 1; j < n; j++) {
      if (m[i][j] === m[i][j - 1]) rowRun++;
      else { if (rowRun >= 5) score += 3 + (rowRun - 5); rowRun = 1; }
      if (m[j][i] === m[j - 1][i]) colRun++;
      else { if (colRun >= 5) score += 3 + (colRun - 5); colRun = 1; }
    }
    if (rowRun >= 5) score += 3 + (rowRun - 5);
    if (colRun >= 5) score += 3 + (colRun - 5);
  }

  // 规则 2：2×2 同色块
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
    }
  }

  // 规则 3：形似定位图形的 1:1:3:1:1 模式
  const patA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  function hit(get, start, pat) {
    for (let k = 0; k < 11; k++) if (get(start + k) !== pat[k]) return false;
    return true;
  }
  for (let i = 0; i < n; i++) {
    const rowGet = function (c) { return m[i][c]; };
    const colGet = function (r) { return m[r][i]; };
    for (let j = 0; j + 11 <= n; j++) {
      if (hit(rowGet, j, patA) || hit(rowGet, j, patB)) score += 40;
      if (hit(colGet, j, patA) || hit(colGet, j, patB)) score += 40;
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) if (m[i][j]) dark++;
  }
  const pct = (dark * 100) / (n * n);
  score += 10 * Math.floor(Math.abs(pct - 50) / 5);

  return score;
}

/* ---------------------------------------------------------------- PNG */

function qrAdler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib 包装：只用 stored（不压缩）块 —— 不需要实现 deflate，产物确定。 */
function qrZlibStored(raw) {
  const MAX = 65535;
  const parts = [];
  let off = 0;
  do {
    const len = Math.min(MAX, raw.length - off);
    const last = off + len >= raw.length ? 1 : 0;
    const head = new Uint8Array(5);
    head[0] = last;
    head[1] = len & 0xff;
    head[2] = (len >> 8) & 0xff;
    head[3] = (~len) & 0xff;
    head[4] = ((~len) >> 8) & 0xff;
    parts.push(head);
    if (len > 0) parts.push(raw.subarray(off, off + len));
    off += len;
  } while (off < raw.length);

  let size = 2 + 4;
  for (let i = 0; i < parts.length; i++) size += parts[i].length;

  const out = new Uint8Array(size);
  out[0] = 0x78;
  out[1] = 0x01;
  let p = 2;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], p);
    p += parts[i].length;
  }
  const ad = qrAdler32(raw);
  out[p] = (ad >>> 24) & 0xff;
  out[p + 1] = (ad >>> 16) & 0xff;
  out[p + 2] = (ad >>> 8) & 0xff;
  out[p + 3] = ad & 0xff;
  return out;
}

function qrPngChunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const c = crc32(out.subarray(4, 8 + len)) >>> 0;
  out[8 + len] = (c >>> 24) & 0xff;
  out[9 + len] = (c >>> 16) & 0xff;
  out[10 + len] = (c >>> 8) & 0xff;
  out[11 + len] = c & 0xff;
  return out;
}

/** 把 0/1 矩阵渲染成 1 位灰度 PNG 的 data URI。 */
function qrMatrixToPngDataUri(modules, scale, quiet) {
  const n = modules.length;
  const px = (n + quiet * 2) * scale;
  const rowBytes = Math.ceil(px / 8);
  const stride = rowBytes + 1; // 每行前面一个 filter 字节
  const raw = new Uint8Array(stride * px);

  // 底色全部填白（1 位 = 1）
  for (let y = 0; y < px; y++) {
    raw[y * stride] = 0; // filter: None
    const base = y * stride + 1;
    for (let b = 0; b < rowBytes; b++) raw[base + b] = 0xff;
  }
  // 深色模块画成黑（bit 0）
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      if (!modules[my][mx]) continue;
      const y0 = (my + quiet) * scale;
      const x0 = (mx + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const base = (y0 + dy) * stride + 1;
        for (let dx = 0; dx < scale; dx++) {
          const x = x0 + dx;
          raw[base + (x >> 3)] &= ~(0x80 >> (x & 7)) & 0xff;
        }
      }
    }
  }

  const ihdr = new Uint8Array(13);
  ihdr[0] = (px >>> 24) & 0xff; ihdr[1] = (px >>> 16) & 0xff;
  ihdr[2] = (px >>> 8) & 0xff; ihdr[3] = px & 0xff;
  ihdr[4] = (px >>> 24) & 0xff; ihdr[5] = (px >>> 16) & 0xff;
  ihdr[6] = (px >>> 8) & 0xff; ihdr[7] = px & 0xff;
  ihdr[8] = 1;  // bit depth
  ihdr[9] = 0;  // color type: 灰度
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    sig,
    qrPngChunk('IHDR', ihdr),
    qrPngChunk('IDAT', qrZlibStored(raw)),
    qrPngChunk('IEND', new Uint8Array(0))
  ];
  let total = 0;
  for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
  const png = new Uint8Array(total);
  let p = 0;
  for (let i = 0; i < chunks.length; i++) {
    png.set(chunks[i], p);
    p += chunks[i].length;
  }
  return 'data:image/png;base64,' + bytesToB64(png);
}

/* -------------------------------------------------------------- 对外接口 */

/**
 * 生成二维码矩阵。
 *
 * `forceMask` 传 0–7 可指定掩码 —— 只为和参考实现逐模块比对时用，
 * 正常调用不要传（让它自己选罚分最低的）。
 * `level` 是纠错等级 'M' / 'Q'，默认 'M'。
 */
function qrEncodeMatrix(text, forceMask, level) {
  const lv = qrLevel(level);
  const bytes = utf8Bytes(String(text));
  const version = qrPickVersion(bytes.length, lv);
  const codewords = qrCodewords(bytes, version, lv);

  if (forceMask !== undefined && forceMask !== null) {
    return {
      version: version,
      level: lv,
      size: version * 4 + 17,
      mask: forceMask,
      modules: qrComposeMatrix(version, codewords, forceMask, lv)
    };
  }

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = qrComposeMatrix(version, codewords, mask, lv);
    const score = qrPenalty(modules);
    if (!best || score < best.score) best = { score: score, mask: mask, modules: modules };
  }
  return {
    version: version,
    level: lv,
    size: version * 4 + 17,
    mask: best.mask,
    score: best.score,
    modules: best.modules
  };
}

/**
 * 一段文本 → `data:image/png;base64,...`（可直接丢给宿主的 `imageUrl`）。
 * 默认 4 像素/模块、静区 4 模块（标准要求）。
 */
function qrMakePngDataUri(text, scale, quiet, level) {
  const s = numOr(scale, 4);
  const q = quiet === undefined ? 4 : numOr(quiet, 4);
  const r = qrEncodeMatrix(text, null, level);
  return qrMatrixToPngDataUri(r.modules, s < 1 ? 1 : s, q < 0 ? 0 : q);
}
