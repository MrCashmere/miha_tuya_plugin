/* ============================================================================
 * §8.5  涂鸦手机端云 API（扫码登录那条路）
 *
 * ## 为什么有两条云路径
 *
 * 涂鸦有两套完全不同的云接口：
 *
 *   | | 开放平台 OpenAPI（§8） | 手机端 App API（本文件） |
 *   | --- | --- | --- |
 *   | 凭据 | 开发者账号 accessId / accessSecret | **账号扫码登录** |
 *   | 路径 | `/v1.0/iot-03/...` | `/v1.0/m/life/...`、`/v1.0/m/thing/...` |
 *   | 限制 | 试用版 1 个月、最多 50 台、只能控制 10 台 | 无这些限制 |
 *
 * 开放平台那条**只给 1 个月试用**，过期后全部返回 28841002（订阅过期）。
 * 而 `tuya-local` 与 HA 主线官方集成走的都是**扫码这条路**，所以它是主路径，
 * 开放平台那条保留下来只为兼容旧配置。
 *
 * ## 从哪来的
 *
 * 对照 `tuya_sharing`（tuya-device-sharing-sdk）的 `user.py` / `customerapi.py`
 * / `manager.py` / `device.py` / `home.py` 逐行移植。那个 SDK 是涂鸦官方维护、
 * HA 主线在用的，`client_id` / `schema` 也是官方发给 HA 的，不是逆向出来的。
 *
 * ## 两条链路
 *
 *   ① **换二维码 / 轮询扫码结果**：`apigw.iotbing.com`，**完全不需要签名**
 *   ② **业务接口**：登录结果里带回来的 `endpoint`，需要一套自成一体的签名
 *
 * ## 业务接口的签名（三步，对照 `customerapi.py` 的 `__request`）
 *
 *   hashKey = md5(rid + refresh_token)                      ← 十六进制
 *   secret  = hmacSha256(key = rid, msg = hashKey).hex[:16] ← 十六进制前 16 位
 *   X-sign  = hmacSha256(key = hashKey,
 *                        msg = "X-appKey=..||X-requestId=..||X-time=.."
 *                              + 加密后的 query + 加密后的 body)
 *
 * 载荷（query 参数 / body）用 `secret` 做 **AES-128-GCM**，nonce 12 字节：
 *
 *   密文串 = base64(nonce) + base64(ciphertext + tag)
 *   query  → `{"encdata": 密文串}`（放到 query string 里）
 *   body   → `{"encdata": 密文串}`
 *
 * 响应里的 `result` 用**同一个 secret** 解密后才是 JSON。
 *
 * ⚠️ 拼接 base64 而不是 base64(拼接)：12 字节的 base64 恰好 16 字符且无填充、
 *    长度是 4 的倍数，所以整体解码后正好是 nonce + 密文 —— 这个"巧合"是协议
 *    的一部分，照抄就好，别自作聪明改成 base64(nonce || ct)。
 * ⚠️ 签名里 query / body 的密文串**不 URL 编码**（URL 里那份才编码）。
 * ========================================================================== */

/** 涂鸦官方发给 Home Assistant 的 client_id / schema（HA 主线用的就是这两个）。 */
const MOBILE_APP_KEY = 'HA_3y9q4ak7g4ephrvke';
const MOBILE_SCHEMA = 'haauthorize';

/** 日志用的标签（不复用 50-plugin.js 的 TAG，避免拼接后名字撞车）。 */
const TAG_MOBILE = 'tuya-cloud';

/** 换二维码与轮询的固定入口（业务接口用登录返回的 endpoint）。 */
const MOBILE_LOGIN_HOST = 'https://apigw.iotbing.com';

/** 仅自检用：把 rid / nonce 固定下来，密文与签名才可复现。正常路径一律随机。 */
let MOBILE_TEST_RID = null;
let MOBILE_TEST_NONCE = null;

function mobileSetTestVector(rid, nonce) {
  MOBILE_TEST_RID = rid || null;
  MOBILE_TEST_NONCE = nonce || null;
}

/* ------------------------------------------------------------ 小工具 */

/**
 * 协议里的 JSON 是紧凑的（Python 的 `separators=(",", ":")`）。
 *
 * ⚠️ 还要**把非 ASCII 转义成 `\uXXXX`** —— Python 的 `json.dumps` 默认
 *    `ensure_ascii=True` 就是这么干的。功能上两种写法解析结果一样，但字节层面
 *    不同，会让密文和签名对不上官方 SDK。要和参照实现逐字节对齐就得照做。
 */
