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
