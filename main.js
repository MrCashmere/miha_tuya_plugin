/* ============================================================================
 * 涂鸦（Tuya / Tuya Local）— miha 插件
 *
 * 本文件由 tools/build.js 从 src 下的模块拼接生成，**不要直接改这里**。
 * 要改就改 src/ 里对应的模块，然后重新跑：node tools/build.js
 *
 * 拼接顺序（按文件名排序）：
 *   - 00-util.js
 *   - 10-crypto.js
 *   - 20-lan.js
 *   - 30-cloud.js
 *   - 40-mapping.js
 *   - 50-plugin.js
 * ========================================================================== */

/* ---------- 00-util.js -------------------------------------------------- */
/* ============================================================================
 * §0  通用小工具
 *
 * 这个文件排在 `src/` 的最前面（构建脚本按文件名排序拼接），所以这里定义的
 * 函数对所有模块可见。
 *
 * ## 为什么需要 `isArray()` 而不是 `x instanceof Array`
 *
 * 沙箱里跑着不止一个 realm：插件自己的代码是一个 realm，而某些桥调用
 * （`JSON.parse` 的结果、宿主推回来的对象）可能来自另一个。`instanceof`
 * 是**跨 realm 不可靠**的 —— `[] instanceof Array` 在别的 realm 里就是 false，
 * 于是「明明传进来一个数组，代码却当它不是数组」，静默走空分支。
 *
 * 这类 bug 的麻烦之处在于：**它不抛错**，只是功能整个消失。
 * 所以凡是判断数组/对象的地方，一律走这里的工具函数。
 * ========================================================================== */

/** 是不是数组（跨 realm 安全）。 */
function isArray(x) {
  return Object.prototype.toString.call(x) === '[object Array]';
}

/** 是不是普通对象（跨 realm 安全；数组、null、函数都不算）。 */
function isPlainObject(x) {
  if (x === null || typeof x !== 'object') return false;
  return Object.prototype.toString.call(x) === '[object Object]';
}

/** 取数组；不是数组就给空数组。避免满屏的三元表达式。 */
function asArray(x) {
  if (isArray(x)) return x;
  if (x === undefined || x === null) return [];
  return [x];
}

/** 字符串取值 + 去空白；null/undefined 变成空串。 */
function strOf(x) {
  if (x === undefined || x === null) return '';
  return String(x).trim();
}

/** 数字取值；转不出来或 NaN 时用默认值。 */
function numOr(x, fallback) {
  const n = Number(x);
  if (isNaN(n) || !isFinite(n)) return fallback;
  return n;
}

/** 夹取整数到 [lo, hi]。 */
function clamp(n, lo, hi) {
  const v = numOr(n, lo);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** 极简日志：宿主日志不可用时吞掉异常，绝不因为打日志把主流程弄挂。 */
function safeLog(level, tag, msg) {
  try {
    if (Host && Host.log && typeof Host.log[level] === 'function') {
      const p = Host.log[level](tag, msg);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }
  } catch (e) {
    // 日志失败不影响业务
  }
}

/* ---------- 10-crypto.js ------------------------------------------------ */
/* ============================================================================
 * §1  字节工具
 *
 * 沙箱里**没有** TextEncoder / TextDecoder（见开发指南 §12.1 的警告），
 * 也没有 Node 的 Buffer，所以 UTF-8 编解码必须自己写。
 * 二进制 ↔ 字符串一律走 btoa / atob，且只在「已经确定是文本」的地方使用。
 * ========================================================================== */

/** 把字符串按 UTF-8 编成字节。代理对（emoji）也要对。 */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      // 高位代理：和下一个低位代理合成一个码点
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
        i++;
        continue;
      }
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** UTF-8 字节还原成字符串。解不出来的字节用 U+FFFD 顶替，不抛错。 */
function bytesUtf8(bytes) {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      s += String.fromCharCode(b);
      i += 1;
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      s += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else if (b >= 0xf0 && i + 3 < bytes.length) {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const v = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    } else {
      s += '\ufffd';
      i += 1;
    }
  }
  return s;
}

/** 涂鸦的 localKey 是 16 个 ASCII 字符，按 latin1（低字节）取。 */
function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function bytesConcat(parts) {
  let n = 0;
  for (let i = 0; i < parts.length; i++) n += parts[i].length;
  const out = new Uint8Array(n);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], off);
    off += parts[i].length;
  }
  return out;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return s;
}

function hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/* ============================================================================
 * §2  MD5
 *
 * 涂鸦只在一处用到 MD5：v3.1 的 payload 前缀（`data=..||lpv=3.1||localKey`），
 * 以及 UDP 广播的固定密钥 md5("yGAdlopoPVldABfn")。
 * 自实现是因为 Host.crypto 只有 sha1 / sha256 / hmac-sha1。
 * ========================================================================== */

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
];

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