function mobileCompactJson(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, function (ch) {
    return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
}

/** nonce 用的字符表 —— 照抄 SDK 的 `_random_nonce`。 */
const MOBILE_NONCE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

async function mobileRandomNonce(n) {
  if (MOBILE_TEST_NONCE) return MOBILE_TEST_NONCE.substring(0, n);
  const bytes = await randomBytesOrPseudoAsync(n);
  let s = '';
  for (let i = 0; i < n; i++) {
    s += MOBILE_NONCE_ALPHABET.charAt(bytes[i] % MOBILE_NONCE_ALPHABET.length);
  }
  return s;
}

function mobileUuid() {
  if (MOBILE_TEST_RID) return MOBILE_TEST_RID;
  const b = pseudoRandomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = bytesToHex(b);
  return hex.substring(0, 8) + '-' + hex.substring(8, 12) + '-' + hex.substring(12, 16)
    + '-' + hex.substring(16, 20) + '-' + hex.substring(20, 32);
}

/* -------------------------------------------------------- 签名与加密 */

/** `hashKey = md5(rid + refresh_token)`。 */
function mobileHashKey(rid, refreshToken) {
  return md5Hex(utf8Bytes(rid + String(refreshToken || '')));
}

/** `secret = hmacSha256(rid, hashKey).hex[:16]` —— 16 个 ASCII 字符，正好一个 AES-128 密钥。 */
function mobileSecret(rid, hashKey) {
  return bytesToHex(hmacSha256Bytes(utf8Bytes(rid), utf8Bytes(hashKey))).substring(0, 16);
}

/** 头部参与签名的字段与**固定顺序**。空值跳过，用 `||` 连接，末尾不带 `||`。 */
const MOBILE_SIGN_HEADERS = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token'];

function mobileSignStr(headers, queryEnc, bodyEnc) {
  const parts = [];
  for (let i = 0; i < MOBILE_SIGN_HEADERS.length; i++) {
    const k = MOBILE_SIGN_HEADERS[i];
    const v = headers[k];
    if (v !== undefined && v !== null && String(v) !== '') {
      parts.push(k + '=' + String(v));
    }
  }
  // 注意：头部串与密文串之间**没有分隔符**，query 与 body 之间也没有
  return parts.join('||') + (queryEnc || '') + (bodyEnc || '');
}

function mobileSign(hashKey, headers, queryEnc, bodyEnc) {
  const str = mobileSignStr(headers, queryEnc, bodyEnc);
  return bytesToHex(hmacSha256Bytes(utf8Bytes(hashKey), utf8Bytes(str)));
}

/** 明文 → 密文串（base64(nonce) + base64(ct+tag)）。 */
async function mobileEncrypt(plainText, secret) {
  const nonce = await mobileRandomNonce(12);
  const r = aesGcmEncrypt(
    utf8Bytes(secret),
    latin1Bytes(nonce),
    new Uint8Array(0),
    utf8Bytes(plainText)
  );
  return bytesToB64(latin1Bytes(nonce)) + bytesToB64(bytesConcat([r.cipher, r.tag]));
}

/** 密文串 → 明文。解不开会抛错（密钥/结构不对时的唯一信号）。 */
function mobileDecrypt(cipherText, secret) {
  const all = b64ToBytes(String(cipherText));
  if (all.length < 12 + 16) throw new Error('云端返回的密文长度不对');
  const nonce = all.subarray(0, 12);
  const rest = all.subarray(12);
  const cipher = rest.subarray(0, rest.length - 16);
  const tag = rest.subarray(rest.length - 16);
  const plain = aesGcmDecrypt(utf8Bytes(secret), nonce, new Uint8Array(0), cipher, tag);
  return bytesUtf8(plain);
}

/* ------------------------------------------------------------ 令牌 */

/** 统一读 token 字段 —— 扫码结果用 snake_case，刷新的结果用 camelCase。 */
function mobileReadTokenFields(result) {
  if (!result || typeof result !== 'object') return null;
  const accessToken = result.access_token || result.accessToken || '';
  if (!accessToken) return null;
  const expireSeconds = Number(result.expire_time || result.expireTime || 7200);
  return {
    accessToken: String(accessToken),
    refreshToken: String(result.refresh_token || result.refreshToken || ''),
    expireTime: Date.now() + (isFinite(expireSeconds) && expireSeconds > 0 ? expireSeconds : 7200) * 1000,
    uid: String(result.uid || '')
  };
}

/**
 * 确保 access_token 可用（提前 60 秒刷新）。
 * `_refreshing` 是重入闸门：刷新请求本身也要走 `mobileRequest`，
 * 没有这个标记会无限递归（SDK 里的 `self.refresh_token` 是同一个作用）。
 */
async function mobileEnsureToken(auth) {
  if (auth.accessToken && auth.expireTime && Date.now() < auth.expireTime - 60000) {
    return auth;
  }
  if (!auth.refreshToken) {
    throw new Error('涂鸦登录已失效，请重新扫码登录');
  }
  auth._refreshing = true;
  try {
    const result = await mobileRequest(auth, 'GET', '/v1.0/m/token/' + auth.refreshToken, null, null);
    const f = mobileReadTokenFields(result);
    if (!f) throw new Error('刷新令牌的返回里没有 accessToken');
    auth.accessToken = f.accessToken;
    if (f.refreshToken) auth.refreshToken = f.refreshToken;
    auth.expireTime = f.expireTime;
    if (f.uid) auth.uid = f.uid;
  } finally {
    auth._refreshing = false;
  }
  return auth;
}

/* ------------------------------------------------------------ 请求 */

/**
 * 发一次手机端业务请求，返回解密后的 `result`。
 *
 * ⚠️ 手机端接口的响应结构是 `{success, code, msg, result}`，且 **result 恒为密文**。
 */
async function mobileRequest(auth, method, path, params, body) {
  if (!auth.endpoint) {
    throw new Error('缺少云端接入点 endpoint，请重新扫码登录');
  }
  if (!auth._refreshing) {
    await mobileEnsureToken(auth);
  }

  const rid = mobileUuid();
  const sid = '';
  const hashKey = mobileHashKey(rid, auth.refreshToken);
  const secret = mobileSecret(rid, hashKey);

  let queryEnc = '';
  let hasQuery = false;
  if (params && Object.keys(params).length > 0) {
    queryEnc = await mobileEncrypt(mobileCompactJson(params), secret);
    hasQuery = true;
  }
  let bodyEnc = '';
  let bodyText = '';
  if (body && Object.keys(body).length > 0) {
    bodyEnc = await mobileEncrypt(mobileCompactJson(body), secret);
    bodyText = mobileCompactJson({ encdata: bodyEnc });
  }

  const headers = {
    'X-appKey': MOBILE_APP_KEY,
    'X-requestId': rid,
    'X-sid': sid,
    'X-time': String(Date.now())
  };
  if (auth.accessToken) headers['X-token'] = auth.accessToken;
  headers['X-sign'] = mobileSign(hashKey, headers, queryEnc, bodyEnc);

  let url = auth.endpoint + path;
  if (hasQuery) {
    url += (path.indexOf('?') >= 0 ? '&' : '?') + 'encdata=' + encodeURIComponent(queryEnc);
  }

  const sendHeaders = Object.assign({ 'Content-Type': 'application/json' }, headers);
  let res;
  try {
    if (method === 'GET' || method === 'DELETE') {
      res = await Host.http(method, url, sendHeaders);
    } else {
      res = await Host.http(method, url, sendHeaders, bodyText);
    }
  } catch (e) {
    throw new Error('云请求失败（' + method + ' ' + path + '）：' + describeError(e));
  }

  const parsed = mobileParseHttp(res, method, path);
  if (parsed && parsed.success === false) {
    const code = parsed.code;
    const msg = parsed.msg || parsed.message || '未知错误';
    const err = new Error('涂鸦云拒绝（code=' + code + '）：' + msg);
    err.tuyaCode = code;
    throw err;
  }

  const raw = parsed ? parsed.result : null;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return raw;

  try {
    const plain = mobileDecrypt(raw, secret);
    try {
      return JSON.parse(plain);
    } catch (e) {
      return plain; // 不是 JSON 就把明文原样给出
    }
  } catch (e) {
    throw new Error('云端返回解密失败（' + describeError(e) + '）');
  }
}

function mobileParseHttp(res, method, path) {
  if (!res) throw new Error('云请求没有返回（' + method + ' ' + path + '）');
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(
      '云返回不是 JSON（HTTP ' + res.status + '）：' + String(res.body || '').substring(0, 120)
    );
  }
  return parsed;
}

