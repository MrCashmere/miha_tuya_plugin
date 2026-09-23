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