function rotl32(x, c) {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** 返回 MD5 摘要的字节（16 字节）。 */
function md5Bytes(data) {
  const msgLen = data.length;
  // 补位：0x80 + 若干 0，使总长 ≡ 56 (mod 64)，末尾 8 字节小端位长
  const withPad = new Uint8Array((((msgLen + 8) >> 6) + 1) << 6);
  withPad.set(data);
  withPad[msgLen] = 0x80;
  const bitLenLo = (msgLen * 8) >>> 0;
  const bitLenHi = Math.floor((msgLen * 8) / 4294967296) >>> 0;
  const tail = withPad.length - 8;
  withPad[tail] = bitLenLo & 0xff;
  withPad[tail + 1] = (bitLenLo >>> 8) & 0xff;
  withPad[tail + 2] = (bitLenLo >>> 16) & 0xff;
  withPad[tail + 3] = (bitLenLo >>> 24) & 0xff;
  withPad[tail + 4] = bitLenHi & 0xff;
  withPad[tail + 5] = (bitLenHi >>> 8) & 0xff;
  withPad[tail + 6] = (bitLenHi >>> 16) & 0xff;
  withPad[tail + 7] = (bitLenHi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4;
      m[i] =
        (withPad[p] |
          (withPad[p + 1] << 8) |
          (withPad[p + 2] << 16) |
          (withPad[p + 3] << 24)) >>>
        0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl32(f, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

function md5Hex(data) {
  return bytesToHex(md5Bytes(data));
}

/* ============================================================================
 * §3  SHA-256 + HMAC-SHA256
 *
 * 两处需要：涂鸦云 OpenAPI 的请求签名，以及 v3.4/3.5 帧尾的 HMAC 校验。
 * Host.crypto 有 sha256Hex，但**没有 hmac-sha256** —— 而签名要的正是
 * HMAC-SHA256，所以连 SHA-256 一起自己实现，避免两套语义混用。
 * ========================================================================== */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr32(x, c) {
  return ((x >>> c) | (x << (32 - c))) >>> 0;
}

/** 返回 SHA-256 摘要的字节（32 字节）。 */
function sha256Bytes(data) {
  const msgLen = data.length;
  const withPad = new Uint8Array((((msgLen + 8) >> 6) + 1) << 6);
  withPad.set(data);
  withPad[msgLen] = 0x80;
  const bitLenLo = (msgLen * 8) >>> 0;
  const bitLenHi = Math.floor((msgLen * 8) / 4294967296) >>> 0;
  const tail = withPad.length - 8;
  // SHA-256 的长度是**大端**
  withPad[tail] = (bitLenHi >>> 24) & 0xff;
  withPad[tail + 1] = (bitLenHi >>> 16) & 0xff;
  withPad[tail + 2] = (bitLenHi >>> 8) & 0xff;
  withPad[tail + 3] = bitLenHi & 0xff;
  withPad[tail + 4] = (bitLenLo >>> 24) & 0xff;
  withPad[tail + 5] = (bitLenLo >>> 16) & 0xff;
  withPad[tail + 6] = (bitLenLo >>> 8) & 0xff;
  withPad[tail + 7] = bitLenLo & 0xff;

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4;
      w[i] =
        ((withPad[p] << 24) |
          (withPad[p + 1] << 16) |
          (withPad[p + 2] << 8) |
          withPad[p + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

function sha256Hex(data) {
  return bytesToHex(sha256Bytes(data));
}

/** HMAC-SHA256，返回原始字节。key / msg 都是字节。 */
function hmacSha256Bytes(keyBytes, msgBytes) {
  let key = keyBytes;
  if (key.length > 64) key = sha256Bytes(key);
  const padded = new Uint8Array(64);
  padded.set(key);

  const ipad = new Uint8Array(64 + msgBytes.length);
  const opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    ipad[i] = padded[i] ^ 0x36;
    opad[i] = padded[i] ^ 0x5c;
  }
  ipad.set(msgBytes, 64);
  opad.set(sha256Bytes(ipad), 64);
  return sha256Bytes(opad);
}

/* ============================================================================
 * §4  CRC32
 *
 * v3.1 ~ v3.4 的 55AA 帧尾校验。注意与 zlib 的 crc32 同源（标准反射多项式
 * 0xEDB88320），初值 0xFFFFFFFF、结果再取反 —— 用逐位算法，不查表，
 * 因为这里每帧只算一次，表反而占体积。
 * ========================================================================== */

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ============================================================================
 * §5  AES-128
 *
 * 涂鸦的局域网 payload 全部用 AES-128：
 *   - v3.1 / v3.2 / v3.3：AES-128-**ECB**，PKCS#7 填充
 *   - v3.4：同上，但 key 换成会话密钥，帧尾校验改成 HMAC-SHA256
 *   - v3.5：AES-128-**GCM**（见 §6）
 * 鸿蒙的系统加密库不暴露给沙箱（且 Host.crypto 也没有对称加密），
 * 所以这里自实现。数据量只有几百字节，性能不是问题。
 * ========================================================================== */

const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
]);

const AES_INV_SBOX = new Uint8Array([
  0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
  0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
  0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
  0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
  0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
  0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
  0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
  0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
  0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
  0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
  0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
  0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
  0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
  0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
  0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
  0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d
]);

const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(x) {
  return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
}

function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

/** 生成 AES-128 的 11 组轮密钥，每组 16 字节。 */
function aesExpandKey(key) {
  const roundKeys = new Uint8Array(176);
  roundKeys.set(key);
  let bytesGenerated = 16;
  let rconIter = 0;
  const t = new Uint8Array(4);
  while (bytesGenerated < 176) {
    for (let i = 0; i < 4; i++) t[i] = roundKeys[bytesGenerated - 4 + i];
    if (bytesGenerated % 16 === 0) {
      // RotWord + SubWord + Rcon
      const tmp = t[0];
      t[0] = AES_SBOX[t[1]] ^ AES_RCON[rconIter++];
      t[1] = AES_SBOX[t[2]];
      t[2] = AES_SBOX[t[3]];
      t[3] = AES_SBOX[tmp];
    }
    for (let i = 0; i < 4; i++) {
      roundKeys[bytesGenerated] = roundKeys[bytesGenerated - 16] ^ t[i];
      bytesGenerated++;
    }
  }
  return roundKeys;
}

function aesAddRoundKey(state, rk, round) {
  const off = round * 16;
  for (let i = 0; i < 16; i++) state[i] ^= rk[off + i];
}

function aesSubBytes(state, box) {
  for (let i = 0; i < 16; i++) state[i] = box[state[i]];
}

function aesShiftRows(state) {
  let t;
  t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
  t = state[2]; state[2] = state[10]; state[10] = t;
  t = state[6]; state[6] = state[14]; state[14] = t;
  t = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t;
}

function aesInvShiftRows(state) {
  let t;
  t = state[13]; state[13] = state[9]; state[9] = state[5]; state[5] = state[1]; state[1] = t;
  t = state[2]; state[2] = state[10]; state[10] = t;
  t = state[6]; state[6] = state[14]; state[14] = t;
  t = state[3]; state[3] = state[7]; state[7] = state[11]; state[11] = state[15]; state[15] = t;
}

function aesMixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];
    state[i] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    state[i + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    state[i + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    state[i + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}

function aesInvMixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];
    state[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    state[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    state[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    state[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

/** 单块 AES-128 加密：输入输出都是 16 字节。 */
function aesEncryptBlock(block, rk) {
  const state = new Uint8Array(block);
  aesAddRoundKey(state, rk, 0);
  for (let round = 1; round <= 10; round++) {
    aesSubBytes(state, AES_SBOX);
    aesShiftRows(state);
    if (round !== 10) aesMixColumns(state);
    aesAddRoundKey(state, rk, round);
  }
  return state;
}

/** 单块 AES-128 解密：输入输出都是 16 字节。 */
function aesDecryptBlock(block, rk) {
  const state = new Uint8Array(block);
  aesAddRoundKey(state, rk, 10);
  for (let round = 9; round >= 0; round--) {
    aesInvShiftRows(state);
    aesSubBytes(state, AES_INV_SBOX);
    aesAddRoundKey(state, rk, round);
    if (round !== 0) aesInvMixColumns(state);
  }
  return state;
}

function pkcs7Pad(data, blockSize) {
  const padLen = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  out.fill(padLen, data.length);
  return out;
}

function pkcs7Unpad(data) {
  if (data.length === 0) return data;
  let padLen = data[data.length - 1];
  // 填充字节必须是 1..16 且整段一致，否则按「没有填充」处理
  if (padLen < 1 || padLen > 16 || padLen > data.length) return data;
  for (let i = data.length - padLen; i < data.length; i++) {
    if (data[i] !== padLen) return data;
  }
  return data.subarray(0, data.length - padLen);
}

/**
 * AES-128-ECB 加密（带 PKCS#7 填充）。
 * 涂鸦从不用多块密钥，`key` 恒为 16 字节。
 */
function aesEcbEncrypt(key, plain, noPad) {
  const rk = aesExpandKey(key);
  const input = noPad ? plain : pkcs7Pad(plain, 16);
  if (input.length % 16 !== 0) {
    throw new Error('AES-ECB 输入必须按 16 字节对齐');
  }
  const out = new Uint8Array(input.length);
  for (let off = 0; off < input.length; off += 16) {
    out.set(aesEncryptBlock(input.subarray(off, off + 16), rk), off);
  }
  return out;
}

function aesEcbDecrypt(key, cipher, noUnpad) {
  const rk = aesExpandKey(key);
  if (cipher.length % 16 !== 0) {
    throw new Error('AES-ECB 密文长度必须是 16 的倍数（实际 ' + cipher.length + '）');
  }
  const out = new Uint8Array(cipher.length);
  for (let off = 0; off < cipher.length; off += 16) {
    out.set(aesDecryptBlock(cipher.subarray(off, off + 16), rk), off);
  }
  return noUnpad ? out : pkcs7Unpad(out);
}

/**
 * 计数器模式的分组异或：把 `stream` 作为密钥流，与 `data` 异或。
 * GCM 的加解密都是这个操作（GCM 只用 CTR 的加密方向）。
 */
function xorWithKeystream(rk, iv, data, startCounter) {
  const out = new Uint8Array(data.length);
  const counter = new Uint8Array(iv);
  let ctr = startCounter >>> 0;
  for (let off = 0; off < data.length; off += 16) {
    // counter 是 32 位大端，放在最后 4 字节
    counter[12] = (ctr >>> 24) & 0xff;
    counter[13] = (ctr >>> 16) & 0xff;
    counter[14] = (ctr >>> 8) & 0xff;
    counter[15] = ctr & 0xff;
    const ks = aesEncryptBlock(counter, rk);
    const n = Math.min(16, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
    ctr = (ctr + 1) >>> 0;
  }
  return out;
}

/* ============================================================================
 * §6  AES-128-GCM
 *
 * 只有 v3.5 用（6699 帧）。iv 是 12 字节、tag 16 字节，AAD 是帧头。
 * 数据量极小（一帧几百字节），GHASH 用逐位乘法实现即可 —— 这里**不追求
 * 速度**，追求的是「和 tinytuya / OpenSSL 逐字节一致」，所以照标准写。
 * ========================================================================== */

/** GF(2^128) 乘法：x · y，约定用 GCM 的位序（左移、MSB 溢出时异或 R）。 */
function ghashMul(x, y) {
  const z = new Uint8Array(16);
  const v = new Uint8Array(y);
  for (let i = 0; i < 128; i++) {
    const byteIdx = i >> 3;
    const bitIdx = 7 - (i & 7);
    if ((x[byteIdx] >> bitIdx) & 1) {
      for (let j = 0; j < 16; j++) z[j] ^= v[j];
    }
    const lsb = v[15] & 1;
    // v >>= 1
    for (let j = 15; j > 0; j--) {
      v[j] = ((v[j] >>> 1) | ((v[j - 1] & 1) << 7)) & 0xff;
    }
    v[0] = v[0] >>> 1;
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}

/** GHASH：对 AAD 和密文分块，最后附加长度块。 */
function ghash(h, aad, cipher) {
  let y = new Uint8Array(16);

  function absorb(data) {
    for (let off = 0; off < data.length; off += 16) {
      const block = new Uint8Array(16);
      block.set(data.subarray(off, Math.min(off + 16, data.length)));
      for (let i = 0; i < 16; i++) y[i] ^= block[i];
      y = ghashMul(y, h);
    }
  }

  absorb(aad);
  absorb(cipher);

  const lenBlock = new Uint8Array(16);
  const aadBits = aad.length * 8;
  const cipherBits = cipher.length * 8;
  // 两个 64 位大端长度：AAD 长度在前，密文长度在后
  lenBlock[4] = (aadBits >>> 24) & 0xff;
  lenBlock[5] = (aadBits >>> 16) & 0xff;
  lenBlock[6] = (aadBits >>> 8) & 0xff;
  lenBlock[7] = aadBits & 0xff;
  lenBlock[12] = (cipherBits >>> 24) & 0xff;
  lenBlock[13] = (cipherBits >>> 16) & 0xff;
  lenBlock[14] = (cipherBits >>> 8) & 0xff;
  lenBlock[15] = cipherBits & 0xff;
  for (let i = 0; i < 16; i++) y[i] ^= lenBlock[i];
  y = ghashMul(y, h);

  return y;
}

/**
 * AES-128-GCM 加密。
 * 返回 { cipher, tag }；AAD 参与 tag 计算但不加密。
 */
function aesGcmEncrypt(key, iv, aad, plain) {
  const rk = aesExpandKey(key);
  const h = aesEncryptBlock(new Uint8Array(16), rk);

  // J0 = IV || 0x00000001（IV 固定 12 字节）
  const j0 = new Uint8Array(16);
  j0.set(iv.subarray(0, 12));
  j0[15] = 1;

  const cipher = xorWithKeystream(rk, j0, plain, 2);

  const s = ghash(h, aad, cipher);
  const ek = aesEncryptBlock(j0, rk);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = s[i] ^ ek[i];

  return { cipher: cipher, tag: tag };
}

/**
 * AES-128-GCM 解密。tag 不匹配时抛错（调用方据此判定密钥/版本不对）。
 */
function aesGcmDecrypt(key, iv, aad, cipher, tag) {
  const rk = aesExpandKey(key);
  const h = aesEncryptBlock(new Uint8Array(16), rk);

  const j0 = new Uint8Array(16);
  j0.set(iv.subarray(0, 12));
  j0[15] = 1;

  const s = ghash(h, aad, cipher);
  const ek = aesEncryptBlock(j0, rk);
  const expect = new Uint8Array(16);
  for (let i = 0; i < 16; i++) expect[i] = s[i] ^ ek[i];

  if (!bytesEqual(expect, tag)) {
    throw new Error('GCM tag 校验失败（localKey 或协议版本不对）');
  }
  return xorWithKeystream(rk, j0, cipher, 2);
}

/**
 * GCM 的 CTR 加密（**不做 tag 校验**），用于 v3.5 会话密钥派生。
 * tinytuya 用 `cipher.encrypt(data, iv=local_nonce[:12])[12:28]` 取派生后的
 * 会话密钥：密文的前 12 字节是 IV 本身，所以真正要用的是第 12~28 字节。
 */
function aesGcmCtrEncrypt(key, iv, plain) {
  const rk = aesExpandKey(key);
  const j0 = new Uint8Array(16);
  j0.set(iv.subarray(0, 12));
  j0[15] = 1;
  return xorWithKeystream(rk, j0, plain, 2);
}

/* ---------- 20-lan.js --------------------------------------------------- */
/* ============================================================================
 * §7  涂鸦局域网协议
 *
 * 帧格式、加密方式、密钥协商全部对照 tinytuya 1.20.0 的实现逐行翻译
 * （tinytuya/core/{message_helper,header,XenonDevice,udp_helper}.py）。
 * 与 Python 版的唯一结构性差异：Python 用阻塞 socket，这里必须改成
 * 「回调攒缓冲 + Promise 结算」—— 因为 Host.tcp 只给 onMessage 回调。
 *
 * 协议速览（按版本）：
 * ┌──────┬────────┬──────────────┬───────────────────────────────────────┐
 * │ 版本 │ 帧     │ AES 模式     │ payload 布局（发送方向）              │
 * ├──────┼────────┼──────────────┼───────────────────────────────────────┤
 * │ 3.1  │ 55AA   │ ECB          │ "3.1" + md5hex[8:24] + b64(AES(json)) │
 * │ 3.2  │ 55AA   │ ECB          │ "3.2"+12*0x00 + AES(json)             │
 * │ 3.3  │ 55AA   │ ECB          │ "3.3"+12*0x00 + AES(json)             │
 * │ 3.4  │ 55AA   │ ECB          │ AES("3.4"+12*0x00 + json)             │
 * │ 3.5  │ 6699   │ GCM          │ GCM("3.5"+12*0x00 + json), AAD=帧头   │
 * └──────┴────────┴──────────────┴───────────────────────────────────────┘
 *
 * ⚠️ 3.3 的版本头在**密文外面**，3.4 的在**密文里面** —— 这一处差异极易写反，
 *    写反的表现是「连上了但对任何命令都不回」（设备静默丢弃）。
 * ⚠️ 3.4 / 3.5 连上后必须先做三次握手的会话密钥协商，否则发的都是废包。
 * ========================================================================== */

const TUYA_TCP_PORT = 6668;
const TUYA_UDP_PORT_31 = 6666;
const TUYA_UDP_PORT_33 = 6667;
const TUYA_UDP_PORT_APP = 7000;

/** UDP 广播的固定密钥，涂鸦全家通用（谁都能算出来，不是安全边界）。 */
const TUYA_UDP_KEY = md5Bytes(latin1Bytes('yGAdlopoPVldABfn'));

/** 命令字，数值与 tuya 的 lan_protocol.h 一致。 */
const TCMD = {
  SESS_KEY_NEG_START: 3,
  SESS_KEY_NEG_RESP: 4,
  SESS_KEY_NEG_FINISH: 5,
  CONTROL: 7,
  STATUS: 8,
  HEART_BEAT: 9,
  DP_QUERY: 10,
  CONTROL_NEW: 13,
  DP_QUERY_NEW: 16,
  UPDATEDPS: 18,
  REQ_DEVINFO: 0x25,
  LAN_EXT_STREAM: 0x40
};

/**
 * 这些命令**不带**版本头（3.2~3.5 都一样）。
 * 顺序照抄 tinytuya 的 NO_PROTOCOL_HEADER_CMDS，别自己增删。
 */
const NO_PROTOCOL_HEADER_CMDS = [
  TCMD.DP_QUERY,
  TCMD.DP_QUERY_NEW,
  TCMD.UPDATEDPS,
  TCMD.HEART_BEAT,
  TCMD.SESS_KEY_NEG_START,
  TCMD.SESS_KEY_NEG_RESP,
  TCMD.SESS_KEY_NEG_FINISH,
  TCMD.LAN_EXT_STREAM
];

const PREFIX_55AA = new Uint8Array([0x00, 0x00, 0x55, 0xaa]);
const SUFFIX_55AA = new Uint8Array([0x00, 0x00, 0xaa, 0x55]);
const PREFIX_6699 = new Uint8Array([0x00, 0x00, 0x66, 0x99]);
const SUFFIX_6699 = new Uint8Array([0x00, 0x00, 0x99, 0x66]);

function u32be(value) {
  const v = value >>> 0;
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function u16be(value) {
  const v = value & 0xffff;
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}

function readU32be(bytes, off) {
  return (
    ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
  );
}

/**
 * 版本号 → 版本头：`"3.3"` + 12 个 0x00。
 *
 * ⚠️ 是 **15 字节**（3 + 12），不是 16 —— 很多第三方文档写成 16 字节，
 * 那样整段 payload 会错位，设备直接静默丢包。以 tinytuya 的
 * `PROTOCOL_3x_HEADER = 12 * b"\x00"` 为准。
 */
function versionHeader(version) {
  const v = String(version);
  const head = new Uint8Array(v.length + 12);
  for (let i = 0; i < v.length; i++) head[i] = v.charCodeAt(i);
  return head;
}

function versionBytes(version) {
  return latin1Bytes(String(version));
}

/* ---------------------------------------------------------------------------
 * 7.1  帧的打包 / 解析
 * ------------------------------------------------------------------------- */

/**
 * 打一个 55AA 帧（v3.1 ~ v3.4）。
 * 帧尾校验按版本二选一：v3.4 用 HMAC-SHA256（**32 字节**），其余用 CRC32（4 字节）。
 * 所以 length 字段的增量也跟着变（36 或 8）—— 这一处算错设备会直接丢包。
 */
function pack55aa(seqno, cmd, payload, hmacKey) {
  const tailLen = hmacKey ? 36 : 8; // 校验 + 结尾标志
  const head = bytesConcat([
    u32be(seqno),
    u32be(cmd),
    u32be(payload.length + tailLen)
  ]);
  const body = bytesConcat([PREFIX_55AA, head, payload]);
  const check = hmacKey ? hmacSha256Bytes(hmacKey, body) : u32be(crc32(body));
  return bytesConcat([body, check, SUFFIX_55AA]);
}

/**
 * 打一个 6699 帧（v3.5，AES-GCM）。
 *
 * ⚠️ 帧头是 **18 字节**，不是 20：tinytuya 的格式串是 `">IHIII"`，
 *    那个 `H` 是 **2 字节**的 unsigned short（很容易看成第 5 个 I）。
 *    于是 AAD（帧头第 4 字节起）是 **14 字节**。
 *
 * `ivOverride` 只为自检留口子（正常流程用随机 IV）。
 */
function pack6699(seqno, cmd, plain, key, ivOverride) {
  const iv = ivOverride || randomBytesOrPseudo(12);
  const length = plain.length + 28; // 12(iv) + 16(tag)，与 tinytuya 的算法一致
  const aad = bytesConcat([u16be(0), u32be(seqno), u32be(cmd), u32be(length)]);
  const gcm = aesGcmEncrypt(key, iv, aad, plain);
  return bytesConcat([
    PREFIX_6699,
    aad,
    iv,
    gcm.cipher,
    gcm.tag,
    SUFFIX_6699
  ]);
}

/**
 * 从缓冲区头部尝试切出一个完整帧。
 * 返回 { frame, rest, kind } 或 null（数据还不够一帧）。
 * TCP 会任意切包粘包，所以必须按声明长度攒够再切。
 */
function tryExtractFrame(buf) {
  if (buf.length < 16) return null;
  const prefix = readU32be(buf, 0);

  if (prefix === 0x000055aa) {
    const length = readU32be(buf, 12);
    // 防御：损坏的流可能声明一个离谱的长度，直接判定为坏包
    if (length > 65535) return { bad: true, rest: buf.subarray(4) };
    const total = 16 + length;
    if (buf.length < total) return null;
    return { frame: buf.subarray(0, total), rest: buf.subarray(total), kind: '55aa', length: length };
  }

  if (prefix === 0x00006699) {
    if (buf.length < 18) return null;
    const length = readU32be(buf, 14);
    if (length > 65535) return { bad: true, rest: buf.subarray(4) };
    const total = 18 + length + 4; // 18 字节帧头 + payload + 4 字节结尾
    if (buf.length < total) return null;
    return { frame: buf.subarray(0, total), rest: buf.subarray(total), kind: '6699', length: length };
  }

  // 前缀对不上：往后找一个可能的前缀，或者丢掉 1 字节重新同步
  const next = findPrefixOffset(buf, 1);
  return { bad: true, rest: next < 0 ? buf.subarray(1) : buf.subarray(next) };
}

function findPrefixOffset(buf, from) {
  for (let i = from; i + 4 <= buf.length; i++) {
    if (
      (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0x55 && buf[i + 3] === 0xaa) ||
      (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0x66 && buf[i + 3] === 0x99)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * 解一个 55AA 帧 → { seqno, cmd, retcode, payload(密文), crcOk }
 * 只做结构切分和校验，不做解密。
 */
function unpack55aa(frame, hmacKey) {
  const length = readU32be(frame, 12);
  const seqno = readU32be(frame, 4);
  const cmd = readU32be(frame, 8);
  const bodyEnd = 16 + length;
  const checkLen = hmacKey ? 32 : 4;
  const tailLen = checkLen + 4; // 校验 + 结尾标志
  const retcode = readU32be(frame, 16);
  const payload = frame.subarray(20, bodyEnd - tailLen); // 跳过 retcode，去掉校验+结尾
  const signed = frame.subarray(0, bodyEnd - tailLen);
  let crcOk = false;
  if (hmacKey) {
    crcOk = bytesEqual(
      hmacSha256Bytes(hmacKey, signed),
      frame.subarray(bodyEnd - tailLen, bodyEnd - 4)
    );
  } else {
    crcOk = readU32be(frame, bodyEnd - tailLen) === crc32(signed);
  }

  return { seqno: seqno, cmd: cmd, retcode: retcode, payload: payload, crcOk: crcOk };
}

/**
 * 解一个 6699 帧（v3.5，AES-GCM）→ { seqno, cmd, retcode, payload(明文), crcOk }
 * 解密在这里就完成，因为 GCM 需要 AAD（帧头）和 tag。
 */
function unpack6699(frame, key) {
  const seqno = readU32be(frame, 6);
  const cmd = readU32be(frame, 10);
  const aad = frame.subarray(4, 18); // 14 字节
  const body = frame.subarray(18, frame.length - 4);
  if (body.length < 28) {
    return { seqno: seqno, cmd: cmd, retcode: 0, payload: new Uint8Array(0), crcOk: false };
  }
  const iv = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const cipher = body.subarray(12, body.length - 16);

  try {
    const plain = aesGcmDecrypt(key, iv, aad, cipher, tag);
    return splitRetcode(seqno, cmd, plain, true);
  } catch (e) {
    return { seqno: seqno, cmd: cmd, retcode: 0, payload: new Uint8Array(0), crcOk: false };
  }
}

/**
 * v3.5 的明文前面可能有 4 字节 retcode，也可能没有 —— tinytuya 在协议演进中
 * 对这一点前后不一致（老代码 `no_retcode=None` 会猜，新代码恒剥 4 字节）。
 * 所以我们**不猜**：把整段明文交给 `findJsonInBytes`，它按内容定位 `{`，
 * 有没有 retcode 都能解出来。
 */
function splitRetcode(seqno, cmd, plain, crcOk) {
  return { seqno: seqno, cmd: cmd, retcode: 0, payload: plain, crcOk: crcOk };
}

/* ---------------------------------------------------------------------------
 * 7.2  payload 的编码 / 解码（按版本分支）
 * ------------------------------------------------------------------------- */

/**
 * 构造并加密发送方向的 payload。
 * 返回 { cmd, body }：cmd 可能被改写（v3.4/3.5 把 CONTROL 换成 CONTROL_NEW）。
 */
function encodeRequest(version, cmd, jsonText, key) {
  const plain = utf8Bytes(jsonText);
  const v = Number(version);
  let actualCmd = cmd;
  let body;

  if (v >= 3.4) {
    if (cmd === TCMD.CONTROL) actualCmd = TCMD.CONTROL_NEW;
    if (cmd === TCMD.DP_QUERY) actualCmd = TCMD.DP_QUERY_NEW;

    const withHeader = NO_PROTOCOL_HEADER_CMDS.indexOf(actualCmd) < 0
      ? bytesConcat([versionHeader(version), plain])
      : plain;

    if (v >= 3.5) {
      body = withHeader; // GCM 在 pack6699 里做
    } else {
      body = aesEcbEncrypt(key, withHeader, false);
    }
  } else if (v >= 3.2) {
    body = aesEcbEncrypt(key, plain, false);
    if (NO_PROTOCOL_HEADER_CMDS.indexOf(cmd) < 0) {
      body = bytesConcat([versionHeader(version), body]); // 头在**密文外面**
    }
  } else {
    // v3.1：base64 密文 + "3.1" + md5 摘要片段
    body = utf8Bytes(bytesToB64(aesEcbEncrypt(key, plain, false)));
    const pre = bytesConcat([
      utf8Bytes('data='),
      body,
      utf8Bytes('||lpv=3.1||'),
      key
    ]);
    const digest = md5Hex(pre);
    body = bytesConcat([versionBytes(version), utf8Bytes(digest.substring(8, 24)), body]);
  }

  return { cmd: actualCmd, body: body };
}

/**
 * 解密接收方向的 payload（55AA 帧）。
 * 3.4 需要先整体解密，再把版本头脱掉；3.2/3.3 是「先脱头、再解密」。
 */
function decodeResponse(version, payload, key) {
  const v = Number(version);
  let data = payload;

  if (v === 3.4) {
    // 3.4 把版本头也加密了，所以整体先解一次
    try {
      data = aesEcbDecrypt(key, data, true);
    } catch (e) {
      return null;
    }
  }

  if (startsWithBytes(data, versionBytes(3.1))) {
    // v3.1：砍掉 "3.1"，再砍掉 16 字节 md5 片段，剩下是 base64
    const rest = data.subarray(19);
    try {
      data = aesEcbDecrypt(key, b64ToBytes(bytesUtf8(rest)), false);
    } catch (e) {
      return null;
    }
  } else if (v >= 3.2) {
    if (startsWithBytes(data, versionBytes(version))) {
      data = data.subarray(versionHeader(version).length); // 去掉 15 字节版本头
    }
    if (v < 3.4) {
      try {
        data = aesEcbDecrypt(key, data, false);
      } catch (e) {
        return null;
      }
    }
  } else if (data[0] !== 0x7b) {
    return null; // v3.1 的响应不是 JSON 也不是已知形态
  }

  return findJsonInBytes(data);
}

/**
 * 从一段字节里揪出 JSON 对象。
 *
 * 为什么不像 tinytuya 那样「固定剥 4 字节 retcode」：不同固件在明文前带的
 * 前缀不一样（有的带 retcode、有的带版本头、有的什么都不带），按固定偏移
 * 切迟早会在某个型号上错位。改成扫描第一个 `{` —— 三种形态通吃。
 */
function findJsonInBytes(bytes) {
  if (!bytes || bytes.length === 0) return null;
  let start = -1;
  const limit = Math.min(bytes.length, 48);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x7b /* '{' */) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const text = bytesUtf8(bytes.subarray(start)).replace(/\u0000+$/, '').trim();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    // 有些固件在 JSON 后面补了调试信息，截到最后一个 } 再试
    const end = text.lastIndexOf('}');
    if (end > 0) {
      try {
        return JSON.parse(text.substring(0, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function startsWithBytes(data, prefix) {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

/* ---------------------------------------------------------------------------
 * 7.3  随机数
 * ------------------------------------------------------------------------- */

/**
 * 优先用宿主的原生随机数（crypto 权限）；拿不到就退回 Math.random。
 * 会话 nonce 的随机性只影响「同一设备两次连接的会话密钥是否相同」，
 * 退回伪随机在局域网场景下仍然可用，不会像网上说的那样直接失败。
 */
let cryptoOk = true;
async function randomBytesOrPseudoAsync(n) {
  if (cryptoOk) {
    try {
      const b64 = await Host.crypto.randomBytes(n);
      const bytes = b64ToBytes(String(b64));
      if (bytes.length >= n) return bytes.subarray(0, n);
    } catch (e) {
      cryptoOk = false;
    }
  }
  return pseudoRandomBytes(n);
}

function pseudoRandomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(Math.random() * 256) & 0xff;
  }
  return out;
}

/** 同步版本的随机数：给 pack6699 用（那里没有 await 的机会）。 */
function randomBytesOrPseudo(n) {
  if (cryptoOk && lastCryptoRandom && lastCryptoRandom.length >= n) {
    const out = lastCryptoRandom.subarray(0, n);
    lastCryptoRandom = lastCryptoRandom.subarray(n);
    return out;
  }
  return pseudoRandomBytes(n);
}

/** 原生随机数的本地储备池，由 async 版本按需续杯。 */
let lastCryptoRandom = new Uint8Array(0);

async function refillRandomPool() {
  if (!cryptoOk) return;
  try {
    const b64 = await Host.crypto.randomBytes(32);
    const bytes = b64ToBytes(String(b64));
    if (bytes.length >= 16) lastCryptoRandom = bytes;
  } catch (e) {
    cryptoOk = false;
  }
}

/* ---------------------------------------------------------------------------
 * 7.4  一个设备 = 一条 TCP 连接 + 一次会话
 *
 * 设计取舍：**一次请求开一条连接，用完就关**。
 * 这样插件里不存在「跨调用存活的 socket 状态」，宿主重建沙箱时不会留下
 * 半死不活的连接（开发指南 §4.1.8 提醒过：重建后回调注册表会清空）。
 * 代价是 v3.4/3.5 每次都要重做三次握手，局域网内也就几百毫秒。
 * ------------------------------------------------------------------------- */

let seqCounter = 1;

class TuyaLanDevice {
  constructor(did, ip, localKey, version) {
    this.did = String(did);
    this.ip = String(ip);
    this.localKey = String(localKey);
    this.version = Number(version) || 3.3;
    this.lastError = '';
    /** 最近一次成功读到的 DP 快照，供「读属性」时兜底 */
    this.dps = {};
  }

  /** 连上并完成必要的握手，返回一个可用的会话对象。 */
  async open() {
    if (!this.ip) throw new Error('设备 ' + this.did + ' 没有可用 IP');
    const key = latin1Bytes(this.localKey);
    if (this.version > 3.1 && key.length !== 16) {
      throw new Error(
        '设备 ' + this.did + ' 的 localKey 必须是 16 个字符（当前 ' + key.length + '）'
      );
    }

    const session = {
      handle: null,
      buffer: new Uint8Array(0),
      waiters: [],
      closed: false,
      sessionKey: key,
      realKey: key
    };

    let handle;
    try {
      handle = await Host.tcp.open({
        host: this.ip,
        port: TUYA_TCP_PORT,
        timeout: 8000
      });
    } catch (e) {
      throw new Error('连接 ' + this.ip + ':6668 失败：' + describeError(e));
    }
    session.handle = handle;

    // ⚠️ 回调必须在发包之前注册，否则第一包回得快就会丢
    await Host.tcp.onMessage(handle, (dataB64) => {
      this._onData(session, dataB64);
    });
    await Host.tcp.onClose(handle, () => {
      session.closed = true;
      // 连接被对端关掉时，别让等待中的请求干等到超时
      const pending = session.waiters.slice();
      session.waiters.length = 0;
      for (let i = 0; i < pending.length; i++) {
        pending[i].reject(new Error('设备关闭了连接'));
      }
    });

    if (this.version >= 3.4) {
      await this._negotiate(session);
    }
    return session;
  }

  async close(session) {
    if (!session || !session.handle) return;
    const handle = session.handle;
    session.handle = null;
    try {
      await Host.tcp.close(handle);
    } catch (e) {
      /* 关不掉就算了，宿主也会在插件停用时收走 */
    }
  }

  /** 收到 TCP 数据：攒进缓冲，切出完整帧，分发给等待者。 */
  _onData(session, dataB64) {
    if (!session || session.closed) return;
    let chunk;
    try {
      chunk = b64ToBytes(String(dataB64));
    } catch (e) {
      return;
    }
    session.buffer = bytesConcat([session.buffer, chunk]);

    for (;;) {
      const extracted = tryExtractFrame(session.buffer);
      if (extracted === null) return; // 还不够一帧
      session.buffer = extracted.rest;
      if (extracted.bad) continue; // 坏包，丢掉继续找

      let msg;
      if (extracted.kind === '6699') {
        msg = unpack6699(extracted.frame, session.sessionKey);
      } else {
        const hmacKey = this.version >= 3.4 ? session.sessionKey : null;
        msg = unpack55aa(extracted.frame, hmacKey);
        if (msg.crcOk) {
          const parsed = decodeResponse(this.version, msg.payload, session.sessionKey);
          msg.decoded = parsed;
          if (parsed === null && msg.payload.length > 0) {
            // 解密失败通常是版本猜错了，记下来给上层提示
            this.lastError = 'payload 解密失败（多半是协议版本不对）';
          }
        }
      }
      this._dispatch(session, msg);
    }
  }

  _dispatch(session, msg) {
    // 握手期间的帧由 _negotiate 自己消费
    if (session.negotiator) {
      session.negotiator(msg);
      return;
    }
    if (session.waiters.length === 0) return;
    const waiter = session.waiters.shift();
    waiter.resolve(msg);
  }

  /** 等一帧回来。cmd 传 null 表示任意帧。 */
  _waitFor(session, timeoutMs, cmd) {
    return new Promise((resolve, reject) => {
      const slot = {
        resolve: null,
        reject: null
      };
      const timer = setTimeout(() => {
        const idx = session.waiters.indexOf(slot);
        if (idx >= 0) session.waiters.splice(idx, 1);
        reject(new Error('设备无响应（超时 ' + timeoutMs + 'ms）'));
      }, timeoutMs);

      slot.resolve = (msg) => {
        // 命令字对不上（比如设备先回一个 ack）就继续等下一帧
        if (cmd !== null && cmd !== undefined && msg.cmd !== cmd) {
          return false;
        }
        clearTimeout(timer);
        resolve(msg);
        return true;
      };
      slot.reject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      session.waiters.push(slot);
    });
  }

  /** 发一个请求并等响应，返回解密后的 JSON（可能为 null）。 */
  async request(session, cmd, jsonText, opts) {
    const options = opts || {};
    const encoded = encodeRequest(this.version, cmd, jsonText, session.sessionKey);
    const seqno = seqCounter++;

    let frame;
    if (this.version >= 3.5) {
      frame = pack6699(seqno, encoded.cmd, encoded.body, session.sessionKey);
    } else {
      const hmacKey = this.version >= 3.4 ? session.sessionKey : null;
      frame = pack55aa(seqno, encoded.cmd, encoded.body, hmacKey);
    }

    const waiter = this._waitFor(session, options.timeout || 5000, options.expectCmd);
    try {
      await Host.tcp.send(session.handle, bytesToB64(frame));
    } catch (e) {
      session.waiters.length = 0;
      throw new Error('发送失败：' + describeError(e));
    }
    const msg = await waiter;

    if (this.version >= 3.5) {
      if (!msg.crcOk) throw new Error('响应 GCM 校验失败（localKey 或版本不对）');
      return parseJsonPayload(msg.payload);
    }
    if (!msg.crcOk) {
      throw new Error('响应校验失败（CRC/HMAC 不匹配）');
    }
    if (msg.decoded) return msg.decoded;
    return parseJsonPayload(msg.payload);
  }

  /* ---- 会话密钥协商（v3.4 / v3.5）-------------------------------------- */

  async _negotiate(session) {
    const realKey = session.realKey;
    const localNonce = await randomBytesOrPseudoAsync(16);

    // 第一步：把本地 nonce 发过去
    const step1 = {
      handle: null
    };
    const respPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('会话密钥协商超时（设备未响应握手）')), 6000);
      session.negotiator = (msg) => {
        if (msg.cmd !== TCMD.SESS_KEY_NEG_RESP) return;
        clearTimeout(timer);
        session.negotiator = null;
        resolve(msg);
      };
    });

    const encoded = encodeRequest(this.version, TCMD.SESS_KEY_NEG_START, '', realKey);
    // 握手包的 payload 是**裸字节**，不是 JSON 文本，所以绕开 request()
    const seqno1 = seqCounter++;
    let frame1;
    if (this.version >= 3.5) {
      frame1 = pack6699(seqno1, TCMD.SESS_KEY_NEG_START, localNonce, realKey);
    } else {
      frame1 = pack55aa(
        seqno1,
        TCMD.SESS_KEY_NEG_START,
        aesEcbEncrypt(realKey, localNonce, false),
        realKey
      );
    }
    void encoded;
    await Host.tcp.send(session.handle, bytesToB64(frame1));

    const respMsg = await respPromise;

    // 解密响应拿到 remoteNonce + hmac
    let payload = respMsg.payload;
    if (this.version === 3.4) {
      // 3.4 的握手响应还没解密（decodeResponse 只认 JSON，会返回 null）
      payload = aesEcbDecrypt(realKey, payload, true);
    }
    if (payload.length < 48) {
      throw new Error('会话密钥协商失败：响应过短（' + payload.length + ' 字节）');
    }
    const remoteNonce = payload.subarray(0, 16);
    const theirHmac = payload.subarray(16, 48);

    const expectHmac = hmacSha256Bytes(realKey, localNonce);
    if (!bytesEqual(expectHmac, theirHmac)) {
      throw new Error('会话密钥协商失败：HMAC 校验不通过（localKey 可能不对）');
    }

    // 第三步：把对端 nonce 的 HMAC 发回去
    const finishHmac = hmacSha256Bytes(realKey, remoteNonce);
    const seqno2 = seqCounter++;
    let frame2;
    if (this.version >= 3.5) {
      frame2 = pack6699(seqno2, TCMD.SESS_KEY_NEG_FINISH, finishHmac, realKey);
    } else {
      frame2 = pack55aa(
        seqno2,
        TCMD.SESS_KEY_NEG_FINISH,
        aesEcbEncrypt(realKey, finishHmac, false),
        realKey
      );
    }
    await Host.tcp.send(session.handle, bytesToB64(frame2));

    // 会话密钥 = XOR 两个 nonce，再用真实密钥加密一次
    const xored = new Uint8Array(16);
    for (let i = 0; i < 16; i++) xored[i] = localNonce[i] ^ remoteNonce[i];

    if (this.version === 3.4) {
      session.sessionKey = aesEcbEncrypt(realKey, xored, true);
    } else {
      const iv = localNonce.subarray(0, 12);
      // tinytuya 取的是 GCM 输出的 [12:28] —— 前 12 字节是 IV 本身
      const out = aesGcmCtrEncrypt(realKey, iv, xored);
      session.sessionKey = out.subarray(0, 16);
    }
  }

  /* ---- 业务命令 -------------------------------------------------------- */

  /** 构造查询用的 JSON。3.4/3.5 的查询体是空对象，其余带上 id 和时间戳。 */
  _queryPayload() {
    if (this.version >= 3.4) return '{}';
    const now = String(Math.floor(Date.now() / 1000));
    return JSON.stringify({
      gwId: this.did,
      devId: this.did,
      uid: this.did,
      t: now
    });
  }

  /** 构造控制用的 JSON。3.4/3.5 用 CONTROL_NEW 的两层结构。 */
  _controlPayload(dps) {
    const now = Math.floor(Date.now() / 1000);
    if (this.version >= 3.4) {
      return JSON.stringify({ protocol: 5, t: now, data: { dps: dps } });
    }
    return JSON.stringify({
      devId: this.did,
      uid: this.did,
      t: String(now),
      dps: dps
    });
  }

  /** 读一次设备状态，返回 { dpId: value }。 */
  async queryStatus(session) {
    const cmd = this.version >= 3.4 ? TCMD.DP_QUERY_NEW : TCMD.DP_QUERY;
    const data = await this.request(session, cmd, this._queryPayload(), {
      timeout: 5000,
      expectCmd: TCMD.STATUS
    });
    const dps = extractDps(data);
    if (dps) {
      this.dps = dps;
      return dps;
    }
    return this.dps;
  }

  /** 写一组 DP。失败会抛错（宿主据此判定写失败）。 */
  async setDps(session, dps) {
    const cmd = this.version >= 3.4 ? TCMD.CONTROL_NEW : TCMD.CONTROL;
    const data = await this.request(session, cmd, this._controlPayload(dps), {
      timeout: 5000
    });
    Object.assign(this.dps, dps);
    return data;
  }

  /** 便捷封装：开一次连接、跑一段逻辑、无论成败都关掉。 */
  async withSession(fn) {
    await refillRandomPool();
    const session = await this.open();
    try {
      return await fn(session);
    } finally {
      await this.close(session);
    }
  }
}

function describeError(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  return String(e);
}

/** 涂鸦的响应里 dps 可能直接给，也可能包在 data 里（v3.4 的形态）。 */
function extractDps(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.dps && typeof data.dps === 'object') return data.dps;
  if (data.data && data.data.dps && typeof data.data.dps === 'object') return data.data.dps;
  return null;
}

/** 把响应里的 payload 字节解析成 JSON（解密已经做过了）。 */
function parseJsonPayload(bytes) {
  return findJsonInBytes(bytes);
}

/* ---------------------------------------------------------------------------
 * 7.5  局域网发现（UDP）
 *
 * 主动探测是唯一可靠的方式：v3.4/3.5 设备在你发包之前**完全沉默**。
 * 发给 7000 端口的报文是 6699 帧 + REQ_DEVINFO，密钥是那个公开的
 * `md5("yGAdlopoPVldABfn")`，明文为 {"from":"app","ip":<本机IP>}。
 * ------------------------------------------------------------------------- */

/** 构造一次探测要发的报文（6699 + REQ_DEVINFO）。 */
function buildDiscoveryProbe(localIp) {
  return buildDiscoveryFrame(localIp, randomBytesOrPseudo(12), seqCounter++);
}

/**
 * 探测包的纯函数版本（IV / seqno / 明文字符串可覆盖）。
 * 做成纯函数是为了让自检能拿它和 tinytuya 的输出逐字节对 —— 生产路径只用
 * 上面那个 `buildDiscoveryProbe`。
 */
function buildDiscoveryFrame(localIp, iv, seqno, plainTextOverride) {
  const text =
    plainTextOverride || JSON.stringify({ from: 'app', ip: localIp || '0.0.0.0' });
  const plain = utf8Bytes(text);
  const length = plain.length + 28;
  const aad = bytesConcat([u16be(0), u32be(seqno), u32be(TCMD.REQ_DEVINFO), u32be(length)]);
  const gcm = aesGcmEncrypt(TUYA_UDP_KEY, iv, aad, plain);
  return bytesConcat([PREFIX_6699, aad, iv, gcm.cipher, gcm.tag, SUFFIX_6699]);
}

/** 旧版设备（3.1/3.3）在 6666/6667 上接受明文或 udpkey 加密的同一段 JSON。 */
function buildLegacyProbe(localIp, encrypted) {
  const plain = utf8Bytes(JSON.stringify({ from: 'app', ip: localIp || '0.0.0.0' }));
  if (!encrypted) return plain;
  return aesEcbEncrypt(TUYA_UDP_KEY, plain, false);
}

/** 解析设备回过来的 UDP 报文，尽量把能拿的信息掏出来。 */
function parseDiscoveryReply(bytes) {
  const candidates = [];

  // 形态 1：6699 帧（v3.4/3.5），用公开 udpkey 解
  const prefix = bytes.length >= 4 ? readU32be(bytes, 0) : 0;
  if (prefix === 0x00006699) {
    const m = unpack6699(bytes, TUYA_UDP_KEY);
    if (m.crcOk) {
      const obj = parseJsonPayload(m.payload);
      if (obj) candidates.push(obj);
    }
  } else if (prefix === 0x000055aa) {
    try {
      const m = unpack55aa(bytes, null);
      const obj = parseJsonPayload(m.payload);
      if (obj) candidates.push(obj);
    } catch (e) {
      /* 继续尝试其它形态 */
    }
  }

  // 形态 2：整体就是 JSON 明文
  const direct = parseJsonPayload(bytes);
  if (direct) candidates.push(direct);

  // 形态 3：AES-ECB(udpkey) 加密的 JSON（3.3 的广播）
  try {
    const dec = aesEcbDecrypt(TUYA_UDP_KEY, bytes, false);
    const obj = parseJsonPayload(dec);
    if (obj) candidates.push(obj);
  } catch (e) {
    /* 不是这个形态 */
  }

  for (let i = 0; i < candidates.length; i++) {
    const obj = candidates[i];
    const gwId = obj.gwId || obj.devId || obj.id;
    if (gwId) {
      return {
        did: String(gwId),
        ip: obj.ip ? String(obj.ip) : '',
        productKey: obj.productKey ? String(obj.productKey) : '',
        version: obj.version ? String(obj.version) : '',
        name: obj.name ? String(obj.name) : ''
      };
    }
  }
  return null;
}

/**
 * 扫一遍局域网，返回 { did: {did, ip, productKey, version} }。
 *
 * 策略：开一个 UDP socket 绑在本机随机端口，向受限广播地址的 7000 端口
 * 连发几次探测，收集一段时间内的应答。广播地址可能被网关吞掉，
 * 所以这一步**只当锦上添花** —— 拿不到就靠用户手填或云端返回的 IP。
 */
async function discoverLanDevices(timeoutMs, onFound) {
  const MS = timeoutMs || 4000;
  const found = {};
  let handle = null;

  try {
    handle = await Host.udp.open({ localAddress: '0.0.0.0', localPort: 0 });
  } catch (e) {
    return found; // 没有 lan 权限或端口不可用，静默降级
  }

  try {
    await Host.udp.onMessage(handle, (dataB64, host) => {
      let bytes;
      try {
        bytes = b64ToBytes(String(dataB64));
      } catch (e) {
        return;
      }
      const info = parseDiscoveryReply(bytes);
      if (!info) return;
      if (!info.ip) info.ip = String(host || '');
      if (found[info.did]) return;
      found[info.did] = info;
      if (typeof onFound === 'function') onFound(info);
    });

    const probe = bytesToB64(buildDiscoveryProbe('0.0.0.0'));
    const targets = ['255.255.255.255', '192.168.1.255', '192.168.0.255', '192.168.31.255'];
    const started = Date.now();
    let round = 0;

    while (Date.now() - started < MS) {
      for (let i = 0; i < targets.length; i++) {
        try {
          await Host.udp.send(handle, targets[i], TUYA_UDP_PORT_APP, probe);
        } catch (e) {
          /* 某些广播地址不可达，忽略 */
        }
      }
      // 也往 6666 / 6667 打一枪，照顾老设备
      const legacy = bytesToB64(buildLegacyProbe('0.0.0.0', false));
      try {
        await Host.udp.send(handle, '255.255.255.255', TUYA_UDP_PORT_31, legacy);
      } catch (e) {
        /* 忽略 */
      }
      round++;
      await sleep(round < 3 ? 400 : 700);
    }
  } finally {
    try {
      await Host.udp.close(handle);
    } catch (e) {
      /* 关不掉不影响结果 */
    }
  }
  return found;
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * 探测单个设备所在的 IP（用于用户没填 IP、或 IP 变了的情况）。
 * 返回 { ip, version } 或 null。
 */
async function findDeviceById(did, timeoutMs) {
  let hit = null;
  await discoverLanDevices(timeoutMs || 3000, function (info) {
    if (!hit && info.did === String(did)) hit = info;
  });
  return hit;
}

/* ---------- 30-cloud.js ------------------------------------------------- */
/* ============================================================================
 * §8  涂鸦云 OpenAPI 客户端
 *
 * 用的是**公开的**云开发 OpenAPI（Tuya IoT Platform 的 accessId/accessSecret），
 * 不是手机 App 端那套逆向出来的接口 —— 前者签名算法是官方文档化的，稳定得多。
 *
 * 签名（对照 tuya-connector-python 的 TuyaOpenAPI._calculate_sign）：
 *
 *   stringToSign = HTTP方法 + "\n"
 *                + sha256hex(请求体，GET 时为空串) + "\n"
 *                + ""                      (参与签名的 header，此处恒为空) + "\n"
 *                + 路径(含按 key 排序的 query)
 *
 *   message = client_id + access_token + 毫秒时间戳 + stringToSign
 *   sign    = HMAC-SHA256(access_secret, message) 的大写十六进制
 *
 * ⚠️ 时间戳是**毫秒**（Python 里 `int(time.time() * 1000)`），写成秒会直接 401。
 * ⚠️ query 要**先按 key 排序**再拼，顺序不对签名就错。
 * ⚠️ 签名里的 URL 是「路径 + query」，不带协议和域名。
 * ========================================================================== */

const TUYA_ENDPOINTS = {
  cn: 'https://openapi.tuyacn.com',
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  in: 'https://openapi.tuyain.com'
};

function resolveEndpoint(region) {
  const key = String(region || 'cn').trim().toLowerCase();
  if (TUYA_ENDPOINTS[key]) return TUYA_ENDPOINTS[key];
  // 允许用户直接填完整域名（私有云 / 自定义网关）
  if (key.indexOf('http://') === 0 || key.indexOf('https://') === 0) {
    return key.replace(/\/+$/, '');
  }
  return TUYA_ENDPOINTS.cn;
}

/** 按官方算法算一次签名，返回 { sign, t, pathWithQuery }。 */
function cloudSign(auth, method, path, query, bodyText) {
  const t = String(Date.now()); // 毫秒
  let pathWithQuery = path;
  if (query) {
    const keys = Object.keys(query).sort();
    if (keys.length > 0) {
      const parts = [];
      for (let i = 0; i < keys.length; i++) {
        parts.push(keys[i] + '=' + query[keys[i]]);
      }
      pathWithQuery = path + '?' + parts.join('&');
    }
  }

  const contentSha = sha256Hex(utf8Bytes(bodyText || ''));
  const strToSign = method + '\n' + contentSha + '\n' + '' + '\n' + pathWithQuery;
  const accessToken = auth.accessToken || '';
  const message = auth.accessId + accessToken + t + strToSign;
  const sign = bytesToHex(
    hmacSha256Bytes(utf8Bytes(auth.accessSecret), utf8Bytes(message))
  ).toUpperCase();

  return { sign: sign, t: t, pathWithQuery: pathWithQuery };
}

/**
 * 发一次云请求，返回 `result` 字段（涂鸦把它包在 {success, code, msg, result} 里）。
 * 业务失败时抛出带 code/msg 的错误 —— 宿主会把它显示给用户，所以信息要具体。
 */
async function cloudFetch(auth, method, path, query, bodyObj) {
  const bodyText = bodyObj ? JSON.stringify(bodyObj) : '';
  const signed = cloudSign(auth, method, path, query, bodyText);

  const headers = {
    client_id: auth.accessId,
    sign: signed.sign,
    sign_method: 'HMAC-SHA256',
    access_token: auth.accessToken || '',
    t: signed.t,
    lang: 'zh'
  };

  const url = auth.endpoint + signed.pathWithQuery;
  let res;
  try {
    if (method === 'GET' || method === 'DELETE') {
      res = await Host.http(method, url, headers);
    } else {
      const postHeaders = Object.assign({ 'Content-Type': 'application/json' }, headers);
      res = await Host.http(method, url, postHeaders, bodyText);
    }
  } catch (e) {
    throw new Error('云请求失败（' + method + ' ' + path + '）：' + describeError(e));
  }

  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(
      '云返回不是 JSON（HTTP ' + res.status + '）：' + String(res.body || '').substring(0, 120)
    );
  }

  if (parsed && parsed.success === false) {
    const code = parsed.code;
    const msg = parsed.msg || parsed.message || '未知错误';
    // 1010 = token 失效；上层会因此重新取一次 token
    const err = new Error('涂鸦云拒绝（code=' + code + '）：' + msg);
    err.tuyaCode = code;
    throw err;
  }
  return parsed ? parsed.result : null;
}

/** 用 accessId/accessSecret 换一个新的 access_token。 */
async function cloudGetToken(auth) {
  const result = await cloudFetch(auth, 'GET', '/v1.0/token', { grant_type: 1 }, null);
  if (!result || !result.access_token) {
    throw new Error('云返回里没有 access_token，请检查 accessId / accessSecret 是否正确');
  }
  auth.accessToken = String(result.access_token);
  auth.refreshToken = String(result.refresh_token || '');
  auth.expireTime = Date.now() + (Number(result.expire_time || result.expire || 7200)) * 1000;
  auth.uid = String(result.uid || '');
  return auth;
}

/** 确保 token 可用（快过期就提前 60 秒刷新）。 */
async function cloudEnsureToken(auth) {
  if (auth.accessToken && auth.expireTime && Date.now() < auth.expireTime - 60000) {
    return auth;
  }
  // 优先用 refresh_token 续，失败再退回完整换 token
  if (auth.refreshToken) {
    try {
      const result = await cloudFetch(
        auth, 'GET', '/v1.0/token/' + auth.refreshToken, null, null
      );
      if (result && result.access_token) {
        auth.accessToken = String(result.access_token);
        if (result.refresh_token) auth.refreshToken = String(result.refresh_token);
        auth.expireTime = Date.now() + Number(result.expire_time || 7200) * 1000;
        return auth;
      }
    } catch (e) {
      // 刷新失败就走完整换 token（省得刷不动时整个插件瘫掉）
    }
  }
  auth.accessToken = '';
  return cloudGetToken(auth);
}

/** 带一次「token 失效自动重试」的请求包装。 */
async function cloudFetchRetry(auth, method, path, query, bodyObj) {
  await cloudEnsureToken(auth);
  try {
    return await cloudFetch(auth, method, path, query, bodyObj);
  } catch (e) {
    if (e && e.tuyaCode === 1010) {
      auth.accessToken = '';
      await cloudGetToken(auth);
      return await cloudFetch(auth, method, path, query, bodyObj);
    }
    throw e;
  }
}

/**
 * 拉设备列表。两条路径都试：
 *   ① /v1.0/iot-03/devices —— 项目维度，分页
 *   ② /v1.0/devices        —— 授权账号维度
 * 不同账号的权限组合不一样，只走一条很容易拿到空列表。
 */
async function cloudListDevices(auth) {
  const out = [];
  const seen = {};

  function absorb(list) {
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const d = list[i] || {};
      const id = String(d.id || d.device_id || '');
      if (!id || seen[id]) continue;
      seen[id] = true;
      out.push({
        did: id,
        name: String(d.name || d.custom_name || id),
        category: String(d.category || ''),
        productId: String(d.product_id || ''),
        productName: String(d.product_name || ''),
        online: d.online === true,
        uuid: String(d.uuid || ''),
        ip: String(d.ip || '')
      });
    }
  }

  // ① 项目下的设备（分页）
  try {
    for (let page = 1; page <= 10; page++) {
      const result = await cloudFetchRetry(
        auth, 'GET', '/v1.0/iot-03/devices',
        { page_size: 100, page_no: page }, null
      );
      const list = result && (result.list || result.devices);
      if (!list || list.length === 0) break;
      absorb(list);
      if (!result.has_more) break;
    }
  } catch (e) {
    safeLog('error', 'tuya', '云设备列表（iot-03）失败：' + describeError(e));
  }

  // ② 授权账号下的设备
  if (out.length === 0) {
    try {
      const result = await cloudFetchRetry(auth, 'GET', '/v1.0/devices', null, null);
      absorb(Array.isArray(result) ? result : result && result.devices);
    } catch (e) {
      safeLog('error', 'tuya', '云设备列表（v1.0）失败：' + describeError(e));
    }
  }

  return out;
}

/**
 * 查单个设备的详情 —— local_key 和局域网 IP 只在这里有。
 * 这是整个云端链路里最关键的一步：没有 local_key 就没法局域网直控。
 */
async function cloudGetDeviceDetail(auth, did) {
  try {
    const result = await cloudFetchRetry(auth, 'GET', '/v1.0/devices/' + did, null, null);
    if (!result) return null;
    return {
      did: String(result.id || did),
      name: String(result.name || ''),
      localKey: String(result.local_key || ''),
      ip: String(result.ip || ''),
      category: String(result.category || ''),
      productId: String(result.product_id || ''),
      productName: String(result.product_name || ''),
      uuid: String(result.uuid || ''),
      online: result.online === true,
      timeZone: String(result.time_zone || ''),
      mac: String(result.mac || ''),
      model: String(result.model || '')
    };
  } catch (e) {
    safeLog('error', 'tuya', '取设备详情失败 ' + did + '：' + describeError(e));
    return null;
  }
}

/**
 * 拉设备的 DP 规格（functions + status）。
 *
 * 这个接口返回的是**语义化的 code**（如 switch_1 / bright_value / temp_set），
 * 比「按 DP 编号猜」可靠得多 —— 云端模式的价值主要在这里。
 */
async function cloudGetSpec(auth, did) {
  const paths = [
    '/v1.0/iot-03/devices/' + did + '/specification',
    '/v1.0/devices/' + did + '/specification'
  ];
  for (let i = 0; i < paths.length; i++) {
    try {
      const result = await cloudFetchRetry(auth, 'GET', paths[i], null, null);
      if (result && (result.functions || result.status)) {
        return {
          category: String(result.category || ''),
          functions: result.functions || [],
          status: result.status || []
        };
      }
    } catch (e) {
      /* 换下一个路径再试 */
    }
  }
  return null;
}

/** 读设备当前状态（DP 值），用于没有局域网时也能看到数据。 */
async function cloudGetDeviceStatus(auth, did) {
  const paths = [
    '/v1.0/iot-03/devices/' + did + '/status',
    '/v1.0/devices/' + did + '/status'
  ];
  for (let i = 0; i < paths.length; i++) {
    try {
      const result = await cloudFetchRetry(auth, 'GET', paths[i], null, null);
      if (Array.isArray(result)) {
        const dps = {};
        for (let k = 0; k < result.length; k++) {
          const item = result[k] || {};
          if (item.code) dps[String(item.code)] = item.value;
        }
        return dps;
      }
    } catch (e) {
      /* 换下一个路径 */
    }
  }
  return null;
}

/** 云端下发一组 DP（没有局域网能力时的兜底通道）。 */
async function cloudSetDeviceStatus(auth, did, payload) {
  const paths = [
    '/v1.0/iot-03/devices/' + did + '/commands',
    '/v1.0/devices/' + did + '/commands'
  ];
  let lastErr = null;
  for (let i = 0; i < paths.length; i++) {
    try {
      const result = await cloudFetchRetry(auth, 'POST', paths[i], null, { commands: payload });
      if (result !== undefined) return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('云端下发失败');
}

/* ---------- 40-mapping.js ----------------------------------------------- */
/* ============================================================================
 * §9  Tuya DP ⇄ MIoT 能力描述映射
 *
 * 这一层解决的是移植里最"脏"的那部分：Tuya 的数据模型是
 *   「品类 + DP（功能点，数字 id + 字符串 code + 类型 + 数值约束）」
 * 而 miha 宿主只认 MIoT：
 *   「siid（服务） / piid（属性） + format + access + value-range / value-list」
 *
 * 用户选定的策略是**通用品类映射表**：
 *   ① 有一份静态的「DP code → MIoT 属性」规则表（覆盖涂鸦各品类最常见的那批 code）；
 *   ② 设备真实的功能点列表（云 spec 或局域网 DP_QUERY）决定实际生成哪些属性；
 *   ③ 规则表认不出来的 DP 一律塞进「自定义」服务，绝不丢功能；
 *   ④ 纯手动局域网接入（没有云端 spec）时，再退到品类参考模板。
 *
 * 直接读 miha 内核对 spec 的契约（mijia-cloud/main.js:2406 getSpecForDevice）：
 *   - 返回 **miot-spec.org 的原始 instance JSON**，宿主自己 parse，插件不做二次加工；
 *   - 形状：{ type, description, services:[ {iid, type, description, properties:[], actions:[]} ] }
 *   - properties[].iid 就是 piid；数值约束用 kebab-case 的 value-range / value-list；
 *   - 宿主**按服务名/属性名去找**，不硬编码 siid（mijia-cloud 里反复强调过），
 *     所以 siid / piid 只要自洽即可，urn 里的 token 才是宿主的语义锚点。
 *
 * 三个方向都要能translate，否则控制链路会断：
 *   getProperties(siid,piid)  → 找 dp  → 读原始值 → 按 divisor/enum 转成 MIoT 值
 *   setProperty(siid,piid,v)  → 找 dp  → MIoT 值转回原始值 → 下发
 *   callAction(siid,aiid,in)  → 查伪动作表 → 落到某个 dp 写入
 * ========================================================================== */

/* ---------------------------------------------------------------- MIoT urn */

/**
 * 服务 urn 表。
 *
 * 数字段（000078xx）是 MIoT 规范里的 service id：常见的那几个我按规范写，
 * 少数几个规范里少见的用 00007 8xx 段的近似值 —— 宿主只从 urn 里取
 * **token**（`serviceToken()` 用 split(':')[3]）来决定语义，数字段不参与判断，
 * 所以近似值不会影响宿主行为，只影响"看起来像不像规范"。
 */
const MIOT_SERVICES = {
  'device-information': { urn: 'urn:miot-spec-v2:service:device-information:00007801', desc: '设备信息' },
  light: { urn: 'urn:miot-spec-v2:service:light:00007802', desc: '灯光' },
  'air-conditioner': { urn: 'urn:miot-spec-v2:service:air-conditioner:00007805', desc: '空调' },
  'air-purifier': { urn: 'urn:miot-spec-v2:service:air-purifier:00007806', desc: '空气净化器' },
  'dehumidifier': { urn: 'urn:miot-spec-v2:service:dehumidifier:00007807', desc: '除湿机' },
  fan: { urn: 'urn:miot-spec-v2:service:fan:00007808', desc: '风扇' },
  heater: { urn: 'urn:miot-spec-v2:service:heater:00007809', desc: '取暖器' },
  environment: { urn: 'urn:miot-spec-v2:service:environment:0000780A', desc: '环境' },
  'thermostat': { urn: 'urn:miot-spec-v2:service:thermostat:0000780B', desc: '温控器' },
  'switch': { urn: 'urn:miot-spec-v2:service:switch:0000780C', desc: '开关' },
  battery: { urn: 'urn:miot-spec-v2:service:battery:0000780E', desc: '电池' },
  'humidifier': { urn: 'urn:miot-spec-v2:service:humidifier:00007804', desc: '加湿器' },
  alarm: { urn: 'urn:miot-spec-v2:service:alarm:00007818', desc: '告警' },
  'water-heater': { urn: 'urn:miot-spec-v2:service:water-heater:00007821', desc: '热水器' },
  curtain: { urn: 'urn:miot-spec-v2:service:curtain:00007820', desc: '窗帘' },
  // 兜底：规则表认不出来的 DP 全进这里，保证「功能不丢」
  'custom-dp': { urn: 'urn:miot-spec-v2:service:custom-dp:000078FF', desc: '其他功能点' }
};

/** 属性的 urn。数字段同上：常见属性按规范写，冷门属性近似。 */
const MIOT_PROPS = {
  'name': 'urn:miot-spec-v2:property:name:00000001',
  'model': 'urn:miot-spec-v2:property:model:00000002',
  'serial-number': 'urn:miot-spec-v2:property:serial-number:00000003',
  'firmware-revision': 'urn:miot-spec-v2:property:firmware-revision:00000004',
  'on': 'urn:miot-spec-v2:property:on:00000006',
  'status': 'urn:miot-spec-v2:property:status:00000007',
  'mode': 'urn:miot-spec-v2:property:mode:00000008',
  'fault': 'urn:miot-spec-v2:property:fault:00000009',
  'alarm': 'urn:miot-spec-v2:property:alarm:0000000C',
  'brightness': 'urn:miot-spec-v2:property:brightness:0000000D',
  'color': 'urn:miot-spec-v2:property:color:0000000E',
  'color-temperature': 'urn:miot-spec-v2:property:color-temperature:0000000F',
  'battery-level': 'urn:miot-spec-v2:property:battery-level:00000014',
  'charging-state': 'urn:miot-spec-v2:property:charging-state:00000015',
  'fan-level': 'urn:miot-spec-v2:property:fan-level:00000016',
  'temperature': 'urn:miot-spec-v2:property:temperature:00000020',
  'target-temperature': 'urn:miot-spec-v2:property:target-temperature:00000021',
  'vertical-swing': 'urn:miot-spec-v2:property:vertical-swing:00000025',
  'horizontal-swing': 'urn:miot-spec-v2:property:horizontal-swing:00000026',
  'relative-humidity': 'urn:miot-spec-v2:property:relative-humidity:0000002B',
  'motor-control': 'urn:miot-spec-v2:property:motor-control:0000002F',
  'current-position': 'urn:miot-spec-v2:property:current-position:00000030',
  'target-position': 'urn:miot-spec-v2:property:target-position:00000031',
  'pm2.5-density': 'urn:miot-spec-v2:property:pm2.5-density:00000034',
  'co2-density': 'urn:miot-spec-v2:property:co2-density:00000035',
  'tvoc-density': 'urn:miot-spec-v2:property:tvoc-density:00000036',
  'illumination': 'urn:miot-spec-v2:property:illumination:00000027',
  'form-aldehyde': 'urn:miot-spec-v2:property:form-aldehyde:00000037',
  'target-humidity': 'urn:miot-spec-v2:property:target-humidity:0000002C',
  'water-level': 'urn:miot-spec-v2:property:water-level:0000003A',
  'anion': 'urn:miot-spec-v2:property:anion:0000003B',
  'eco-mode': 'urn:miot-spec-v2:property:eco-mode:00000038',
  'sleep-mode': 'urn:miot-spec-v2:property:sleep-mode:00000039',
  'child-lock': 'urn:miot-spec-v2:property:child-lock:00000017',
  'target-temperature-low': 'urn:miot-spec-v2:property:target-temperature-low:00000022',
  'target-temperature-high': 'urn:miot-spec-v2:property:target-temperature-high:00000023',
  'temperature-correction': 'urn:miot-spec-v2:property:temperature-correction:00000024'
};

/* ------------------------------------------------- 每个服务的属性声明顺序
 *
 * 这个顺序就是 **piid 的分配顺序** —— 同一个设备每次构建映射，
 * 同 (siid,piid) 一定对应同一个属性，缓存与重建都稳定。
 */

const SERVICE_PROPS = {
  'switch': ['on'],
  'light': ['on', 'brightness', 'color-temperature', 'color', 'mode'],
  'air-conditioner': ['on', 'target-temperature', 'mode', 'fan-level',
    'vertical-swing', 'horizontal-swing', 'eco-mode', 'sleep-mode', 'child-lock'],
  'heater': ['on', 'target-temperature', 'mode', 'eco-mode', 'child-lock', 'temperature-correction'],
  'thermostat': ['on', 'target-temperature', 'target-temperature-low', 'target-temperature-high',
    'mode', 'eco-mode', 'child-lock', 'temperature-correction'],
  'water-heater': ['on', 'target-temperature', 'mode', 'eco-mode', 'child-lock'],
  'fan': ['on', 'fan-level', 'mode', 'vertical-swing', 'horizontal-swing'],
  'humidifier': ['on', 'target-humidity', 'mode', 'water-level', 'anion', 'child-lock'],
  'dehumidifier': ['on', 'target-humidity', 'mode', 'anion', 'water-level', 'child-lock'],
  'air-purifier': ['on', 'mode', 'fan-level', 'anion'],
  'curtain': ['motor-control', 'current-position', 'target-position'],
  'environment': ['temperature', 'relative-humidity', 'pm2.5-density', 'co2-density',
    'tvoc-density', 'form-aldehyde', 'illumination'],
  'battery': ['battery-level', 'charging-state'],
  'alarm': ['alarm'],
  'device-information': ['name', 'model', 'serial-number', 'firmware-revision'],
  'custom-dp': []
};

/* --------------------------------------------------- 属性默认定义（被设备真实
 * 的 values 覆盖）—— 没写 value-range 的表示"约束未知，留空不猜"。
 */

const PROP_DEFS = {
  'on': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'brightness': { format: 'uint8', access: ['read', 'write'], unit: '%', range: [1, 100, 1] },
  'color-temperature': { format: 'uint16', access: ['read', 'write'], unit: 'K', range: [1700, 6500, 1] },
  'color': { format: 'uint32', access: ['read', 'write'], range: [0, 16777215, 1] },
  'mode': { format: 'uint8', access: ['read', 'write'] },
  'fan-level': { format: 'uint8', access: ['read', 'write'] },
  'target-temperature': { format: 'float', access: ['read', 'write'], unit: '℃', range: [5, 35, 1] },
  'temperature': { format: 'float', access: ['read'], unit: '℃', range: [-40, 125, 0.1] },
  'relative-humidity': { format: 'uint8', access: ['read'], unit: '%', range: [0, 100, 1] },
  'pm2.5-density': { format: 'uint16', access: ['read'], unit: 'μg/m³', range: [0, 999, 1] },
  'co2-density': { format: 'uint16', access: ['read'], unit: 'ppm', range: [0, 5000, 1] },
  'tvoc-density': { format: 'uint16', access: ['read'], unit: 'μg/m³', range: [0, 10000, 1] },
  'form-aldehyde': { format: 'float', access: ['read'], unit: 'mg/m³', range: [0, 10, 0.01] },
  'illumination': { format: 'uint32', access: ['read'], unit: 'lx', range: [0, 100000, 1] },
  'battery-level': { format: 'uint8', access: ['read'], unit: '%', range: [0, 100, 1] },
  'charging-state': {
    format: 'uint8', access: ['read'],
    valueList: [{ value: 0, description: '未充电' }, { value: 1, description: '充电中' },
      { value: 2, description: '已充满' }]
  },
  'alarm': { format: 'bool', access: ['read'], boolLabels: ['正常', '告警'] },
  'motor-control': { format: 'uint8', access: ['read', 'write'] },
  'current-position': { format: 'uint8', access: ['read'], unit: '%', range: [0, 100, 1] },
  'target-position': { format: 'uint8', access: ['read', 'write'], unit: '%', range: [0, 100, 1] },
  'target-humidity': { format: 'uint8', access: ['read', 'write'], unit: '%', range: [0, 100, 1] },
  'water-level': { format: 'uint8', access: ['read'], unit: '%', range: [0, 100, 1] },
  'anion': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'eco-mode': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'sleep-mode': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'child-lock': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'vertical-swing': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'horizontal-swing': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'target-temperature-low': { format: 'float', access: ['read', 'write'], unit: '℃', range: [5, 35, 1] },
  'target-temperature-high': { format: 'float', access: ['read', 'write'], unit: '℃', range: [5, 35, 1] },
  'temperature-correction': { format: 'int32', access: ['read', 'write'], unit: '℃', range: [-10, 10, 1] },
  'name': { format: 'string', access: ['read'] },
  'model': { format: 'string', access: ['read'] },
  'serial-number': { format: 'string', access: ['read'] },
  'firmware-revision': { format: 'string', access: ['read'] }
};

/* --------------------------------------------------------------- 枚举标签表
 *
 * 涂鸦 Enum 型的 range 是一串英文小写单词，直接摊给用户可读性差。
 * 这里查一遍常见值给中文标签；查不到就原样显示，不猜。
 */
const ENUM_LABELS = {
  auto: '自动', automatic: '自动', manual: '手动', program: '编程', programing: '编程',
  cool: '制冷', cold: '制冷', heat: '制热', hot: '制热', wind: '送风', dry: '除湿',
  fan: '送风', wet: '除湿', strong: '强劲', normal: '标准', gentle: '柔和', soft: '柔和',
  high: '高', mid: '中', middle: '中', low: '低', mute: '静音', silent: '静音',
  white: '白光', colour: '彩光', color: '彩光', scene: '场景', music: '音乐',
  sleep: '睡眠', eco: '节能', comfort: '舒适', smart: '智能', away: '离家', home: '在家',
  open: '打开', close: '关闭', stop: '暂停', continue: '继续', pause: '暂停',
  on: '开', off: '关', idle: '待机', running: '运行', standby: '待机', charging: '充电中',
  charge: '充电', discharge: '放电', full: '已充满', none: '无', no: '否', yes: '是',
  celsius: '摄氏度', fahrenheit: '华氏度', c: '摄氏度', f: '华氏度',
  position: '位置', zone: '分区', single: '单次', repeat: '重复', daily: '每天',
  monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四',
  friday: '周五', saturday: '周六', sunday: '周日', everyday: '每天',
  forward: '正转', reverse: '反转', left: '左', right: '右', up: '上', down: '下',
  horizontal: '水平', vertical: '垂直', both: '双向', swing: '扫风',
  schedule: '定时', timer: '定时', countdown: '倒计时', inching: '点动',
  charge_only: '仅充电', discharge_only: '仅放电', self_consumption: '自发自用',
  ultra_charge: '极速充电', boost: '强劲', standard: '标准', fast: '快'
};

/** 给一个涂鸦枚举值挑中文标签；查不到原样返回。 */
function enumLabel(value) {
  if (value === null || value === undefined) return '';
  const key = String(value).trim().toLowerCase();
  if (ENUM_LABELS[key] !== undefined) return ENUM_LABELS[key];
  return String(value);
}

/* ------------------------------------------------------------ DP code 规则表
 *
 * 顺序即优先级，**先匹配先赢**。每条规则：
 *   token       → 落到哪个 MIoT 属性（PROP_DEFS 的 key）
 *   svc         → 该属性的"归属服务"（若设备主服务已声明它，则留在主服务）
 *   codes       → 精确 code 名单（小写）
 *   re          → 正则（用于 switch_1..switch_8 这类带序号的）
 *   multi       → 允许同一规则命中多个 DP（各自占一个 piid）
 *   attach      → "附加型"属性：永远跟着设备主服务走，不单独开服务。
 *                 像童锁 / 节能 / 摆风这类，语义上属于"这台设备"而不是
 *                 某个固定品类 —— 硬塞进 thermostat 服务只会让灯上多出
 *                 一个莫名其妙的温控服务。
 *   sensor      → 只读（覆盖 PROP_DEFS 的 access）
 *   divisor     → 固定缩放（否则取设备 values.scale）
 *
 * 规则来源：涂鸦各品类标准功能点命名（对照 tuya-local 1770 个设备定义里
 * 实际出现过的 code 归并），只收"跨厂商稳定"的那批。认不出的走 custom-dp。
 */
const DP_CODE_RULES = [
  /* ── 开关类 ───────────────────────────────────────── */
  { token: 'on', svc: 'switch', multi: true,
    codes: ['switch', 'switch_1', 'switch_led', 'switch_led_1', 'switch_usb1', 'switch_usb2',
      'switch_app', 'switch_socket', 'power', 'power_1', 'on', 'relay', 'relay_1', 'plug',
      'socket', 'valve', 'light', 'smart_switch', 'switch_1_1'],
    re: /^(switch|relay|power|socket|plug|outlet|gang)(_[0-9a-z]+)?$/ },

  /* ── 灯光 ─────────────────────────────────────────── */
  { token: 'brightness', svc: 'light',
    codes: ['bright_value', 'bright_value_v2', 'bright_value_1', 'bright_value_2', 'brightness',
      'bright_percentage', 'std_brightness', 'light_value', 'brightness_value'],
    re: /^bright(_value|ness)(_[0-9a-z]+)?$/ },
  { token: 'color-temperature', svc: 'light',
    codes: ['temp_value', 'temp_value_v2', 'temp_value_1', 'temp_value_2', 'color_temp',
      'colour_temp', 'std_color_temp', 'color_temperature', 'temperature_value'],
    re: /^(temp|colour|color)_(value|temp)(_[0-9a-z]+)?$/ },
  { token: 'color', svc: 'light', codec: 'hsv',
    codes: ['colour_data', 'colour_data_v2', 'colour_data_1', 'colour_data_2', 'color_data',
      'color_data_v2', 'rgbhsv', 'std_rgbhsv', 'colour', 'color', 'rgb', 'rgb_color'],
    re: /^colou?r_(data|r)(_[0-9a-z]+)?$/ },

  /* ── 模式 / 档位 / 风速 ───────────────────────────── */
  { token: 'mode', svc: 'switch', multi: true, attach: true,
    codes: ['mode', 'work_mode', 'operation_mode', 'hvac_mode', 'color_mode', 'colour_mode',
      'dehumidifier_mode', 'air_mode', 'workmode', 'run_mode', 'device_mode'] },
  { token: 'fan-level', svc: 'fan', multi: true,
    codes: ['fan_speed_enum', 'fan_speed', 'fan_level', 'speed', 'wind_speed', 'windspeed',
      'gear', 'fan_speed_1', 'level', 'wind_level', 'fan_speed_value'] },

  /* ── 温度闭环 ─────────────────────────────────────── */
  { token: 'temperature', svc: 'environment', sensor: true, multi: true,
    codes: ['temp_current', 'temp_current_f', 'current_temperature', 'current_temp', 'temp_indoor',
      'temperature', 'va_temperature', 'room_temp', 'room_temperature', 'temp_room',
      'in_room_temperature', 'temperature_current', 'temp_cur', 'temp_f', 'sensor_temp',
      'current_temperature_f', 'internal_temp', 'temp', 'sensor_f', 'temp_now'] },
  { token: 'target-temperature', svc: 'thermostat', multi: true,
    codes: ['temp_set', 'temp_set_f', 'temp_setting', 'target_temperature', 'temperature_set',
      'set_temp', 'target_temp', 'temp_target', 'temperature_target', 'temp_target_set'] },
  { token: 'target-temperature-high', svc: 'thermostat', attach: true,
    codes: ['upper_temp', 'max_temperature', 'temp_top', 'max_temp', 'upper_temperature',
      'target_temp_high', 'max_temperature_f', 'max_temp_f', 'upper_temp_f', 'upper_limit'] },
  { token: 'target-temperature-low', svc: 'thermostat', attach: true,
    codes: ['lower_temp', 'min_temperature', 'temp_bottom', 'min_temp', 'lower_temperature',
      'target_temp_low', 'min_temperature_f', 'min_temp_f', 'lower_temp_f', 'lower_limit'] },
  { token: 'temperature-correction', svc: 'thermostat', attach: true,
    codes: ['temp_correction', 'temp_calibration', 'temperature_correction', 'temp_adjust',
      'temperature_calibration', 'calibration', 'temp_compensation'] },

  /* ── 湿度闭环 ─────────────────────────────────────── */
  { token: 'relative-humidity', svc: 'environment', sensor: true, multi: true,
    codes: ['humidity_value', 'current_humidity', 'humidity', 'va_humidity', 'humidity_indoor',
      'humidity_current', 'rh', 'humidity_now', 'sensor_humidity'] },
  { token: 'target-humidity', svc: 'humidifier', multi: true,
    codes: ['humidity_set', 'humidity_setting', 'target_humidity', 'humidity_target',
      'dehumidify_set_value', 'humidity_value_set', 'humidity_set_value'] },

  /* ── 空气质量 ─────────────────────────────────────── */
  { token: 'pm2.5-density', svc: 'environment', sensor: true,
    codes: ['pm25_value', 'pm25_value_v2', 'pm25', 'pm2p5', 'pm2_5', 'pm2_5_value', 'pm25_value_1'] },
  { token: 'co2-density', svc: 'environment', sensor: true,
    codes: ['co2_value', 'co2', 'carbon_dioxide', 'co2_value_v2', 'co2_state'] },
  { token: 'tvoc-density', svc: 'environment', sensor: true,
    codes: ['tvoc', 'tvoc_value', 'ch2o_value', 'formaldehyde', 'hcho', 'voc', 'voc_value'] },
  { token: 'illumination', svc: 'environment', sensor: true,
    codes: ['illuminance_value', 'illuminance', 'lux', 'brightness_lux', 'light_lux'] },

  /* ── 电池 ─────────────────────────────────────────── */
  { token: 'battery-level', svc: 'battery', sensor: true,
    codes: ['battery_percentage', 'battery', 'battery_capacity', 'residual_electricity',
      'battery_value', 'battery_level', 'battery_power'] },
  { token: 'charging-state', svc: 'battery', sensor: true,
    codes: ['charge_state', 'charging_state', 'charge_status', 'charging_status'] },

  /* ── 告警 / 门磁 / 人体 ───────────────────────────── */
  { token: 'alarm', svc: 'alarm', sensor: true, multi: true,
    codes: ['alarm_state', 'alarm', 'alarm_set_1', 'alarm_set_2', 'alarm_lock', 'alarm_message',
      'alarm_msg', 'siren_state', 'smoke_sensor_state', 'gas_sensor_state', 'watersensor_state',
      'pir', 'doorcontact_state', 'motion', 'flood', 'submersion_state', 'water_alarm',
      'temp_alarm', 'leak', 'contact_state', 'tamper', 'tamper_alarm', 'smoke_state',
      'gas_state', 'smoke_value', 'gas_value'] },

  /* ── 窗帘 / 推窗 ──────────────────────────────────── */
  { token: 'motor-control', svc: 'curtain',
    codes: ['control', 'curtain_control', 'operation', 'motor_control', 'mach_operate'] },
  { token: 'current-position', svc: 'curtain', sensor: true, multi: true,
    codes: ['percent_state', 'position', 'current_position', 'curtain_position', 'percent',
      'position_current', 'curtain_state'] },
  { token: 'target-position', svc: 'curtain',
    codes: ['percent_control', 'position_control', 'target_position', 'curtain_control_value'] },

  /* ── 摆风 / 摇摆 ──────────────────────────────────── */
  { token: 'vertical-swing', svc: 'fan', multi: true, attach: true,
    codes: ['swing', 'swing_v', 'swing_mode', 'windshake', 'swing_vertical', 'vertical_swing',
      'shake', 'up_down'] },
  { token: 'horizontal-swing', svc: 'fan', multi: true, attach: true,
    codes: ['swing_h', 'swing_lr', 'swing_horizontal', 'horizontal_swing', 'windshake_h',
      'shake_h', 'left_right'] },

  /* ── 其他布尔开关 ─────────────────────────────────── */
  { token: 'eco-mode', svc: 'thermostat', attach: true,
    codes: ['eco', 'eco_mode', 'energy_saving', 'save_mode'] },
  { token: 'sleep-mode', svc: 'thermostat', attach: true,
    codes: ['sleep', 'sleep_mode', 'sleep_switch'] },
  { token: 'child-lock', svc: 'thermostat', attach: true,
    codes: ['child_lock', 'key_lock', 'lock_key', 'childlock', 'lock_set', 'child_lock_1'] },
  { token: 'anion', svc: 'air-purifier', attach: true,
    codes: ['anion', 'negative_ion', 'ionizer', 'ion', 'purify', 'uv', 'uvc'] },
  { token: 'water-level', svc: 'humidifier', attach: true, sensor: true,
    codes: ['water_lack', 'waterlevel', 'water_level', 'water_state', 'waterlack', 'no_water'] }
];

/** 把 DP code 归一成小写去空格，规则表按这个匹配。 */
function normDpCode(code) {
  return String(code === undefined || code === null ? '' : code).trim().toLowerCase();
}

/** 给一个 DP code 找规则；找不到返回 null。 */
function findDpRule(code) {
  const k = normDpCode(code);
  if (!k) return null;
  for (let i = 0; i < DP_CODE_RULES.length; i++) {
    const r = DP_CODE_RULES[i];
    if (r.codes) {
      for (let j = 0; j < r.codes.length; j++) {
        if (r.codes[j] === k) return r;
      }
    }
    if (r.re && r.re.test(k)) return r;
  }
  return null;
}

/* ------------------------------------------------------- 品类 → 主服务 / 模板
 *
 * 主服务决定 siid=2 是什么（"这个设备主要是个什么东西"）。
 * 涂鸦品类码是官方的，但**谁都可能记岔**，所以这里只当"提示"用：
 * 真正权威的是云 spec 返回的 category，认不出就退到 switch。
 */
const CATEGORY_INFO = {
  kg: { svc: 'switch', device: 'switch', label: '开关' },
  cz: { svc: 'switch', device: 'outlet', label: '插座' },
  pc: { svc: 'switch', device: 'outlet', label: '排插' },
  zndb: { svc: 'switch', device: 'outlet', label: '计量插座' },
  dj: { svc: 'light', device: 'light', label: '灯具' },
  dd: { svc: 'light', device: 'light', label: '灯带' },
  xdd: { svc: 'light', device: 'light', label: '吸顶灯' },
  tgq: { svc: 'light', device: 'light', label: '投光灯' },
  fwd: { svc: 'light', device: 'light', label: '氛围灯' },
  dc: { svc: 'light', device: 'light', label: '灯串' },
  gd: { svc: 'light', device: 'light', label: '轨道灯' },
  wk: { svc: 'thermostat', device: 'thermostat', label: '温控器' },
  qn: { svc: 'heater', device: 'heater', label: '取暖器' },
  rs: { svc: 'water-heater', device: 'water-heater', label: '热水器' },
  kt: { svc: 'air-conditioner', device: 'air-conditioner', label: '空调' },
  ntq: { svc: 'thermostat', device: 'thermostat', label: '暖通温控' },
  cl: { svc: 'curtain', device: 'curtain', label: '窗帘' },
  fs: { svc: 'fan', device: 'fan', label: '风扇' },
  js: { svc: 'humidifier', device: 'humidifier', label: '加湿器' },
  cs: { svc: 'dehumidifier', device: 'dehumidifier', label: '除湿机' },
  kj: { svc: 'air-purifier', device: 'air-purifier', label: '空气净化器' },
  wsdcg: { svc: 'environment', device: 'temperature-humidity-sensor', label: '温湿度传感器' },
  rqbj: { svc: 'alarm', device: 'gas-detector', label: '燃气报警器' },
  ywbj: { svc: 'alarm', device: 'smoke-detector', label: '烟雾报警器' },
  jwbj: { svc: 'alarm', device: 'submersion-sensor', label: '水浸报警器' },
  sgbj: { svc: 'alarm', device: 'siren', label: '声光报警器' },
  pir: { svc: 'alarm', device: 'motion-sensor', label: '人体感应器' },
  mcs: { svc: 'alarm', device: 'contact-sensor', label: '门窗传感器' },
  ms: { svc: 'switch', device: 'lock', label: '门锁' },
  sd: { svc: 'switch', device: 'vacuum', label: '扫地机器人' },
  cwwsq: { svc: 'switch', device: 'pet-feeder', label: '宠物喂食器' },
  evcharger: { svc: 'switch', device: 'ev-charger', label: '充电桩' }
};

/**
 * 品类参考模板：**只在完全没有云端 spec、也没读到 DP_QUERY 时**用来铺一个
 * 能用的面板。数字 id 按涂鸦该品类的标准布局写，跨厂商大体一致但不保证 ——
 * 所以它是最后的兜底，不是主路径。
 */
const CATEGORY_TEMPLATES = {
  kg: { dps: [{ id: 1, code: 'switch_1', type: 'Boolean' },
    { id: 9, code: 'countdown_1', type: 'Integer', values: { unit: 's', min: 0, max: 86400, scale: 0, step: 1 } }] },
  cz: { dps: [{ id: 1, code: 'switch_1', type: 'Boolean' },
    { id: 9, code: 'countdown_1', type: 'Integer', values: { unit: 's', min: 0, max: 86400, scale: 0, step: 1 } },
    { id: 17, code: 'cur_current', type: 'Integer', values: { unit: 'mA', min: 0, max: 30000, scale: 0, step: 1 } },
    { id: 18, code: 'cur_power', type: 'Integer', values: { unit: 'W', min: 0, max: 50000, scale: 1, step: 1 } },
    { id: 19, code: 'cur_voltage', type: 'Integer', values: { unit: 'V', min: 0, max: 5000, scale: 1, step: 1 } }] },
  pc: { dps: [{ id: 1, code: 'switch_1', type: 'Boolean' }, { id: 2, code: 'switch_2', type: 'Boolean' },
    { id: 3, code: 'switch_3', type: 'Boolean' }, { id: 4, code: 'switch_4', type: 'Boolean' },
    { id: 101, code: 'cur_power', type: 'Integer', values: { unit: 'W', min: 0, max: 50000, scale: 1, step: 1 } }] },
  dj: { dps: [{ id: 1, code: 'switch_led', type: 'Boolean' },
    { id: 2, code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene', 'music'] } },
    { id: 3, code: 'bright_value', type: 'Integer', values: { min: 10, max: 1000, scale: 0, step: 1 } },
    { id: 4, code: 'temp_value', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
    { id: 5, code: 'colour_data', type: 'Json', values: {} },
    { id: 7, code: 'countdown_1', type: 'Integer', values: { unit: 's', min: 0, max: 86400, scale: 0, step: 1 } }] },
  dd: { dps: [{ id: 1, code: 'switch_led', type: 'Boolean' },
    { id: 2, code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene', 'music'] } },
    { id: 3, code: 'bright_value', type: 'Integer', values: { min: 10, max: 1000, scale: 0, step: 1 } },
    { id: 4, code: 'temp_value', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
    { id: 5, code: 'colour_data', type: 'Json', values: {} }] },
  xdd: { dps: [{ id: 1, code: 'switch_led', type: 'Boolean' },
    { id: 2, code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene', 'music'] } },
    { id: 3, code: 'bright_value', type: 'Integer', values: { min: 10, max: 1000, scale: 0, step: 1 } },
    { id: 4, code: 'temp_value', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
    { id: 5, code: 'colour_data', type: 'Json', values: {} }] },
  wk: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'temp_set', type: 'Integer', values: { unit: '℃', min: 5, max: 35, scale: 0, step: 1 } },
    { id: 3, code: 'temp_current', type: 'Integer', values: { unit: '℃', min: -10, max: 50, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['manual', 'auto'] } }] },
  qn: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'temp_set', type: 'Integer', values: { unit: '℃', min: 5, max: 35, scale: 0, step: 1 } },
    { id: 3, code: 'temp_current', type: 'Integer', values: { unit: '℃', min: -10, max: 50, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['manual', 'auto', 'eco'] } }] },
  rs: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'temp_set', type: 'Integer', values: { unit: '℃', min: 30, max: 75, scale: 0, step: 1 } },
    { id: 3, code: 'temp_current', type: 'Integer', values: { unit: '℃', min: 0, max: 99, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['manual', 'auto'] } }] },
  kt: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'temp_set', type: 'Integer', values: { unit: '℃', min: 16, max: 30, scale: 0, step: 1 } },
    { id: 3, code: 'temp_current', type: 'Integer', values: { unit: '℃', min: -10, max: 50, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['auto', 'cold', 'hot', 'wind', 'wet'] } },
    { id: 5, code: 'fan_speed_enum', type: 'Enum', values: { range: ['auto', 'low', 'mid', 'high'] } }] },
  cl: { dps: [{ id: 1, code: 'control', type: 'Enum', values: { range: ['open', 'stop', 'close', 'continue'] } },
    { id: 2, code: 'percent_control', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 3, code: 'percent_state', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  fs: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'fan_speed_enum', type: 'Enum', values: { range: ['low', 'mid', 'high'] } },
    { id: 3, code: 'mode', type: 'Enum', values: { range: ['normal', 'sleep', 'natural'] } },
    { id: 4, code: 'oscillate', type: 'Boolean' }] },
  js: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'humidity_set', type: 'Integer', values: { unit: '%', min: 30, max: 80, scale: 0, step: 1 } },
    { id: 3, code: 'current_humidity', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['auto', 'manual'] } }] },
  cs: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'dehumidify_set_value', type: 'Integer', values: { unit: '%', min: 30, max: 80, scale: 0, step: 1 } },
    { id: 3, code: 'current_humidity', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['auto', 'manual', 'continuous'] } }] },
  kj: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'mode', type: 'Enum', values: { range: ['auto', 'manual', 'sleep'] } },
    { id: 3, code: 'fan_speed_enum', type: 'Enum', values: { range: ['auto', 'low', 'mid', 'high'] } },
    { id: 4, code: 'pm25_value', type: 'Integer', values: { unit: 'μg/m³', min: 0, max: 999, scale: 0, step: 1 } }] },
  wsdcg: { dps: [{ id: 1, code: 'va_temperature', type: 'Integer', values: { unit: '℃', min: -20, max: 80, scale: 1, step: 1 } },
    { id: 2, code: 'va_humidity', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 3, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  mcs: { dps: [{ id: 1, code: 'doorcontact_state', type: 'Boolean' },
    { id: 2, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  pir: { dps: [{ id: 1, code: 'pir', type: 'Enum', values: { range: ['pir', 'none'] } },
    { id: 2, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  jwbj: { dps: [{ id: 1, code: 'watersensor_state', type: 'Enum', values: { range: ['alarm', 'normal'] } },
    { id: 3, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  ywbj: { dps: [{ id: 1, code: 'smoke_sensor_state', type: 'Enum', values: { range: ['alarm', 'normal'] } },
    { id: 10, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  rqbj: { dps: [{ id: 1, code: 'gas_sensor_state', type: 'Enum', values: { range: ['alarm', 'normal'] } },
    { id: 4, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  ms: { dps: [{ id: 8, code: 'alarm_lock', type: 'Enum', values: { range: ['wrong_password', 'normal'] } },
    { id: 9, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  sd: { dps: [{ id: 1, code: 'power_go', type: 'Boolean' },
    { id: 2, code: 'mode', type: 'Enum', values: { range: ['smart', 'zone', 'pose', 'part', 'control'] } },
    { id: 5, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 8, code: 'fault', type: 'Bitfield', values: {} }] }
};

/** 取品类的提示信息；认不出给个中性默认。 */
function categoryInfo(category) {
  const key = normDpCode(category);
  if (CATEGORY_INFO[key]) return CATEGORY_INFO[key];
  return { svc: 'switch', device: 'switch', label: key ? key : '设备' };
}

/* ------------------------------------------------------------ 值域解析工具 */

/** 把云 spec 的 values（字符串或对象）解析成对象；坏数据不抛错。 */
function parseDpValues(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return {};
  try {
    const o = JSON.parse(text);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    return {};
  }
}

/** 10 的 n 次幂，涂鸦的 scale 是「小数点位数」。 */
function pow10(n) {
  let r = 1;
  for (let i = 0; i < n; i++) r *= 10;
  return r;
}

/**
 * 把涂鸦的 (type, values) 翻成 MIoT 的 format / 约束 / 值转换器。
 *
 * 返回 { format, range, valueList, divisor, enumValues, unit, access }
 *   divisor    非 1 时表示"设备值 = MIoT 值 × divisor"
 *   enumValues 非空时表示"MIoT 索引 ↔ 涂鸦字符串"，要经 translate
 */
function describeDpType(type, values) {
  const t = String(type || '').trim().toLowerCase();
  const v = values || {};
  const out = { format: 'string', range: null, valueList: null, divisor: 1, enumValues: null, unit: '', access: null };

  if (v.unit) out.unit = String(v.unit);

  if (t === 'boolean' || t === 'bool') {
    out.format = 'bool';
    return out;
  }

  if (t === 'enum') {
    const range = isArray(v.range) ? v.range : [];
    out.format = 'uint8';
    out.enumValues = range.map(function (s) { return String(s); });
    out.valueList = out.enumValues.map(function (s, i) {
      return { value: i, description: enumLabel(s) };
    });
    if (out.valueList.length === 0) out.valueList = null;
    return out;
  }

  if (t === 'integer' || t === 'value' || t === 'number') {
    const scale = Number(v.scale || 0);
    const divisor = scale > 0 ? pow10(scale) : 1;
    const hasMin = (v.min !== undefined && v.min !== null && v.min !== '');
    const hasMax = (v.max !== undefined && v.max !== null && v.max !== '');
    const min = hasMin ? Number(v.min) : null;
    const max = hasMax ? Number(v.max) : null;
    const step = (v.step !== undefined && v.step !== null && v.step !== '') ? Number(v.step) : 1;

    out.divisor = divisor;
    if (divisor > 1) {
      out.format = 'float';
    } else if (min !== null && min < 0) {
      out.format = 'int32';
    } else if (max !== null && max <= 255) {
      out.format = 'uint8';
    } else if (max !== null && max <= 65535) {
      out.format = 'uint16';
    } else {
      out.format = 'uint32';
    }
    if (min !== null && max !== null) {
      out.range = [min / divisor, max / divisor, step / divisor];
    }
    return out;
  }

  // String / Json / Raw / Bitfield 一律按字符串透传 —— 这类值（IR 码、
  // 场景数据、bitfield 故障字）本来就没有可用的数值语义，硬转只会失真。
  out.format = 'string';
  return out;
}

/* ------------------------------------------------------- HSV 颜色编解码
 *
 * 灯光品类里彩光 DP 有两种历史格式，都得认：
 *   v1 `colour_data`     —— 12 个 hex 字符：hhhh ssss vvvv（h 0-360 / s,v 0-1000）
 *   v2 `colour_data_v2`  —— JSON 字符串 {"h":0-360,"s":0-1000,"v":0-1000}
 * MIoT 侧统一用 uint32 的 0xRRGGBB，所以两个方向都要转。
 */

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n) || 0);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** HSV（h 0-360 / s 0-1000 / v 0-1000）→ 0xRRGGBB */
function hsvToRgbInt(h, s, v) {
  const hh = ((Number(h) || 0) % 360 + 360) % 360;
  const ss = clampInt(s, 0, 1000) / 1000;
  const vv = clampInt(v, 0, 1000) / 1000;
  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) { r = c; g = x; }
  else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; }
  else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const R = clampInt((r + m) * 255, 0, 255);
  const G = clampInt((g + m) * 255, 0, 255);
  const B = clampInt((b + m) * 255, 0, 255);
  return (R << 16) | (G << 8) | B;
}

/** 0xRRGGBB → {h 0-360, s 0-1000, v 0-1000} */
function rgbIntToHsv(rgb) {
  const n = clampInt(rgb, 0, 0xffffff);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h: Math.round(h), s: Math.round(s * 1000), v: Math.round(max * 1000) };
}

/**
 * 涂鸦彩光值 → 0xRRGGBB。
 * 认不出来（空串、格式怪）返回 null —— 调用方据此把属性留空，
 * **不要**编一个默认颜色出来，那会让用户以为设备是那个颜色。
 */
function decodeTuyaColor(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return clampInt(raw, 0, 0xffffff);
  const text = String(raw).trim();
  if (!text) return null;
  if (text.charAt(0) === '{') {
    try {
      const o = JSON.parse(text);
      return hsvToRgbInt(o.h, o.s, o.v);
    } catch (e) {
      return null;
    }
  }
  if (/^[0-9a-fA-F]{12}$/.test(text)) {
    return hsvToRgbInt(parseInt(text.substring(0, 4), 16),
      parseInt(text.substring(4, 8), 16), parseInt(text.substring(8, 12), 16));
  }
  if (/^[0-9a-fA-F]{6}$/.test(text)) {
    return parseInt(text, 16);
  }
  return null;
}

/** 0xRRGGBB → 涂鸦彩光值。kind = 'json' | 'hex'（默认 hex）。 */
function encodeTuyaColor(rgb, kind) {
  const hsv = rgbIntToHsv(rgb);
  if (kind === 'json') {
    return JSON.stringify({ h: hsv.h, s: hsv.s, v: hsv.v });
  }
  function pad4(n) {
    let s = clampInt(n, 0, 0xffff).toString(16);
    while (s.length < 4) s = '0' + s;
    return s;
  }
  return pad4(hsv.h) + pad4(hsv.s) + pad4(hsv.v);
}

/* ============================================================ 映射构建核心 */

/**
 * 构建一台设备的 (siid,piid) ⇄ DP 映射表。
 *
 * 输入是一串「功能点声明」：
 *   { code, dpId, type, values }   ← 云 spec 或品类模板
 *   dpId 允许为空（老版云接口不给 dp id）—— 那时只能靠 code 寻址，
 *   局域网 ≤3.3 的固件会写不进去，日志里会说明（见 50-plugin.js）。
 *
 * 输出：
 *   {
 *     category, primarySvc, deviceToken,
 *     spec,                 // 直接交给宿主 getSpecForDevice 的 instance JSON
 *     entries: [...],       // 映射明细，getProperties/setProperty 都查它
 *     bySiidPiid: {2:{1:entry}},
 *     byCode: {switch_1: entry},
 *     byDpId: {'1': entry}
 *   }
 */
function buildMapping(category, functions) {
  const info = categoryInfo(category);
  const primarySvc = info.svc;
  const list = isArray(functions) ? functions : [];

  // ① 每个 DP 找规则，定 token，并决定它落在哪个服务
  const picked = [];
  const usedTokens = {};   // svc -> { token: true }（非 multi 的 token 只收一次）
  for (let i = 0; i < list.length; i++) {
    const fn = list[i] || {};
    const code = normDpCode(fn.code);
    if (!code) continue;
    const rule = findDpRule(code);
    if (!rule) continue;
    const groupKey = rule.svc + '|' + rule.token;
    // 非 multi 的属性，同一个服务里只收第一个
    if (!rule.multi && usedTokens[groupKey]) continue;
    usedTokens[groupKey] = true;
    picked.push({ fn: fn, code: code, rule: rule, token: rule.token });
  }

  // ② 决定每个 token 住哪个服务：主服务声明过（或规则标了 attach）就留主服务，
  //    否则去规则指定的那个专属性服务（环境 / 电池 / 告警 / 窗帘……）
  const declaredPrimary = SERVICE_PROPS[primarySvc] || [];
  for (let i = 0; i < picked.length; i++) {
    const p = picked[i];
    const staysHome = p.rule.attach || declaredPrimary.indexOf(p.token) >= 0;
    p.svc = staysHome ? primarySvc : p.rule.svc;
  }

  // ③ 分配 piid：按 SERVICE_PROPS 的声明顺序走，声明外的（multi 扩展）追加在后
  const svcOrder = [];
  function ensureSvc(svc) {
    if (svcOrder.indexOf(svc) < 0) svcOrder.push(svc);
  }
  ensureSvc(primarySvc);
  for (let i = 0; i < picked.length; i++) ensureSvc(picked[i].svc);

  const entries = [];
  for (let s = 0; s < svcOrder.length; s++) {
    const svc = svcOrder[s];
    const declared = SERVICE_PROPS[svc] || [];
    const mine = [];
    for (let i = 0; i < picked.length; i++) {
      if (picked[i].svc === svc) mine.push(picked[i]);
    }
    // 先按声明顺序塞
    let piid = 0;
    for (let d = 0; d < declared.length; d++) {
      for (let i = 0; i < mine.length; i++) {
        if (mine[i].token === declared[d]) {
          piid += 1;
          entries.push(makeEntry(mine[i], svc, piid));
        }
      }
    }
    // 声明顺序之外的同 token 重复项（switch_2 / fan_level_2 ...）继续往后排
    for (let i = 0; i < mine.length; i++) {
      const m = mine[i];
      if (declared.indexOf(m.token) >= 0) continue;
      piid += 1;
      entries.push(makeEntry(m, svc, piid));
    }
  }

  // ④ 规则表没认出来的 DP → custom-dp 服务，功能不丢
  const custom = [];
  let customPiid = 0;
  for (let i = 0; i < list.length; i++) {
    const fn = list[i] || {};
    const code = normDpCode(fn.code);
    if (!code) continue;
    if (findDpRule(code)) continue;
    if (custom.length >= 48) break;   // 上限：面板别被几十个裸 DP 淹掉
    custom.push(fn);
  }
  for (let i = 0; i < custom.length; i++) {
    customPiid += 1;
    entries.push(makeCustomEntry(custom[i], customPiid));
  }

  // ⑤ 组装 spec
  const spec = assembleSpec(info, primarySvc, svcOrder, entries, custom);

  const bySiidPiid = {};
  const byCode = {};
  const byDpId = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!bySiidPiid[e.siid]) bySiidPiid[e.siid] = {};
    bySiidPiid[e.siid][e.piid] = e;
    if (e.code) byCode[e.code] = e;
    if (e.dpId !== null && e.dpId !== undefined) byDpId[String(e.dpId)] = e;
  }

  return {
    category: normDpCode(category),
    primarySvc: primarySvc,
    deviceToken: info.device,
    label: info.label,
    spec: spec,
    entries: entries,
    bySiidPiid: bySiidPiid,
    byCode: byCode,
    byDpId: byDpId
  };
}

/** 把一条 (dp, rule) 落成映射条目。 */
function makeEntry(picked, svc, piid) {
  const fn = picked.fn || {};
  const rule = picked.rule;
  const token = picked.token;
  const values = parseDpValues(fn.values);
  const desc = describeDpType(fn.type, values);
  const def = PROP_DEFS[token] || { format: 'string', access: ['read', 'write'] };

  // 设备的真实类型能压过默认；但布尔/枚举这类语义一旦设备给了就信设备
  const format = desc.format !== 'string' || !def.format ? desc.format : def.format;

  let range = desc.range || (def.range ? def.range.slice() : null);
  let valueList = desc.valueList || null;
  let divisor = desc.divisor !== undefined ? desc.divisor : 1;
  if (rule.divisor) divisor = rule.divisor;

  const access = rule.sensor ? ['read']
    : (def.access ? def.access.slice() : ['read', 'write']);

  // 布尔属性补上 关闭/打开 的 value-list（MIoT 惯例）
  if (format === 'bool' && !valueList) {
    const labels = def.boolLabels || ['关闭', '打开'];
    valueList = [{ value: false, description: labels[0] }, { value: true, description: labels[1] }];
  }

  return {
    siid: 0,             // 由 assembleSpec 回填，便于集中管理
    svc: svc,
    piid: piid,
    code: normDpCode(fn.code),
    dpId: (fn.dpId === undefined || fn.dpId === null || fn.dpId === '') ? null : Number(fn.dpId),
    token: token,
    format: format,
    access: access,
    range: range,
    valueList: valueList,
    divisor: divisor,
    enumValues: desc.enumValues,
    unit: desc.unit || def.unit || '',
    codec: rule.codec || null,
    colorKind: rule.codec === 'hsv' ? 'hex' : null,
    desc: PROP_LABELS[token] || token
  };
}

/** 认不出的 DP → custom-dp 服务里的一个属性。 */
function makeCustomEntry(fn, piid) {
  const code = normDpCode(fn.code);
  const values = parseDpValues(fn.values);
  const desc = describeDpType(fn.type, values);
  const isState = /(_state|_status|fault|_life|_record|_total|_report|_info|check|error)/.test(code);

  let format = desc.format;
  let range = desc.range;
  let valueList = desc.valueList;
  if (format === 'bool' && !valueList) {
    valueList = [{ value: false, description: '关闭' }, { value: true, description: '打开' }];
  }
  // 数值但没给约束：退成字符串透传，比瞎猜一个范围安全
  if ((format === 'uint8' || format === 'uint16' || format === 'uint32' || format === 'int32')
    && !range && !valueList) {
    format = 'uint32';
  }

  return {
    siid: 0,
    svc: 'custom-dp',
    piid: piid,
    code: code,
    dpId: (fn.dpId === undefined || fn.dpId === null || fn.dpId === '') ? null : Number(fn.dpId),
    token: 'dp-' + code.replace(/[^0-9a-z]+/g, '-'),
    format: format,
    access: isState ? ['read'] : ['read', 'write'],
    range: range,
    valueList: valueList,
    divisor: desc.divisor !== undefined ? desc.divisor : 1,
    enumValues: desc.enumValues,
    unit: desc.unit || '',
    codec: null,
    colorKind: null,
    desc: code,
    custom: true
  };
}

/** 属性 token → 中文名，用于 spec 里的 description。 */
const PROP_LABELS = {
  'on': '开关', 'brightness': '亮度', 'color-temperature': '色温', 'color': '颜色',
  'mode': '模式', 'fan-level': '风速', 'target-temperature': '目标温度',
  'temperature': '当前温度', 'relative-humidity': '当前湿度', 'pm2.5-density': 'PM2.5',
  'co2-density': 'CO₂ 浓度', 'tvoc-density': 'TVOC', 'form-aldehyde': '甲醛',
  'illumination': '光照度', 'battery-level': '电量', 'charging-state': '充电状态',
  'alarm': '告警', 'motor-control': '开合控制', 'current-position': '当前位置',
  'target-position': '目标位置', 'target-humidity': '目标湿度', 'water-level': '水位',
  'anion': '负离子', 'eco-mode': '节能模式', 'sleep-mode': '睡眠模式', 'child-lock': '童锁',
  'vertical-swing': '上下摆风', 'horizontal-swing': '左右摆风',
  'target-temperature-low': '温度下限', 'target-temperature-high': '温度上限',
  'temperature-correction': '温度校准',
  'name': '设备名称', 'model': '型号', 'serial-number': '序列号', 'firmware-revision': '固件版本'
};

/** 拼出最终给宿主的 instance JSON。 */
function assembleSpec(info, primarySvc, svcOrder, entries, customDps) {
  const bySvc = {};
  function bucket(svc) {
    if (!bySvc[svc]) bySvc[svc] = [];
    return bySvc[svc];
  }
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].custom) continue;
    bucket(entries[i].svc).push(entries[i]);
  }

  // siid 编号：1 固定给 device-information，2 给主服务，其余按出现顺序 3、4……
  const siidOf = { 'device-information': 1 };
  let next = 2;
  siidOf[primarySvc] = next;
  next += 1;
  for (let i = 0; i < svcOrder.length; i++) {
    const svc = svcOrder[i];
    if (siidOf[svc] === undefined) {
      siidOf[svc] = next;
      next += 1;
    }
  }
  if (customDps.length > 0 && siidOf['custom-dp'] === undefined) {
    siidOf['custom-dp'] = next;
    next += 1;
  }

  // 回填 siid 到条目上，后面 getProperties/setProperty 直接用
  for (let i = 0; i < entries.length; i++) {
    entries[i].siid = siidOf[entries[i].svc];
  }

  const services = [];

  // siid 1：设备信息（只读，宿主普遍会读它显示型号/固件）
  const infoProps = [];
  const infoTokens = ['name', 'model', 'serial-number', 'firmware-revision'];
  for (let i = 0; i < infoTokens.length; i++) {
    const t = infoTokens[i];
    const d = PROP_DEFS[t];
    infoProps.push({
      iid: i + 1,
      type: MIOT_PROPS[t],
      description: PROP_LABELS[t] || t,
      format: d.format,
      access: ['read']
    });
  }
  services.push({
    iid: 1,
    type: MIOT_SERVICES['device-information'].urn,
    description: MIOT_SERVICES['device-information'].desc,
    properties: infoProps,
    actions: []
  });

  // 主服务 + 其余有属性的服务
  const orderedSvcs = [primarySvc];
  for (let i = 0; i < svcOrder.length; i++) {
    if (orderedSvcs.indexOf(svcOrder[i]) < 0) orderedSvcs.push(svcOrder[i]);
  }
  for (let s = 0; s < orderedSvcs.length; s++) {
    const svc = orderedSvcs[s];
    const list = bySvc[svc] || [];
    if (list.length === 0) continue;
    const meta = MIOT_SERVICES[svc] || MIOT_SERVICES['switch'];
    const props = [];
    for (let i = 0; i < list.length; i++) {
      props.push(toSpecProperty(list[i]));
    }
    services.push({
      iid: siidOf[svc],
      type: meta.urn,
      description: meta.desc,
      properties: props,
      actions: []
    });
  }

  // custom-dp 服务：认不出的功能点，保证控制不丢
  if (customDps.length > 0) {
    const props = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].custom) props.push(toSpecProperty(entries[i]));
    }
    if (props.length > 0) {
      services.push({
        iid: siidOf['custom-dp'],
        type: MIOT_SERVICES['custom-dp'].urn,
        description: MIOT_SERVICES['custom-dp'].desc,
        properties: props,
        actions: []
      });
    }
  }

  return {
    type: 'urn:miot-spec-v2:device:' + info.device + ':0000A001:tuya:1',
    description: 'Tuya ' + (info.label || '设备'),
    services: services
  };
}

/** 映射条目 → spec 里的 property 对象（kebab-case，宿主 parser 吃这个形状）。 */
function toSpecProperty(e) {
  const p = {
    iid: e.piid,
    type: MIOT_PROPS[e.token] || ('urn:miot-spec-v2:property:' + e.token + ':000000FF'),
    description: e.desc || e.token,
    format: e.format,
    access: e.access
  };
  if (e.range && (e.format === 'uint8' || e.format === 'uint16' || e.format === 'uint32'
    || e.format === 'int32' || e.format === 'float')) {
    p['value-range'] = e.range;
  }
  if (e.valueList && e.valueList.length > 0) {
    p['value-list'] = e.valueList;
  }
  if (e.unit) p.unit = e.unit;
  return p;
}

/* --------------------------------------------------- 从各种来源铺「功能点声明」 */

/**
 * 云 spec（/iot-03/.../specification）→ 功能点声明数组。
 * 该接口的 functions 有时不带 dp_id，这里两种形状都收。
 */
function functionsFromCloudSpec(result) {
  const out = [];
  if (!result) return out;
  const groups = ['functions', 'status'];
  for (let g = 0; g < groups.length; g++) {
    const arr = result[groups[g]];
    if (!isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i] || {};
      if (!it.code) continue;
      out.push({
        code: it.code,
        dpId: (it.dp_id !== undefined && it.dp_id !== null) ? it.dp_id
          : ((it.dpId !== undefined && it.dpId !== null) ? it.dpId : null),
        type: it.type,
        values: it.values
      });
    }
  }
  return out;
}

/**
 * 局域网 DP_QUERY 的回包（{ "1": true, "2": 235, ... }，键是 dp id）
 * → 功能点声明。类型从值的 JS 类型反推。
 *
 * ⚠️ 这时**不知道 code**，所以只能造 `dp_1` 这种名字 —— 规则表当然认不出，
 * 结果全进 custom-dp。这是"没有云 spec 的纯手动局域网"路线的必然降级，
 * 功能能读能写，只是名字不好看。有云凭据时优先走云 spec。
 */
function functionsFromDps(dps, category) {
  const out = [];
  if (!dps || typeof dps !== 'object') return out;
  const tpl = CATEGORY_TEMPLATES[normDpCode(category)];
  const tplById = {};
  if (tpl && isArray(tpl.dps)) {
    for (let i = 0; i < tpl.dps.length; i++) tplById[String(tpl.dps[i].id)] = tpl.dps[i];
  }
  const keys = Object.keys(dps);
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    const v = dps[id];
    // 品类模板能对上号就用模板的 code/类型 —— 这样规则表才有机会认出它
    if (tplById[id]) {
      out.push({
        code: tplById[id].code,
        dpId: Number(id),
        type: tplById[id].type,
        values: tplById[id].values || {}
      });
      continue;
    }
    let type = 'String';
    let values = {};
    if (typeof v === 'boolean') type = 'Boolean';
    else if (typeof v === 'number') type = 'Integer';
    else if (typeof v === 'string' && v.charAt(0) === '{') type = 'Json';
    out.push({ code: 'dp_' + id, dpId: Number(id), type: type, values: values });
  }
  return out;
}

/** 纯手动局域网、连 DP_QUERY 都还没跑过 → 品类参考模板。 */
function functionsFromTemplate(category) {
  const tpl = CATEGORY_TEMPLATES[normDpCode(category)];
  if (!tpl || !isArray(tpl.dps)) return [];
  const out = [];
  for (let i = 0; i < tpl.dps.length; i++) {
    const d = tpl.dps[i];
    out.push({ code: d.code, dpId: d.id, type: d.type, values: d.values || {} });
  }
  return out;
}

/* ------------------------------------------------------------ 值转换（双向） */

/**
 * 设备原始值 → 给宿主的 MIoT 值。
 * 顺序：bool 原样 → 枚举索引 → 颜色 → 缩放。
 */
function dpValueToMiot(e, raw) {
  if (raw === undefined || raw === null) return undefined;

  if (e.enumValues && e.enumValues.length > 0) {
    // 枚举：既可能是字符串（Tuya Enum），也可能是模板里的 0/1 数字
    if (typeof raw === 'number') {
      return (raw >= 0 && raw < e.enumValues.length) ? raw : raw;
    }
    const idx = e.enumValues.indexOf(String(raw));
    if (idx >= 0) return idx;
    // 认不出的枚举值：返回 undefined，让宿主显示"未知"而不是错位的档位
    return undefined;
  }

  if (e.codec === 'hsv') {
    const rgb = decodeTuyaColor(raw);
    if (rgb === null) return undefined;
    return rgb;
  }

  if (e.format === 'bool') return !!raw;

  if (typeof raw === 'number' && e.divisor && e.divisor !== 1) {
    return raw / e.divisor;
  }

  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    // 字符串型数值（少数固件把数值 DP 发成字符串）
    if (e.format !== 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
      const n = Number(raw);
      return (e.divisor && e.divisor !== 1) ? n / e.divisor : n;
    }
    return raw;
  }
  return raw;
}

/**
 * 宿主要写的 MIoT 值 → 设备原始值。
 * 转换不了就直接把原值丢过去（让设备自己判），但**不吞错**。
 */
function miotValueToDp(e, value) {
  if (e.enumValues && e.enumValues.length > 0) {
    if (typeof value === 'number') {
      const idx = clampInt(value, 0, e.enumValues.length - 1);
      const s = e.enumValues[idx];
      // 涂鸦枚举基本是字符串；模板里写的数字枚举才回数字
      if (/^-?\d+$/.test(s) && e.format !== 'string') return Number(s);
      return s;
    }
    const asStr = String(value);
    if (e.enumValues.indexOf(asStr) >= 0) return asStr;
    return value;
  }

  if (e.codec === 'hsv') {
    const rgb = (typeof value === 'number') ? value : decodeTuyaColor(value);
    if (rgb === null) return value;
    return encodeTuyaColor(rgb, e.colorKind === 'json' ? 'json' : 'hex');
  }

  if (e.format === 'bool') {
    if (typeof value === 'string') return value === 'true' || value === '1';
    return !!value;
  }

  if (typeof value === 'number' && e.divisor && e.divisor !== 1) {
    return Math.round(value * e.divisor);
  }

  if (e.format !== 'string' && typeof value === 'string') {
    const n = Number(value);
    if (!isNaN(n)) {
      return (e.divisor && e.divisor !== 1) ? Math.round(n * e.divisor) : n;
    }
  }
  return value;
}

/* ---------------------------------------------------------------- 缓存与查询 */

const MAPPING_CACHE = {};

function cacheMapping(did, mapping) {
  MAPPING_CACHE[String(did)] = mapping;
  return mapping;
}

function cachedMapping(did) {
  return MAPPING_CACHE[String(did)] || null;
}

function dropMapping(did) {
  delete MAPPING_CACHE[String(did)];
}

function clearMappingCache() {
  const keys = Object.keys(MAPPING_CACHE);
  for (let i = 0; i < keys.length; i++) delete MAPPING_CACHE[keys[i]];
}

/** 按 (siid, piid) 找映射条目；找不到返回 null。 */
function findEntry(mapping, siid, piid) {
  if (!mapping) return null;
  const row = mapping.bySiidPiid[String(siid)] || mapping.bySiidPiid[Number(siid)];
  if (!row) return null;
  return row[String(piid)] || row[Number(piid)] || null;
}

/** 按 dp code 找映射条目。 */
function findEntryByCode(mapping, code) {
  if (!mapping) return null;
  return mapping.byCode[normDpCode(code)] || null;
}

/** 按 dp id 找映射条目。 */
function findEntryByDpId(mapping, dpId) {
  if (!mapping) return null;
  return mapping.byDpId[String(dpId)] || null;
}

/**
 * 下发时 dps 对象用什么做键。
 *
 * 有 dp 编号就用编号（所有版本都认）；没有就只能用 code 字符串赌一把 ——
 * 那条路要求固件 ≥3.4 且认字符串键。是否允许赌由 `isEntryAddressable` 判断。
 */
function dpPayloadKey(entry) {
  if (entry.dpId !== null && entry.dpId !== undefined) return String(entry.dpId);
  return entry.code;
}

/** 这个条目能不能在给定协议版本下寻址（用于提前告诉用户"写不进去"）。 */
function isEntryAddressable(entry, version) {
  if (entry.dpId !== null && entry.dpId !== undefined) return true;
  const v = Number(version || 0);
  return v >= 3.4;
}

/* ---------- 50-plugin.js ------------------------------------------------ */
/* ============================================================================
 * §10 插件入口：Plugin.register
 *
 * 把前面几层接成宿主认识的样子：
 *   00-util     工具（跨 realm 安全的 isArray 等）
 *   10-crypto   纯 JS 的 MD5 / SHA-256 / HMAC / AES / GCM
 *   20-lan      涂鸦局域网协议（TCP 6668 + UDP 7000 发现）
 *   30-cloud    涂鸦云 OpenAPI（HMAC-SHA256 签名）
 *   40-mapping  DP ⇄ MIoT 映射
 *   50-plugin   ← 本文件
 *
 * ## 四条硬约束（每条都在 miha 的插件文档里被点名过）
 *
 * ① `Device` 字段名用**米家原始命名**（`isOnline` / `room_id` / `local_ip` /
 *    `parent_id`），写成驼峰会静默变空字符串 —— 界面上就是"离线、没房间、图标不对"。
 *
 * ② 写失败**必须 throw**。返回 false / undefined 会被当成功，界面显示"已打开"
 *    而设备没动。这是最难查的一类 bug，所以下面每个写路径都以抛错收尾。
 *
 * ③ `init()` 可能被调多次（ArkWeb 重建），必须幂等。本插件每次请求都是
 *    "开连接 → 用 → 关"，没有常驻 socket，所以幂等只是"重新读一遍凭据"。
 *
 * ④ 写操作**只在第一条可用通道上执行一次、失败不重试**（宿主的规定，理由是
 *    局域网超时往往只是回包丢了、设备其实已经执行了，重发就是重复开灯）。
 *    所以 `isTransportAvailable` 的判断必须**保守**：局域网通道只要不是
 *    真的能连，就得返回 false，好让宿主落到云端通道上去。
 * ========================================================================== */

let pluginCtx = null;
let auth = null;
/** did -> { ip, key, version, category }：局域网直连三要素 + 品类提示 */
let lanInfoCache = {};
/** did -> Device（米家命名的那个形状） */
let deviceCache = {};
/** did -> 品类码（云列表 / 手填 / 云 spec 都可能提供） */
let categoryCache = {};
/** 一次广播发现的缓存 { at, map }，避免连着点几次就扫几遍网 */
let discoveryCache = null;
/** did -> 最近一次握手成功的协议版本（下次优先用它） */
let versionHint = {};
/** 用户手填的设备（云端模式下也保留，用来覆盖 local_key / IP / 协议版本） */
let manualDevices = [];

const HOME_ID = 'tuya';
const HOME_NAME = '涂鸦设备';
const DISCOVERY_TTL_MS = 120000;
const TAG = 'tuya';

/** 协议版本候选：发现/提示都拿不到时按这个顺序猜（3.3 最普遍，放前面）。 */
const VERSION_CANDIDATES = [3.3, 3.4, 3.5, 3.1];

/** 网络类是"换版本也没用"的错误，命中就早停，别白等几个 5 秒超时。 */
const FATAL_NET_RE = /超时|timeout|连接|关闭|refused|unreachable|没有可用 IP/i;

/* ------------------------------------------------------------- 凭据读写 */

/**
 * 读凭据。
 *
 * ⚠️ 桥的拆包层会把"形似 JSON 的字符串"自动 parse 成对象，所以必须两种形状都接。
 * 只写 JSON.parse(stored) 的话，对象会被 String() 成 "[object Object]" 再炸语法错误，
 * `init` 静默 return false —— 表现是"登录成功但设备全空"。
 */
async function loadAuth() {
  try {
    const stored = await Host.secureStore.get('auth');
    if (!stored) return null;
    const data = (typeof stored === 'string') ? JSON.parse(stored) : stored;
    if (!isPlainObject(data) && typeof data !== 'object') return null;
    if (!data) return null;

    // 补全可能缺失的字段（早期版本存下来的凭据也要能读）
    if (typeof data.manual !== 'object' || data.manual === null || !isArray(data.manual)) {
      data.manual = [];
    }
    if (!data.mode) {
      data.mode = (data.accessId && data.accessSecret) ? 'cloud' : 'local';
    }
    if (data.mode === 'cloud' && !data.endpoint) {
      data.endpoint = resolveEndpoint(data.region);
    }
    return data;
  } catch (e) {
    safeLog('error', TAG, '读取凭据失败：' + describeError(e));
    return null;
  }
}

async function saveAuth() {
  if (!auth) return;
  await Host.secureStore.set('auth', JSON.stringify(auth));
}

/** 把 auth 里的手动设备列表同步到模块变量（缺失就给空数组）。 */
function syncManualFromAuth() {
  manualDevices = (auth && isArray(auth.manual)) ? auth.manual.slice() : [];
}

function hasCloud() {
  return !!(auth && auth.mode === 'cloud' && auth.accessId && auth.accessSecret && auth.endpoint);
}

/** 从任何形状里取 did：字符串/数字直接用，对象读 .did。 */
function didOf(x) {
  if (x === undefined || x === null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return String(x);
  return strOf(x.did);
}

/* --------------------------------------------------------------- 手填设备 */

/**
 * 解析版本号 token。认不出返回 0（= 不知道，后面靠广播发现或逐个试）。
 * 同时接受 "3.3" 和 "33" 两种写法 —— 手输的时候少打一个点很正常。
 */
function parseVersionToken(token) {
  const t = strOf(token).toLowerCase().replace(/^v/, '');
  if (!t) return 0;
  let n = 0;
  if (/^3\.[1-5]$/.test(t)) n = Number(t);
  else if (/^3[1-5]$/.test(t)) n = Number(t.charAt(0) + '.' + t.charAt(1));
  if (n > 3 && n < 4) return n;
  return 0;
}

/** 归一化一条手填设备记录。 */
function normalizeManualEntry(raw) {
  const did = strOf(raw && raw.did);
  if (!did) return null;
  return {
    did: did,
    key: strOf(raw && raw.key),
    ip: strOf(raw && raw.ip),
    version: parseVersionToken(raw && raw.version),
    name: strOf(raw && raw.name),
    category: normDpCode(raw && raw.category)
  };
}

/**
 * 解析 form 里那串设备描述。
 *
 * 行格式：`设备ID,localKey,IP[,协议版本][,名称]`
 * 第 4 段不是合法版本号时**当成名称**处理 —— 用户很可能直接省掉版本，
 * 这时把"客厅灯"读成版本号再丢掉就太蠢了。
 */
function parseManualText(text, defaultCategory) {
  const out = [];
  const lines = String(text || '').split(/[;\n\r]+/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // 允许中文逗号（用户很可能从表格里粘过来）
    const parts = line.replace(/，/g, ',').split(',');
    let version = parts[3];
    let name = parts[4];
    if (version !== undefined && parseVersionToken(version) === 0 && name === undefined) {
      name = version;
      version = '';
    }
    const entry = normalizeManualEntry({
      did: parts[0],
      key: parts[1],
      ip: parts[2],
      version: version,
      name: name,
      category: parts[5] || defaultCategory
    });
    if (entry) out.push(entry);
  }
  return out;
}

/** 合并手动设备（同 did 覆盖，保留原有顺序与未提供的字段）。 */
function mergeManual(base, list) {
  const byId = {};
  const merged = [];
  for (let i = 0; i < base.length; i++) {
    const e = base[i];
    if (!e || !e.did) continue;
    byId[e.did] = e;
    merged.push(e);
  }
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || !e.did) continue;
    if (byId[e.did]) {
      const old = byId[e.did];
      const idx = merged.indexOf(old);
      const next = {
        did: e.did,
        key: e.key || old.key || '',
        ip: e.ip || old.ip || '',
        version: e.version || old.version || 0,
        name: e.name || old.name || '',
        category: e.category || old.category || ''
      };
      byId[e.did] = next;
      if (idx >= 0) merged[idx] = next;
    } else {
      byId[e.did] = e;
      merged.push(e);
    }
  }
  manualDevices = merged;
  return merged;
}

function findManual(did) {
  const d = String(did);
  for (let i = 0; i < manualDevices.length; i++) {
    if (String(manualDevices[i].did) === d) return manualDevices[i];
  }
  return null;
}

/* --------------------------------------------------------- 局域网信息解析 */

/** 把一条手动记录灌进局域网缓存（只补空缺，不覆盖已有）。 */
function absorbManualLan(entry) {
  if (!entry || !entry.did) return;
  const cur = lanInfoCache[entry.did] || { ip: '', key: '', version: 0, category: '' };
  lanInfoCache[entry.did] = {
    ip: cur.ip || entry.ip || '',
    key: cur.key || entry.key || '',
    version: cur.version || entry.version || 0,
    category: cur.category || entry.category || ''
  };
  if (entry.category && !categoryCache[entry.did]) categoryCache[entry.did] = entry.category;
}

/** 跑一次（带缓存的）局域网广播发现，返回 did -> info 的 map。 */
async function discoverOnce(force) {
  if (!force && discoveryCache && (Date.now() - discoveryCache.at) < DISCOVERY_TTL_MS) {
    return discoveryCache.map;
  }
  let map = {};
  try {
    map = await discoverLanDevices(3500, null);
  } catch (e) {
    // 没有 lan 权限 / 广播被网关吞掉 —— 静默降级，还有手填和云 IP 两条路
    safeLog('error', TAG, '局域网发现失败：' + describeError(e));
    map = {};
  }
  discoveryCache = { at: Date.now(), map: map };
  return map;
}

/**
 * 凑齐一台设备的局域网三要素（ip / key / 协议版本）。
 *
 * 优先级：手填 > 云端详情 > 广播发现。凑不齐返回 null —— 让上层老实走云通道，
 * **绝不**瞎猜 IP 或密钥去"试一下"。
 */
async function ensureLanInfo(did, _device) {
  const d = String(did);

  // ① 用户手填的（最可信：填了就说明知道自己在填什么）
  const manual = findManual(d);
  if (manual) absorbManualLan(manual);
  let cur = lanInfoCache[d];
  if (cur && cur.ip && cur.key) return cur;

  // ② 云端详情：local_key 只有这里能给
  if (hasCloud() && !(cur && cur.key)) {
    const det = await cloudGetDeviceDetail(auth, d);
    if (det && det.localKey) {
      cur = lanInfoCache[d] || { ip: '', key: '', version: 0, category: '' };
      lanInfoCache[d] = {
        ip: cur.ip || det.ip || '',
        key: det.localKey,
        version: cur.version || 0,
        category: cur.category || det.category || ''
      };
      if (det.category && !categoryCache[d]) categoryCache[d] = det.category;
    }
  }

  // ③ 广播发现：唯一能拿到**协议版本**的途径（云端不给版本）
  cur = lanInfoCache[d];
  const needIp = !(cur && cur.ip);
  const needVer = !(cur && cur.version) && !versionHint[d];
  if (needIp || needVer) {
    const map = await discoverOnce(false);
    const hit = map[d];
    if (hit) {
      const base = lanInfoCache[d] || { ip: '', key: '', version: 0, category: '' };
      lanInfoCache[d] = {
        ip: base.ip || hit.ip || '',
        key: base.key || '',
        version: base.version || hit.version || 0,
        category: base.category || ''
      };
      if (hit.version && !versionHint[d]) versionHint[d] = hit.version;
    }
  }

  const final = lanInfoCache[d];
  if (!final || !final.ip || !final.key) return null;
  return final;
}

/** 试这台设备时要用的协议版本顺序：先猜过的，再候选表。 */
function candidateVersions(did) {
  const d = String(did);
  const out = [];
  const push = function (v) {
    const n = Number(v);
    if (n > 3 && n < 4 && out.indexOf(n) < 0) out.push(n);
  };
  push(versionHint[d]);
  push(lanInfoCache[d] && lanInfoCache[d].version);
  for (let i = 0; i < VERSION_CANDIDATES.length; i++) push(VERSION_CANDIDATES[i]);
  return out;
}

/* --------------------------------------------------------------- 设备缓存 */

/** 内部记录 → 宿主认的 Device 形状（**米家字段名**）。 */
function toMihaDevice(rec) {
  const info = categoryInfo(rec.category);
  return {
    did: String(rec.did),
    name: String(rec.name || rec.did),
    model: String(rec.productName || rec.productId || ''),
    // spec_type 会被宿主映射成 SmartDevice.urn。我们不靠它取 spec
    //（getSpecForDevice 按 did 查自己的映射表），但形状得像那么回事 ——
    // 给一个稳定、合法的 MIoT urn。
    spec_type: 'urn:miot-spec-v2:device:' + info.device + ':0000A001:tuya:1',
    room_id: '',
    room_name: '',
    home_id: HOME_ID,
    home_name: HOME_NAME,
    isOnline: rec.online !== false,
    token: String(rec.key || ''),
    local_ip: String(rec.ip || ''),
    parent_id: String(rec.parentId || ''),
    uid: String(rec.uuid || ''),
    pid: String(rec.productId || ''),
    icon: '',
    group_id: '',
    ssid: '',
    bssid: '',
    orderTime: 0,
    rssi: 0,
    extra: { fw_version: '' }
  };
}

/**
 * 拉一遍设备清单。
 *
 * ⚠️ **不还原涂鸦云的家庭 / 房间层级**：那要靠 `/v1.0/users/{uid}/homes`
 * 这类接口，而不同账号（项目维度 vs 账号维度）的开放程度不一样。
 * 猜出来的层级只会让用户看到"设备跑错房间"，所以统一收进一个
 * 「涂鸦设备」家庭 —— 宁可不猜。
 */
async function refreshDevices() {
  const recs = [];
  const seen = {};

  // ① 云端设备列表
  if (hasCloud()) {
    let list = [];
    try {
      list = await cloudListDevices(auth);
    } catch (e) {
      safeLog('error', TAG, '拉取云设备列表失败：' + describeError(e));
    }
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d.did || seen[d.did]) continue;
      seen[d.did] = true;
      if (d.category) categoryCache[d.did] = d.category;
      recs.push({
        did: d.did,
        name: d.name,
        category: d.category,
        productId: d.productId,
        productName: d.productName,
        online: d.online,
        ip: d.ip || '',
        uuid: d.uuid,
        key: ''
      });
    }
  }

  // ② 手填的设备（云端模式下作为补充 / 覆盖）
  for (let i = 0; i < manualDevices.length; i++) {
    const m = manualDevices[i];
    if (!m.did) continue;
    absorbManualLan(m);
    if (seen[m.did]) {
      for (let k = 0; k < recs.length; k++) {
        if (recs[k].did !== m.did) continue;
        if (m.key) recs[k].key = m.key;
        if (m.ip) recs[k].ip = m.ip;
        if (m.category) recs[k].category = m.category;
        if (m.name) recs[k].name = m.name;
        break;
      }
      continue;
    }
    seen[m.did] = true;
    recs.push({
      did: m.did,
      name: m.name || m.did,
      category: m.category || '',
      productId: '',
      productName: '',
      // 手填的设备无从判断在线状态，按"在线"处理：让真正的调用去失败并给出
      // 原因，比一上来就显示灰色离线要好（后者容易让人以为插件坏了）
      online: true,
      ip: m.ip || '',
      uuid: '',
      key: m.key || ''
    });
  }

  // ③ 把已知的局域网信息补进记录
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const cached = lanInfoCache[r.did];
    if (cached) {
      if (!r.ip && cached.ip) r.ip = cached.ip;
      if (!r.key && cached.key) r.key = cached.key;
      if (!r.category && cached.category) r.category = cached.category;
    }
  }

  // ④ 广播发现兜底补 IP / 版本（只补，不覆盖）
  const needDiscover = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const hint = versionHint[r.did] || (lanInfoCache[r.did] && lanInfoCache[r.did].version);
    if (!r.ip || !hint) needDiscover.push(r.did);
  }
  if (needDiscover.length > 0) {
    const map = await discoverOnce(false);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const hit = map[r.did];
      if (!hit) continue;
      if (!r.ip && hit.ip) r.ip = hit.ip;
      const base = lanInfoCache[r.did] || { ip: '', key: '', version: 0, category: '' };
      if (!base.ip && hit.ip) base.ip = hit.ip;
      if (!base.version && hit.version) base.version = hit.version;
      lanInfoCache[r.did] = base;
      if (hit.version && !versionHint[r.did]) versionHint[r.did] = hit.version;
      if (!r.ip && base.ip) r.ip = base.ip;
    }
  }

  // ⑤ 落成 Device 形状
  const out = {};
  for (let i = 0; i < recs.length; i++) {
    const dev = toMihaDevice(recs[i]);
    deviceCache[dev.did] = dev;
    out[dev.did] = dev;
  }
  return out;
}