/* -------------------------------------------------------- 扫码登录 */

/**
 * 换一张二维码。
 * 这一步**不需要签名**，是普通 HTTP —— 所以「扫码」这条路在纯 JS 里很轻。
 */
async function mobileQrCreate(userCode) {
  const url = MOBILE_LOGIN_HOST + '/v1.0/m/life/home-assistant/qrcode/tokens'
    + '?clientid=' + encodeURIComponent(MOBILE_APP_KEY)
    + '&usercode=' + encodeURIComponent(userCode)
    + '&schema=' + encodeURIComponent(MOBILE_SCHEMA);

  let res;
  try {
    res = await Host.http('POST', url, { 'Content-Type': 'application/json' });
  } catch (e) {
    throw new Error('获取登录二维码失败（网络不通？）：' + describeError(e));
  }
  const parsed = mobileParseHttp(res, 'POST', '/v1.0/m/life/home-assistant/qrcode/tokens');
  if (!parsed.success) {
    throw new Error('获取登录二维码被拒绝（code=' + parsed.code + '）：' + (parsed.msg || '未知错误'));
  }
  const token = parsed.result && parsed.result.qrcode;
  if (!token) throw new Error('登录二维码返回里没有 qrcode 字段');
  return String(token);
}

/**
 * 轮询扫码结果。
 *
 * ⚠️ **"还没扫"时接口返回 `success: false`，这不叫失败** —— 必须映射成
 *    `{ ok: false }` 让上层返回 `pending`。抛错的话宿主连续 3 次就判登录失败、
 *    把弹窗关掉，用户扫到一半就没了。
 */