/* -------------------------------------------------------------- 映射解析 */

/** 这台设备已知的品类码（云列表 / 云详情 / 手填 / 云 spec 都可能提供）。 */
function knownCategory(did) {
  const d = String(did);
  const manual = findManual(d);
  return categoryCache[d] || (manual && manual.category) || (lanInfoCache[d] && lanInfoCache[d].category) || '';
}

/**
 * 确保这台设备的 DP ⇄ MIoT 映射已经建好，返回映射对象。
 *
 * 三条来源按可靠性排序：
 *   ① 云 spec（有语义化 code，最准）
 *   ② 局域网 DP_QUERY（拿得到 dp id 和当前值，但不知道 code —— 借品类模板对号）
 *   ③ 品类参考模板（离线兜底，编号是"大概率"而非"保证"）
 *
 * 三条都拿不到时**抛错**：给一个只有"设备信息"服务的空 spec 比报错更糟 ——
 * 用户会看到一个没有任何控件的详情页，还查不出为什么。
 */
async function ensureMapping(did, _device) {
  const d = String(did);
  const cached = cachedMapping(d);
  if (cached) return cached;

  let category = knownCategory(d);

  // ① 云 spec
  if (hasCloud()) {
    const spec = await cloudGetSpec(auth, d);
    if (spec) {
      if (!category && spec.category) category = strOf(spec.category);
      const fns = functionsFromCloudSpec(spec);
      if (fns.length > 0) {
        if (category) categoryCache[d] = normDpCode(category);
        safeLog('info', TAG, '映射来源：云 spec（' + fns.length + ' 个功能点，品类 '
          + (category || '未知') + '）');
        return cacheMapping(d, buildMapping(category, fns));
      }
    }
  }

  // ② 局域网 DP_QUERY
  const info = await ensureLanInfo(d, null);
  if (info) {
    let dps = null;
    try {
      dps = await lanReadRaw(d, info, false);
    } catch (e) {
      safeLog('error', TAG, '读 DP 快照失败（' + d + '）：' + describeError(e));
    }
    if (dps && Object.keys(dps).length > 0) {
      const fns = functionsFromDps(dps, category);
      if (fns.length > 0) {
        safeLog('info', TAG, '映射来源：局域网 DP_QUERY（' + fns.length + ' 个功能点）');
        return cacheMapping(d, buildMapping(category, fns));
      }
    }
  }

  // ③ 品类参考模板
  const tplFns = functionsFromTemplate(category);
  if (tplFns.length > 0) {
    safeLog('info', TAG, '映射来源：品类参考模板（' + category + '，'
      + tplFns.length + ' 个功能点）');
    return cacheMapping(d, buildMapping(category, tplFns));
  }

  throw new Error(
    '读不到设备功能点：'
    + (hasCloud()
      ? '云端没有返回该设备的 specification，'
      : '当前没有配置云凭据，')
    + (info
      ? '局域网也读不到状态（设备离线？IP 或 localKey 不对？）'
      : '也连不上局域网（缺 IP / localKey）')
    + '。可在登录表单里手填「品类码」（如 dj / kg / wk）来套用参考模板。'
  );
}

/* ------------------------------------------------------------ 读写实现 */

/** 读一次 DP 快照，返回 { dpId 或 code: value }。 */
async function lanReadRaw(did, info, _keep) {
  const d = String(did);
  const candidates = candidateVersions(d);
  let lastErr = null;

  for (let i = 0; i < candidates.length; i++) {
    const version = candidates[i];
    const dev = new TuyaLanDevice(d, info.ip, info.key, version);
    try {
      const dps = await dev.withSession(function (session) {
        return dev.queryStatus(session);
      });
      if (dps && Object.keys(dps).length > 0) {
        versionHint[d] = version;
        if (lanInfoCache[d]) lanInfoCache[d].version = version;
        return dps;
      }
      lastErr = new Error('设备返回了空的 DP 快照');
    } catch (e) {
      lastErr = e;
      // 网络根本不通时换版本也没用，早停，别白等几个超时
      if (FATAL_NET_RE.test(describeError(e))) break;
    }
  }
  throw lastErr || new Error('局域网读取失败');
}

/** 局域网写一组 DP。失败抛错（宿主据此判定写失败）。 */
async function lanWriteRaw(did, info, dps) {
  const d = String(did);
  const candidates = candidateVersions(d);
  let lastErr = null;

  for (let i = 0; i < candidates.length; i++) {
    const version = candidates[i];
    const dev = new TuyaLanDevice(d, info.ip, info.key, version);
    try {
      await dev.withSession(function (session) {
        return dev.setDps(session, dps);
      });
      versionHint[d] = version;
      if (lanInfoCache[d]) lanInfoCache[d].version = version;
      return true;
    } catch (e) {
      lastErr = e;
      if (FATAL_NET_RE.test(describeError(e))) break;
    }
  }
  throw lastErr || new Error('局域网下发失败');
}