async function mobileQrPoll(userCode, token) {
  const url = MOBILE_LOGIN_HOST + '/v1.0/m/life/home-assistant/qrcode/tokens/'
    + encodeURIComponent(token)
    + '?clientid=' + encodeURIComponent(MOBILE_APP_KEY)
    + '&usercode=' + encodeURIComponent(userCode);

  const res = await Host.http('GET', url, {});
  const parsed = mobileParseHttp(res, 'GET', '/qrcode/tokens/{token}');
  if (!parsed.success) {
    return { ok: false, code: parsed.code, msg: parsed.msg || parsed.message || '' };
  }
  return { ok: true, result: parsed.result || {}, t: parsed.t };
}

/** 把扫码结果里的登录信息落成我们的 auth 结构。 */
function mobileAuthFromLogin(userCode, loginResult) {
  const r = loginResult || {};
  const endpoint = String(r.endpoint || '');
  const terminalId = String(r.terminal_id || r.terminalId || '');
  if (!endpoint) throw new Error('扫码结果里没有 endpoint，无法继续');
  const auth = {
    mode: 'account',
    userCode: String(userCode || ''),
    terminalId: terminalId,
    endpoint: endpoint.replace(/\/+$/, ''),
    accessToken: '',
    refreshToken: '',
    expireTime: 0,
    uid: '',
    manual: []
  };
  const f = mobileReadTokenFields(r);
  if (!f) throw new Error('扫码结果里没有 access_token');
  auth.accessToken = f.accessToken;
  auth.refreshToken = f.refreshToken;
  auth.expireTime = f.expireTime;
  auth.uid = f.uid;
  return auth;
}

/* ------------------------------------------------------ 数据面：家庭 */

/** 家庭列表。SDK 拿 `ownerId` 当家庭 id。 */
async function mobileGetHomes(auth) {
  const result = await mobileRequest(auth, 'GET', '/v1.0/m/life/users/homes', null, null);
  const out = [];
  const list = asArray(result);
  for (let i = 0; i < list.length; i++) {
    const h = list[i] || {};
    const id = String(h.ownerId || h.gid || h.id || '');
    if (!id) continue;
    out.push({ id: id, name: String(h.name || id) });
  }
  return out;
}

/** 某个家庭下的设备（含 local_key 与 ip —— 这是云端最值钱的两个字段）。 */
async function mobileGetDevicesByHome(auth, homeId) {
  const result = await mobileRequest(
    auth, 'GET', '/v1.0/m/life/ha/home/devices', { homeId: String(homeId) }, null
  );
  return asArray(result);
}

/** 设备详情（按 id 批量）。MQ 掉线、缓存过期时补数据用。 */
async function mobileGetDevicesByIds(auth, ids) {
  if (!ids || ids.length === 0) return [];
  const result = await mobileRequest(
    auth, 'GET', '/v1.0/m/life/ha/devices/detail', { devIds: ids.join(',') }, null
  );
  return asArray(result);
}