/**
 * 从一份 DP 快照里取某个映射条目对应的值。
 *
 * 快照的键可能是：
 *   - 数字 dp id（局域网 DP_QUERY 的常态）
 *   - dp code 字符串（涂鸦云 /status 的返回；部分 ≥3.4 固件的局域网回包）
 * 两种都试。取不到返回 undefined —— 语义是"读到了但没这个属性"，**不是**读失败。
 */
function lookupDpValue(dps, entry) {
  if (!dps || !entry) return undefined;
  if (entry.dpId !== null && entry.dpId !== undefined) {
    const k = String(entry.dpId);
    if (dps[k] !== undefined) return dps[k];
  }
  if (entry.code && dps[entry.code] !== undefined) return dps[entry.code];
  return undefined;
}

/* ----------------------------------------------------- 批量读（模块函数，不吃 this） */

/**
 * 批量读的公共实现。
 *
 * 刻意做成**模块级函数**而不是 Plugin.register 里的方法：宿主未必保证
 * 以 `plugin.getProperties(...)` 的形式调用（有些实现会把方法摘出来再调），
 * 那样 `this` 就丢了。mijia-cloud 里用了 `this.callAction`，说明宿主大概率
 * 是正常调的 —— 但我们没必要冒这个险。
 */
async function readPropertiesInternal(transportId, did, params) {
  const d = didOf(did) || String(did || '');
  if (!d) throw new Error('读属性缺少 did');
  const list = isArray(params) ? params : [];
  if (list.length === 0) return [];

  const mapping = await ensureMapping(d, null);

  // 一次快照覆盖全部请求项 —— 局域网读一次比读 N 次省太多
  let dps;
  if (transportId === 'cloud') {
    if (!hasCloud()) throw new Error('没有可用的云凭据');
    dps = await cloudGetDeviceStatus(auth, d);
    if (!dps) throw new Error('云端读取设备状态失败（' + d + '）');
  } else {
    const info = await ensureLanInfo(d, null);
    if (!info) {
      throw new Error('设备 ' + d + ' 没有可用的局域网信息（缺 IP 或 localKey）');
    }
    dps = await lanReadRaw(d, info, false);
  }

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i] || {};
    const entry = findEntry(mapping, p.siid, p.piid);
    if (!entry) {
      // 宿主问了一个 spec 里没有的属性 —— 不是读失败，如实返回 undefined
      out.push({ did: d, siid: p.siid, piid: p.piid, value: undefined });
      continue;
    }
    const raw = lookupDpValue(dps, entry);
    out.push({
      did: d,
      siid: Number(p.siid),
      piid: Number(p.piid),
      value: dpValueToMiot(entry, raw)
    });
  }
  return out;
}