/** 设备所在房间（一次一台设备）。 */
async function mobileGetRoomByDevice(auth, did) {
  const result = await mobileRequest(auth, 'GET', '/v1.0/m/thing/ha/' + did + '/room', null, null);
  if (!result || typeof result !== 'object') return null;
  const id = String(result.id || '');
  if (!id) return null;
  return {
    id: id,
    name: String(result.name || ''),
    order: numOr(result.displayOrder, 0)
  };
}

/* ------------------------------------------------ 数据面：功能点与规格 */

/**
 * 设备的 DP 关系表：`GET /v1.0/m/life/devices/{did}/status`。
 *
 * 返回的 `dpStatusRelationDTOS` 直接给出 **dpId ↔ statusCode(dpCode)** 的对应，
 * 还带 `valueType` / `valueDesc` / `enumMappingMap` / `supportLocal`。
 * 这比开放平台的 specification 接口强 —— 后者不一定给 dp_id，
 * 而局域网读写恰恰需要 dp 编号。
 */
async function mobileGetDpRelations(auth, did) {
  const result = await mobileRequest(auth, 'GET', '/v1.0/m/life/devices/' + did + '/status', null, null);
  if (!result || typeof result !== 'object') return null;
  const list = asArray(result.dpStatusRelationDTOS);
  const byCode = {};
  const byId = {};
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    const code = String(it.statusCode || it.dpCode || '');
    const dpId = (it.dpId === undefined || it.dpId === null) ? null : numOr(it.dpId, null);
    if (!code && dpId === null) continue;
    const rec = {
      dpId: dpId,
      code: code,
      valueType: String(it.valueType || ''),
      valueDesc: String(it.valueDesc || ''),
      enumMappingMap: it.enumMappingMap || null,
      supportLocal: it.supportLocal !== false
    };
    if (code) byCode[code] = rec;
    if (dpId !== null) byId[String(dpId)] = rec;
  }
  return {
    productKey: String(result.productKey || ''),
    byCode: byCode,
    byId: byId,
    supportLocal: list.length > 0 && list.every(function (x) { return x && x.supportLocal !== false; })
  };
}

/**
 * 设备的规格（functions / status）。
 *
 * 把 `dpId` 从 DP 关系表合并进来 —— 这样映射层能同时拿到
 * **语义化的 code** 和**局域网要用的 dp 编号**，是三条来源里最全的一份。
 */
async function mobileGetSpec(auth, did) {
  const spec = await mobileRequest(auth, 'GET', '/v1.1/m/life/' + did + '/specifications', null, null);
  if (!spec || typeof spec !== 'object') return null;

  let relations = null;
  try {
    relations = await mobileGetDpRelations(auth, did);
  } catch (e) {
    safeLog('error', TAG_MOBILE, '取 DP 关系表失败 ' + did + '：' + describeError(e));
  }

  const out = { category: '', functions: [], status: [] };
  const groups = ['functions', 'status'];
  for (let g = 0; g < groups.length; g++) {
    const arr = asArray(spec[groups[g]]);
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i] || {};
      const code = String(it.code || '');
      if (!code) continue;
      const rel = relations ? relations.byCode[code] : null;
      out[groups[g]].push({
        code: code,
        type: it.type,
        values: it.values,
        // 关系表里有 dp 编号就带上；没有就留空，让映射层退回"按 code 认"
        dp_id: rel && rel.dpId !== null ? rel.dpId : undefined
      });
    }
  }
  if (out.functions.length === 0 && out.status.length === 0) return null;
  return out;
}

/* ------------------------------------------------ 数据面：状态与下发 */

/**
 * 读设备当前状态。
 * `support_local` 为 false 的设备用 code 上报（`[{code, value}]`），
 * 其余用 dpId（`[{dpId, value}]`）—— 两种都归一成 `code` 或 `dp:<id>` 做键。
 */
function mobileNormalizeStatus(rawList, relations) {
  const out = {};
  const list = asArray(rawList);
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    if (it.value === undefined) continue;
    if (it.code !== undefined) {
      out[String(it.code)] = it.value;
    } else if (it.dpId !== undefined) {
      const rel = relations ? relations.byId[String(it.dpId)] : null;
      if (rel && rel.code) out[rel.code] = it.value;
      else out[String(it.dpId)] = it.value;
    }
  }
  return out;
}

/** 云端下发一组命令（DP code → value）。设备列表接口里也带了一次 status。 */
async function mobileSendCommands(auth, did, commands) {
  return mobileRequest(
    auth, 'POST', '/v1.1/m/thing/' + did + '/commands', null, { commands: commands }
  );
}