/* ================================================================= 注册 */

Plugin.register({
  /**
   * ① 初始化。幂等：ArkWeb 重建后会被再调一次。
   * 只有"没有可用凭据"才返回 false（宿主据此显示登录入口）。
   */
  async init(ctx) {
    pluginCtx = ctx || null;
    try {
      auth = await loadAuth();
      if (!auth) return false;
      syncManualFromAuth();
      for (let i = 0; i < manualDevices.length; i++) absorbManualLan(manualDevices[i]);

      if (auth.mode === 'cloud') {
        if (!auth.accessId || !auth.accessSecret) {
          safeLog('error', TAG, '凭据里缺 accessId / accessSecret');
          return false;
        }
        if (!auth.endpoint) auth.endpoint = resolveEndpoint(auth.region);
        // ⚠️ 这里**不**刷新 token：init 阶段只做本地的事，网络交互一律推迟到
        // 真正需要的时候（cloudFetchRetry 自己会按需刷新）。否则冷启动会被一次
        // 外呼卡住，用户看到的是"已登录但一直转圈"。
      } else if (manualDevices.length === 0) {
        safeLog('error', TAG, '局域网模式下没有配置任何设备');
        return false;
      }

      // 清掉上一轮的发现缓存（页面重建后 socket 回调注册表也清空了；我们本来就
      // "一请求一连接"，没有需要重新注册的常驻回调）
      discoveryCache = null;
      safeLog('info', TAG, '已载入配置：模式=' + auth.mode
        + '，手填设备=' + manualDevices.length + ' 台');
      return true;
    } catch (e) {
      safeLog('error', TAG, 'init 失败：' + describeError(e));
      return false;
    }
  },

  /**
   * ② 登录视图：一张表单同时覆盖两种接入方式。
   *
   * `form` 的字段类型只有 text / password / switch，且**所有值都是字符串**
   * （switch 给的是 'true' / 'false'）。宿主不支持"按开关显示/隐藏字段"，
   * 所以两套字段都摆出来，提交时按 useCloud 取用对应的一半。
   */
  async loginBegin() {
    return {
      sessionId: 'tuya-' + Date.now(),
      view: {
        type: 'form',
        fields: [
          {
            key: 'useCloud',
            label: '使用涂鸦云 OpenAPI（关闭则纯局域网）',
            type: 'switch',
            default: 'true'
          },
          {
            key: 'accessId',
            label: '云 Access ID',
            type: 'text',
            placeholder: '涂鸦 IoT 平台的 Access ID / Client ID'
          },
          {
            key: 'accessSecret',
            label: '云 Access Secret',
            type: 'password',
            placeholder: '只存在本机，不会上传到别处'
          },
          {
            key: 'region',
            label: '数据中心',
            type: 'text',
            default: 'cn',
            placeholder: 'cn / us / eu / in，或完整域名'
          },
          {
            key: 'devices',
            label: '局域网设备（每行一台，多台用分号隔开）',
            type: 'text',
            placeholder: '设备ID,localKey,IP[,协议版本][,名称]'
          },
          {
            key: 'category',
            label: '默认品类码（可选）',
            type: 'text',
            placeholder: '如 dj / kg / wk / cl，用于套用参考模板'
          }
        ],
        submitLabel: '保存并连接'
      }
    };
  },

  /**
   * ③ 提交。
   *
   * 云模式会**真发一次换 token 的请求**来校验凭据 —— 与其让用户以为登录成功、
   * 进列表才发现一个设备都没有，不如当场报错。
   * 局域网模式只做本地解析与格式校验（不联机：设备可能在旁边但没开机，
   * 那不该拦住用户保存配置）。
   *
   * 手填设备是**累加**的：再次登录只填云凭据不会把手填的局域网设备冲掉。
   */
  async loginSubmit(_sessionId, fields) {
    const f = fields || {};
    const useCloud = strOf(f.useCloud) !== 'false';
    const defaultCategory = normDpCode(f.category);

    const prevManual = (auth && isArray(auth.manual)) ? auth.manual.slice() : manualDevices.slice();

    let parsedManual = [];
    try {
      parsedManual = parseManualText(f.devices, defaultCategory);
    } catch (e) {
      return { state: 'error', message: '设备列表解析失败：' + describeError(e) };
    }

    if (useCloud) {
      const accessId = strOf(f.accessId);
      const accessSecret = strOf(f.accessSecret);
      if (!accessId || !accessSecret) {
        return { state: 'error', message: '请填写云 Access ID 与 Access Secret' };
      }
      const region = strOf(f.region) || 'cn';
      const candidate = {
        mode: 'cloud',
        accessId: accessId,
        accessSecret: accessSecret,
        region: region,
        endpoint: resolveEndpoint(region),
        accessToken: '',
        refreshToken: '',
        expireTime: 0,
        uid: '',
        manual: []
      };
      try {
        await cloudGetToken(candidate);
      } catch (e) {
        return { state: 'error', message: '云凭据校验失败：' + describeError(e) };
      }

      auth = candidate;
      mergeManual(prevManual, parsedManual);
      auth.manual = manualDevices.slice();

      // 顺手拉一次，好让用户立刻看到设备；拉不到也不阻断登录
      try {
        await refreshDevices();
      } catch (e) {
        safeLog('error', TAG, '登录后拉取设备失败：' + describeError(e));
      }
      await saveAuth();
      safeLog('info', TAG, '云模式登录成功，uid=' + (auth.uid || '?'));
      return { state: 'success' };
    }

    // ── 纯局域网 ──────────────────────────────────────────────
    if (parsedManual.length === 0 && prevManual.length === 0) {
      return {
        state: 'error',
        message: '局域网模式下至少要填一台设备，格式：设备ID,localKey,IP[,协议版本][,名称]'
      };
    }
    // localKey 必须是 16 个字符 —— 早点拦住比等连接超时好
    for (let i = 0; i < parsedManual.length; i++) {
      const e = parsedManual[i];
      if (!e.key) continue;
      const keyLen = latin1Bytes(e.key).length;
      if (keyLen !== 16) {
        return {
          state: 'error',
          message: '设备 ' + e.did + ' 的 localKey 长度是 ' + keyLen + '，应为 16 个字符'
        };
      }
    }

    auth = {
      mode: 'local',
      region: '',
      endpoint: '',
      accessId: '',
      accessSecret: '',
      accessToken: '',
      refreshToken: '',
      expireTime: 0,
      uid: '',
      manual: []
    };
    mergeManual(prevManual, parsedManual);
    auth.manual = manualDevices.slice();
    for (let i = 0; i < manualDevices.length; i++) absorbManualLan(manualDevices[i]);
    await saveAuth();
    safeLog('info', TAG, '局域网模式已保存 ' + manualDevices.length + ' 台设备');
    return { state: 'success' };
  },

  /** form 视图没有轮询。**不能抛错** —— 宿主连续 3 次失败就判登录失败并关弹窗。 */
  async loginPoll() {
    return { state: 'pending' };
  },

  async loginCancel() {
    return { state: 'cancelled' };
  },

  /**
   * ④ 家庭容器。
   *
   * ⚠️ 字段名必须是 `id` / `name` / `uid` / `dids` / `roomlist`。
   * 写成 roomIds / deviceIds 的话宿主会解析出一个空家庭（它不会猜字段名）。
   */
  async getHomes() {
    const dids = [];
    const keys = Object.keys(deviceCache);
    for (let i = 0; i < keys.length; i++) dids.push(keys[i]);
    return [{
      id: HOME_ID,
      name: HOME_NAME,
      uid: (auth && auth.uid) ? String(auth.uid) : 'tuya',
      dids: dids,
      roomlist: []
    }];
  },

  /** ⑤ 设备列表。key 必须是 did，值必须是 JSON 可序列化的普通对象。 */
  async getDevices() {
    const out = await refreshDevices();
    const n = Object.keys(out).length;
    if (n === 0) {
      safeLog('error', TAG, '设备列表为空（云账号下没有授权设备？或者手填设备没填对？）');
    } else {
      safeLog('info', TAG, '设备列表 ' + n + ' 台');
    }
    return out;
  },

  /**
   * ⑥ 能力描述 —— 真正实现，因为 plugin.json 里 capabilities.spec = true。
   * 返回 MIoT instance JSON，宿主自己解析（与内置 mijia-cloud 的契约一致）。
   */
  async getSpecForDevice(device) {
    const did = didOf(device);
    if (!did) throw new Error('getSpecForDevice 缺少 did');
    const m = await ensureMapping(did, device);
    return m.spec;
  },

  /**
   * ⑦ 控制通道。priority 小的先试。
   *
   * 局域网排前面：更快、不烧云配额。但**能不能真的用**交给
   * `isTransportAvailable` 判断 —— 宿主对写操作"只在第一条可用通道上执行一次、
   * 失败不重试"，所以这里宁可多列一条，让可用性判断去兜底。
   */
  async createTransports(device) {
    const did = didOf(device);
    const out = [];
    const cached = lanInfoCache[did];
    const manual = findManual(did);
    const canLan = !!((cached && cached.ip && cached.key) || (manual && manual.ip && manual.key));
    if (canLan || hasCloud() || manual) {
      out.push({ id: 'lan', kind: 'lan', priority: 10 });
    }
    if (hasCloud()) {
      out.push({ id: 'cloud', kind: 'cloud', priority: 100 });
    }
    return out;
  },

  /**
   * 可选钩子：宿主每次发起调用前问一次。
   *
   * ⚠️ 这里的返回值**直接决定写操作走哪条通道**，所以局域网的判断必须保守：
   * 只有真的凑齐 ip + localKey 才说"可用"，否则让宿主落到云端通道。
   * （默认不可用会让没实现它的设备彻底点不动，所以只在"明知必然失败"时返回 false。）
   */
  async isTransportAvailable(transportId, device) {
    if (transportId === 'cloud') return hasCloud();
    if (transportId !== 'lan') return false;
    if (device && device.isOnline === false) return false;
    const did = didOf(device);
    if (!did) return false;
    try {
      const info = await ensureLanInfo(did, device);
      return !!info;
    } catch (e) {
      return false;
    }
  },

  /** ⑧ 读单个属性。读失败 throw；"读到但没这个属性"返回 undefined。 */
  async getProperty(transportId, did, siid, piid) {
    const list = await readPropertiesInternal(transportId, did, [{ siid: siid, piid: piid }]);
    return list.length > 0 ? list[0].value : undefined;
  },

  /**
   * ⑨ 批量读。
   *
   * 兼容两种调用形状（宿主版本间有过差异，两种都接住更稳）：
   *   (transportId, did, [{siid,piid}])   ← 与内置 mijia-cloud 一致
   *   (device, [{siid,piid}])             ← 协议参考文档里的写法
   */
  async getProperties(transportId, did, params) {
    if (!isArray(params) && isArray(did)) {
      params = did;
      did = didOf(transportId);
      transportId = 'lan';
    }
    return readPropertiesInternal(transportId, did, params || []);
  },

  /**
   * ⑩ 写属性。
   *
   * ⚠️ 失败必须 throw —— 返回 false / undefined 会被宿主当成功。
   * ⚠️ 同 getProperties，兼容 `(device, siid, piid, value)` 的短形状。
   */
  async setProperty(transportId, did, siid, piid, value) {
    if (typeof did === 'number') {
      // 短形状：(device, siid, piid, value)
      value = piid;
      piid = siid;
      siid = did;
      did = didOf(transportId);
      transportId = 'lan';
    }
    const d = didOf(did) || String(did || '');
    if (!d) throw new Error('写属性缺少 did');

    const mapping = await ensureMapping(d, null);
    const entry = findEntry(mapping, siid, piid);
    if (!entry) {
      throw new Error('设备 ' + d + ' 的能力描述里没有 siid=' + siid + ' piid=' + piid
        + '，拒绝写入');
    }

    const dpValue = miotValueToDp(entry, value);

    if (transportId === 'cloud') {
      if (!hasCloud()) throw new Error('没有可用的云凭据');
      // 云侧按 code 寻址
      await cloudSetDeviceStatus(auth, d, [{ code: entry.code, value: dpValue }]);
      safeLog('info', TAG, '云写 ' + d + ' ' + entry.code + '=' + JSON.stringify(dpValue));
      return value;
    }

    const info = await ensureLanInfo(d, null);
    if (!info) {
      throw new Error('设备 ' + d + ' 没有可用的局域网信息（缺 IP 或 localKey）');
    }
    const version = versionHint[d] || info.version || 0;
    if (!isEntryAddressable(entry, version)) {
      throw new Error(
        '功能点 ' + entry.code + ' 在局域网协议 ' + (version || '未知') + ' 下无法寻址：'
        + '云端没给出该功能的 dp 编号，而 3.4 以下的固件只认数字编号。'
        + '请改用云端通道下发，或在登录表单里手填正确的协议版本。'
      );
    }
    const dps = {};
    dps[dpPayloadKey(entry)] = dpValue;
    await lanWriteRaw(d, info, dps);
    safeLog('info', TAG, '局域网写 ' + d + ' ' + entry.code + '=' + JSON.stringify(dpValue)
      + '（协议 ' + version + '）');
    return value;
  },

  /**
   * ⑪ 执行动作。
   *
   * 涂鸦**没有 MIoT 的动作模型**（DP 就是一切），所以我们生成的 spec 里
   * `actions` 恒为空数组，宿主不会调到这里。真被调到，说明有别的代码在做假设 ——
   * 这时必须明确报错，而不是假装成功。
   */
  async callAction(transportId, did, siid, aiid, _inList) {
    if (typeof did === 'number') {
      aiid = siid;
      siid = did;
      did = didOf(transportId);
    }
    throw new Error(
      '涂鸦设备不支持动作调用（siid=' + siid + ' aiid=' + aiid + '）：'
      + '涂鸦的数据模型里只有功能点（DP），控制请通过属性写入完成。'
    );
  },

  /**
   * ⑫ 销毁。本插件没有常驻 socket / 定时器（每次读写都是"开→用→关"），
   * 所以这里只清运行时缓存，**不清凭据** —— 清了用户就得重新登录一遍。
   */
  async dispose() {
    clearMappingCache();
    lanInfoCache = {};
    deviceCache = {};
    categoryCache = {};
    discoveryCache = null;
    versionHint = {};
    pluginCtx = null;
    safeLog('info', TAG, '已释放运行时缓存');
  }
});

