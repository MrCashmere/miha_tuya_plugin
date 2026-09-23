/* ============================================================================
 * §10 插件入口：Plugin.register
 *
 * 把前面几层接成宿主认识的样子：
 *   00-util     工具（跨 realm 安全的 isArray 等）
 *   05-qr       纯 JS 二维码编码器（ISO/IEC 18004 + PNG）
 *   10-crypto   纯 JS 的 MD5 / SHA-256 / HMAC / AES / GCM
 *   20-lan      涂鸦局域网协议（TCP 6668 + UDP 7000 发现）
 *   30-cloud    涂鸦云 OpenAPI（HMAC-SHA256 签名，**已弃用**，仅兼容旧凭据）
 *   35-mobile   涂鸦手机端云 API（AES-GCM + HMAC-SHA256，扫码登录走这条）
 *   40-mapping  DP ⇄ MIoT 映射
 *   50-plugin   ← 本文件
 *
 * ## 三条接入路径，优先级从高到低
 *
 *   account  扫码登录（手机端 API）——**推荐**。一次扫码拿到设备列表、
 *            local_key、IP、家庭/房间层级、DP ⇄ code 关系表，且**没有配额限制**。
 *   cloud    涂鸦 IoT 平台 OpenAPI——**旧路径，保留只为兼容已存的凭据**。
 *            试用版有 1 个月有效期 / 最多 50 台设备 / 只能控 10 台，
 *            过期后接口一律返回 28841002。新用户直接用扫码。
 *   local    纯局域网手填（设备 ID + localKey + IP），不需要任何云账号。
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
/**
 * 扫码登录会话。**必须存在插件自己这里** —— 宿主的 `loginPoll(sessionId)`
 * 只回传一个 sessionId，既不给轮询地址也不给用户码。
 */
let qrSession = null;
/** 扫码模式下的家庭/房间缓存（`getHomes` 与 `refreshDevices` 共用一次请求） */
let accountHomes = null;
/** did -> { id, name } | null：房间查询结果缓存（null = 查过，确实没房间） */
let roomCache = {};
/** did -> 扫码账号返回的原始设备记录（含 local_key / ip，凑局域网信息时用） */
let accountDeviceCache = {};

const HOME_ID = 'tuya';
const HOME_NAME = '涂鸦设备';
const DISCOVERY_TTL_MS = 120000;
const TAG = 'tuya';

/** 用户码存在 secureStore 的这个 key 下（只存本机，不上传）。 */
const USER_CODE_KEY = 'tuya_user_code';
/**
 * 二维码有效期 / 轮询间隔。
 * 轮询间隔涂鸦官方文档要求 **≥ 2s**（写小了会被风控当成异常流量），
 * `expiresIn` 与本地计时器共用，归零就报 expired。
 */
const QR_EXPIRES_SEC = 180;
const QR_POLL_MS = 2000;

/**
 * 二维码里装的内容。格式来自涂鸦官方文档（扫码授权登录）：
 * 由 App 解析出 token 后回传云端完成授权。
 */
const QR_LOGIN_PREFIX = 'tuyaSmart--qrLogin?token=';

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
    // 扫码登录的凭据：endpoint 由扫码结果给，缺了就是坏的，交给 init 判失败
    if (data.mode === 'account' && typeof data.endpoint !== 'string') {
      data.endpoint = '';
    }
    return data;
  } catch (e) {
    safeLog('error', TAG, '读取凭据失败：' + describeError(e));
    return null;
  }
}

/* ------------------------------------------------------------ 用户码 */

/**
 * 读涂鸦用户码。
 *
 * 它是**账号级别的常量**（涂鸦 App：我的 → 设置 → 账号与安全 → 用户码），
 * 扫码建单这一步服务端会校验它 —— 我们实测过：空值或瞎填都返回
 * `USERCODE_INCORRECT`。所以必须让用户填一次，之后一直复用。
 */
async function loadUserCode() {
  try {
    const stored = await Host.secureStore.get(USER_CODE_KEY);
    if (!stored) return '';
    return strOf(typeof stored === 'string' ? stored : stored.value).trim();
  } catch (e) {
    safeLog('error', TAG, '读取用户码失败：' + describeError(e));
    return '';
  }
}

async function saveUserCode(code) {
  await Host.secureStore.set(USER_CODE_KEY, strOf(code).trim());
}

async function clearUserCode() {
  try {
    await Host.secureStore.delete(USER_CODE_KEY);
  } catch (e) {
    safeLog('error', TAG, '清除用户码失败：' + describeError(e));
  }
}

/**
 * 首次登录要的用户码表单。
 *
 * 只在这个表单里出现一次：用户码存下来之后，`loginBegin` 就直接给二维码了。
 * 局域网手填设备也留在这里（两条路径可以共存，手填的会覆盖云端的 IP / localKey）。
 *
 * ⚠️ `form` 的字段类型只有 text / password / switch，且**所有值都是字符串**。
 *    未知类型会被当成 text，不会报错。
 */
function userCodeFormView(notice) {
  const suffix = notice ? '（' + notice + '）' : '';
  return {
    type: 'form',
    hint: '首次使用需要一次「用户码」：涂鸦 App → 我的 → 右上角齿轮 → 账号与安全 → 底部「用户码」。'
      + '填好后提交，再点一次「登录」即可看到二维码。',
    fields: [
      {
        key: 'userCode',
        label: '涂鸦用户码' + suffix,
        type: 'text',
        placeholder: '用户码只在涂鸦 App 里显示，区分大小写'
      },
      {
        key: 'manual',
        label: '局域网设备（可选，每行一台，也可用分号隔开）',
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
    submitLabel: '保存用户码'
  };
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

/**
 * 是否已扫码登录（手机端账号模式）。
 *
 * 判据是 **endpoint + refreshToken**，不是 accessToken —— accessToken 只有
 * 2 小时，过期后靠 refreshToken 静默换新的（`mobileEnsureToken` 负责），
 * 拿它当判据会让插件在每次 token 过期时误判成"没登录"。
 */
function hasAccount() {
  return !!(auth && auth.mode === 'account' && auth.endpoint && auth.refreshToken);
}

/** 有没有任意一条云通道（用于决定要不要挂 cloud transport）。 */
function hasAnyCloud() {
  return hasAccount() || hasCloud();
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
  if (!(cur && cur.key)) {
    if (hasAccount()) {
      // 扫码账号的设备列表里**本来就带 local_key 和 ip**（开放平台反而要再查一次详情）
      const rec = await ensureAccountDevice(d);
      if (rec && rec.key) {
        const base = lanInfoCache[d] || { ip: '', key: '', version: 0, category: '' };
        lanInfoCache[d] = {
          ip: base.ip || rec.ip || '',
          key: rec.key,
          version: base.version || 0,
          category: base.category || rec.category || ''
        };
        if (rec.category && !categoryCache[d]) categoryCache[d] = normDpCode(rec.category);
      }
    } else if (hasCloud()) {
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
  const roomId = strOf(rec.roomId);
  return {
    did: String(rec.did),
    name: String(rec.name || rec.did),
    model: String(rec.productName || rec.productId || ''),
    // spec_type 会被宿主映射成 SmartDevice.urn。我们不靠它取 spec
    //（getSpecForDevice 按 did 查自己的映射表），但形状得像那么回事 ——
    // 给一个稳定、合法的 MIoT urn。
    spec_type: 'urn:miot-spec-v2:device:' + info.device + ':0000A001:tuya:1',
    room_id: roomId,
    room_name: roomId ? strOf(rec.roomName) : '',
    home_id: strOf(rec.homeId) || HOME_ID,
    home_name: strOf(rec.homeName) || HOME_NAME,
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

/* --------------------------------------------------------- 扫码账号：家庭 */

/**
 * 取家庭列表（一次会话内缓存）。
 *
 * 家庭 id 是涂鸦的 `ownerId`（SDK 也这么用）。顺手把它转成宿主认的
 * `Home` 形状所需的数据 —— 但 `roomlist` 要等房间查完才能填。
 */
async function ensureAccountHomes() {
  if (isArray(accountHomes)) return accountHomes;
  const list = await mobileGetHomes(auth);
  accountHomes = list;
  return accountHomes;
}

/**
 * 把每台设备所在的房间补进记录里。
 *
 * ⚠️ 这是个"一台设备一次请求"的接口（`/v1.0/m/thing/ha/{did}/room`），
 * 几十台设备串行拉会明显拖慢列表 —— 所以：
 *   ① 结果按 did 缓存（房间基本不变，一次会话里查一次就够）；
 *   ② 并发拉，但限制并发数（涂鸦对突发流量敏感）。
 */
async function fillRooms(recs) {
  const todo = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const hit = roomCache[r.did];
    if (hit !== undefined) {
      applyRoom(r, hit);
    } else {
      todo.push(r);
    }
  }
  if (todo.length === 0) return;

  const CONCURRENCY = 6;
  let cursor = 0;
  const worker = async function () {
    while (cursor < todo.length) {
      const rec = todo[cursor++];
      let room = null;
      try {
        room = await mobileGetRoomByDevice(auth, rec.did);
      } catch (e) {
        // 查不到房间不是错误（设备本来就可能不在任何房间），记 null 别重试
        room = null;
      }
      roomCache[rec.did] = room;
      applyRoom(rec, room);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, todo.length); i++) workers.push(worker());
  await Promise.all(workers);
}

function applyRoom(rec, room) {
  if (!room) return;
  rec.roomId = String(room.id || '');
  rec.roomName = String(room.name || '');
}

/**
 * 取一台设备的账号侧原始记录（含 local_key / ip）。
 *
 * 缓存优先；缓存没有就按 id 补拉一次 —— 这样"先在列表里看到设备、后来才点进去控制"
 * 这种顺序下也不会白跑请求。
 */
async function ensureAccountDevice(did) {
  const d = String(did);
  const hit = accountDeviceCache[d];
  if (hit !== undefined) return hit;
  let rec = null;
  try {
    const list = await mobileGetDevicesByIds(auth, [d]);
    if (isArray(list) && list.length > 0) rec = list[0];
  } catch (e) {
    safeLog('error', TAG, '补拉设备详情失败（' + d + '）：' + describeError(e));
  }
  if (!rec) return null;
  const norm = {
    key: strOf(rec.local_key || rec.localKey),
    ip: strOf(rec.ip),
    category: strOf(rec.category),
    name: strOf(rec.name)
  };
  accountDeviceCache[d] = norm;
  return norm;
}

/* ---------------------------------------------------- 家庭容器（宿主形状） */

function homeUid() {
  return (auth && auth.uid) ? String(auth.uid) : 'tuya';
}

/** 兜底家庭：OpenAPI / 纯局域网，以及账号下"一个家庭都没有"的情况。 */
function fixedHome() {
  const dids = [];
  const keys = Object.keys(deviceCache);
  for (let i = 0; i < keys.length; i++) dids.push(keys[i]);
  return {
    id: HOME_ID,
    name: HOME_NAME,
    uid: homeUid(),
    dids: dids,
    roomlist: [],
    city_id: '',
    longitude: 0,
    latitude: 0,
    address: ''
  };
}

/**
 * 用 `deviceCache` 里已经补好的 `home_id` / `room_id` 组装真实层级。
 *
 * 只做纯映射，不发请求 —— 设备信息由 `refreshDevices` 负责拉全，
 * 这里再查一遍纯属浪费。
 */
function buildAccountHomes(homes) {
  const out = [];
  const byId = {};
  for (let i = 0; i < homes.length; i++) {
    const h = homes[i];
    const o = {
      id: String(h.id),
      name: String(h.name || h.id),
      uid: homeUid(),
      dids: [],
      roomlist: [],
      city_id: '',
      longitude: 0,
      latitude: 0,
      address: ''
    };
    out.push(o);
    byId[o.id] = o;
  }
  if (out.length === 0) return [fixedHome()];

  const roomIndex = {};
  const keys = Object.keys(deviceCache);
  for (let i = 0; i < keys.length; i++) {
    const dev = deviceCache[keys[i]];
    // 家庭对不上的设备（接口偶尔会给个没见过的 homeId）挂到第一个家庭，
    // 不然它会在界面上凭空消失
    const home = byId[strOf(dev.home_id)] || out[0];
    home.dids.push(dev.did);
    const rid = strOf(dev.room_id);
    if (!rid) continue;
    const rk = home.id + '|' + rid;
    let room = roomIndex[rk];
    if (!room) {
      room = { id: rid, name: strOf(dev.room_name) || rid, dids: [] };
      roomIndex[rk] = room;
      home.roomlist.push(room);
    }
    room.dids.push(dev.did);
  }
  return out;
}

/**
 * 拉一遍设备清单。
 *
 * 三条来源合并：
 *   ① 扫码账号（`/v1.0/m/life/ha/home/devices`）——**会还原真实的家庭 / 房间层级**，
 *      并且带 local_key 与 ip，是唯一能同时拿到"控制钥匙"和"分组"的来源；
 *   ② 云 OpenAPI（旧路径，仅兼容存量凭据）——拿不到家庭/房间，统一收进一个家庭；
 *   ③ 用户手填的设备——总是保留，可以覆盖 ①② 里不对的 IP / localKey。
 */
async function refreshDevices() {
  const recs = [];
  const seen = {};

  // ① 扫码账号：家庭 → 设备 → 房间
  if (hasAccount()) {
    let homes = [];
    try {
      homes = await ensureAccountHomes();
    } catch (e) {
      safeLog('error', TAG, '拉取涂鸦家庭列表失败：' + describeError(e));
    }
    // 家庭列表拿不到（或账号还没建家庭）时退成一个占位家庭 ——
    // 宁可没有分组，也不能因为这一步失败就一台设备都列不出来。
    if (homes.length === 0) homes = [{ id: HOME_ID, name: HOME_NAME }];

    const accountRecs = [];
    for (let h = 0; h < homes.length; h++) {
      const home = homes[h];
      let list = [];
      try {
        list = await mobileGetDevicesByHome(auth, home.id);
      } catch (e) {
        safeLog('error', TAG, '拉取家庭「' + home.name + '」的设备失败：' + describeError(e));
        continue;
      }
      for (let i = 0; i < list.length; i++) {
        const d = list[i] || {};
        const did = strOf(d.id);
        if (!did || seen[did]) continue;
        seen[did] = true;
        if (d.category) categoryCache[did] = normDpCode(d.category);
        const rec = {
          did: did,
          name: d.name,
          category: d.category,
          productId: d.product_id || d.productId,
          productName: d.product_name || d.productName,
          online: d.online,
          ip: d.ip || '',
          uuid: d.uuid,
          // ⚠️ 整条链路最值钱的一个字段：local_key 是局域网直控的钥匙，
          //    只有账号模式（扫码）拿得到。开放平台的设备列表接口不给它。
          key: d.local_key || '',
          homeId: home.id,
          homeName: home.name,
          roomId: '',
          roomName: ''
        };
        accountRecs.push(rec);
        recs.push(rec);
        accountDeviceCache[did] = {
          key: rec.key,
          ip: rec.ip,
          category: strOf(d.category),
          name: strOf(d.name)
        };
      }
    }

    // 房间是"一台设备一次查询"的接口，按 did 缓存 + 并发拉，避免每次刷新都重来
    try {
      await fillRooms(accountRecs);
    } catch (e) {
      safeLog('error', TAG, '补全房间信息失败：' + describeError(e));
    }
  } else if (hasCloud()) {
    // ② 云 OpenAPI 设备列表（旧路径）
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

  // ③ 手填的设备（云端模式下作为补充 / 覆盖）
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
  if (hasAnyCloud()) {
    let spec = null;
    try {
      // 扫码账号走手机端接口：它的 DP 关系表**带 dp_id**，而局域网写要靠数字编号寻址，
      // 所以这一份比开放平台的 specification 更全。
      spec = hasAccount() ? await mobileGetSpec(auth, d) : await cloudGetSpec(auth, d);
    } catch (e) {
      safeLog('error', TAG, '取云规格失败（' + d + '）：' + describeError(e));
    }
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
    + (hasAnyCloud()
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

/**
 * 扫码账号模式下读一次设备状态快照。
 *
 * `/v1.0/m/life/ha/devices/detail?devIds=<did>` 的返回里就带 `status` 数组，
 * 但**上报方式分两种**：`supportLocal=true` 的设备用 `[{dpId, value}]`，
 * 其余用 `[{code, value}]`。`mobileNormalizeStatus` 借 DP 关系表把 dpId 归一成
 * code，这样后面 `lookupDpValue` 按 code 兜底也能命中。
 */
async function accountReadStatus(did) {
  const list = await mobileGetDevicesByIds(auth, [String(did)]);
  const dev = (isArray(list) && list.length > 0) ? list[0] : null;
  if (!dev) return null;
  let relations = null;
  try {
    relations = await mobileGetDpRelations(auth, String(did));
  } catch (e) {
    safeLog('error', TAG, '取 DP 关系表失败（' + did + '）：' + describeError(e));
  }
  return mobileNormalizeStatus(dev.status, relations);
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
    if (!hasAnyCloud()) throw new Error('没有可用的云凭据');
    dps = hasAccount()
      ? await accountReadStatus(d)
      : await cloudGetDeviceStatus(auth, d);
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

      if (auth.mode === 'account') {
        // 扫码登录拿到的凭据：endpoint + refreshToken 是"能自愈"的最小集合
        if (!auth.endpoint || !auth.refreshToken) {
          safeLog('error', TAG, '扫码凭据不完整（缺 endpoint 或 refreshToken），需要重新登录');
          return false;
        }
        // ⚠️ 同 cloud 模式：**不**在 init 里刷新 token。冷启动做外呼会让用户
        //    看到"已登录但一直转圈"，刷新推迟到真正要用的时候（mobileEnsureToken）。
      } else if (auth.mode === 'cloud') {
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
   * ② 登录第一步：出视图。
   *
   * ⚠️ 涂鸦的扫码登录**必须先拿到「用户码」**。它是账号级常量
   *    （涂鸦 App：我的 → 设置（右上角齿轮）→ 账号与安全 → 底部「用户码」），
   *    服务端在建单时就校验它 —— 实测空值或瞎填一律返回 `USERCODE_INCORRECT`。
   *
   * 但宿主的 `qr` 视图**只能放一张图**，没有输入框：协议里 `view.type` 三选一，
   * 且 `loginSubmit` 没法定向到"下一个视图"。所以首次登录分两步走：
   *
   *     第一次点「登录」→ 出一个只填用户码的表单
   *     填好提交       → 用户码存进 secureStore
   *     再点一次「登录」→ 直接出二维码，之后就永远是一步到位
   *
   * 这是宿主视图模型下唯一走得通的两步方案（详见 loginSubmit 的注释）。
   */
  async loginBegin() {
    const sessionId = 'tuya-' + Date.now();

    const userCode = await loadUserCode();
    if (!userCode) return { sessionId: sessionId, view: userCodeFormView('') };

    let token;
    try {
      token = await mobileQrCreate(userCode);
    } catch (e) {
      const msg = describeError(e);
      // 用户码失效（换过账号 / 在 App 里被重置）→ 清掉并退回表单。
      // 不清的话用户会卡在一个"每次都失败"的二维码上，而且没有任何输入入口。
      if (/USERCODE/i.test(msg)) {
        await clearUserCode();
        return {
          sessionId: sessionId,
          view: userCodeFormView('原用户码已失效，请重新填写')
        };
      }
      throw new Error('生成登录二维码失败：' + msg);
    }

    qrSession = {
      id: sessionId,
      userCode: userCode,
      token: token,
      expireAt: Date.now() + QR_EXPIRES_SEC * 1000
    };

    // ⚠️ 二维码在**本地**生成（05-qr.js），绝不交给第三方二维码服务 ——
    //    那等于把登录令牌发给了别人。宿主只认 http(s) / data: 两种 imageUrl。
    const dataUri = qrMakePngDataUri(QR_LOGIN_PREFIX + token, 5, 4, 'Q');
    return {
      sessionId: sessionId,
      view: {
        type: 'qr',
        imageUrl: dataUri,
        hint: '用「涂鸦智能 / 智能生活」App 的扫一扫',
        expiresIn: QR_EXPIRES_SEC,
        // 必须 > 0，否则宿主**根本不会轮询**，用户扫了也没反应且不报错。
        // 涂鸦官方要求轮询间隔 ≥ 2s。
        pollInterval: QR_POLL_MS
      }
    };
  },

  /**
   * ③ 提交用户码 / 局域网设备。
   *
   * 用户码会**真去服务端验一次**（建单接口本身就是校验接口）—— 与其让用户以为
   * 存好了、第二次点登录才发现填错，不如当场告诉他错在哪。
   *
   * 手填设备是**累加**的：再次登录只填用户码不会把手填的局域网设备冲掉。
   */
  async loginSubmit(_sessionId, fields) {
    const f = fields || {};
    const userCode = strOf(f.userCode).trim();
    const defaultCategory = normDpCode(f.category);

    const prevManual = (auth && isArray(auth.manual)) ? auth.manual.slice() : manualDevices.slice();

    let parsedManual = [];
    try {
      parsedManual = parseManualText(f.manual, defaultCategory);
    } catch (e) {
      return { state: 'error', message: '设备列表解析失败：' + describeError(e) };
    }

    // localKey 必须是 16 个字符 —— 早点拦住比等连接超时好。
    // 放在验用户码之前：两处都填错时，先报本地能立刻判定的那个。
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

    // ── 没填用户码 ────────────────────────────────────────────
    // ⚠️ **绝不能把手上有效的账号凭据丢掉**。"我只是想补一台手填设备" 是很常见的
    //    操作，而表单里的用户码字段默认是空的 —— 不特判的话，一次手滑提交就让
    //    用户从"已登录"掉回"没登录"。所以有账号凭据就保留，只合并手填设备。
    if (!userCode) {
      const keepAccount = !!(auth && auth.mode === 'account' && auth.refreshToken);
      if (parsedManual.length === 0 && prevManual.length === 0 && !keepAccount) {
        return {
          state: 'error',
          message: '请填写涂鸦「用户码」（扫码登录用）；或者至少填一台局域网设备，'
            + '格式：设备ID,localKey,IP[,协议版本][,名称]'
        };
      }
      if (!keepAccount) {
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
      }
      mergeManual(prevManual, parsedManual);
      auth.manual = manualDevices.slice();
      for (let i = 0; i < manualDevices.length; i++) absorbManualLan(manualDevices[i]);
      await saveAuth();
      safeLog('info', TAG, (keepAccount ? '保留账号登录，' : '局域网模式')
        + '已保存 ' + manualDevices.length + ' 台手填设备');
      return { state: 'success' };
    }

    // ── 验用户码 ────────────────────────────────────────────
    try {
      await mobileQrCreate(userCode);
    } catch (e) {
      const msg = describeError(e);
      if (/USERCODE/i.test(msg)) {
        return {
          state: 'error',
          message: '用户码不正确。请到涂鸦 App：我的 → 右上角齿轮 → 账号与安全 → '
            + '拉到底部的「用户码」，完整抄过来（区分大小写）。'
        };
      }
      return { state: 'error', message: '校验用户码失败：' + msg };
    }

    await saveUserCode(userCode);

    // 顺手把手填设备存下来（两条路径可以共存，手填的会覆盖云端的 IP / localKey）
    if (parsedManual.length > 0) {
      if (!auth) {
        auth = {
          mode: 'local', region: '', endpoint: '', accessId: '', accessSecret: '',
          accessToken: '', refreshToken: '', expireTime: 0, uid: '', manual: []
        };
      }
      mergeManual(prevManual, parsedManual);
      auth.manual = manualDevices.slice();
      for (let i = 0; i < manualDevices.length; i++) absorbManualLan(manualDevices[i]);
      await saveAuth();
    }

    // ⚠️ 返回 `error` 是**故意的**，不是失败：协议里 `loginSubmit` 只能回一个
    //    `{state}`，没法说"下一步给你看二维码"。用户码此刻已经存好了，用户照着
    //    提示再点一次「登录」，`loginBegin` 就会返回 `qr` 视图。
    //    用「已通过」而不是「已保存」开头，是为了让这条红字读起来像进度而不是报错。
    return {
      state: 'error',
      message: '用户码已校验通过 ✓ 请关闭本窗口，再点一次卡片上的「登录」，'
        + '二维码就会显示出来（只需这一次）。'
    };
  },

  /**
   * ④ 轮询扫码结果。
   *
   * ⚠️ 宿主**只传 sessionId**（轮询要用的用户码和 token 存在 `qrSession` 里），
   *    所以这里绝对不能把参数当成会话用。
   * ⚠️ 「还没扫」必须返回 `pending`：宿主连续 3 次收到异常就判登录失败并关弹窗，
   *    用户刚掏出手机二维码就没了。网络抖动同理。
   */
  async loginPoll(sessionId) {
    if (!qrSession || qrSession.id !== sessionId) return { state: 'pending' };
    if (Date.now() > qrSession.expireAt) {
      qrSession = null;
      return { state: 'expired', message: '二维码已过期，请重新点「登录」获取新的二维码。' };
    }

    let r;
    try {
      r = await mobileQrPoll(qrSession.userCode, qrSession.token);
    } catch (e) {
      // 网络抖动按 pending 处理，交给宿主的重试容忍
      safeLog('error', TAG, '轮询扫码结果失败：' + describeError(e));
      return { state: 'pending' };
    }
    // success:false 就是"还没扫" —— 不是错误
    if (!r || !r.ok) return { state: 'pending' };

    const userCode = qrSession.userCode;
    let next;
    try {
      next = mobileAuthFromLogin(userCode, r.result);
    } catch (e) {
      qrSession = null;
      return { state: 'error', message: '扫码结果不完整：' + describeError(e) };
    }

    // 手填设备要跨模式保留 —— 扫码不能把用户手工配的局域网覆盖冲掉
    const keepManual = (auth && isArray(auth.manual)) ? auth.manual.slice() : manualDevices.slice();
    next.manual = keepManual;

    auth = next;
    qrSession = null;
    accountHomes = null;
    roomCache = {};
    accountDeviceCache = {};
    lanInfoCache = {};
    manualDevices = keepManual.slice();

    // ⚠️ **先落盘再预热**：把凭据持久化放在拉设备之前。拉设备要发好几个请求，
    //    万一中间出点什么，登录本身不该受影响 —— 用户重新登录一次的成本太高。
    await saveAuth();

    // 顺手拉一次，好让用户立刻看到设备；拉不到也不影响登录（凭据已经存好了）
    try {
      await refreshDevices();
    } catch (e) {
      safeLog('error', TAG, '登录后拉取设备失败：' + describeError(e));
    }
    safeLog('info', TAG, '扫码登录成功，uid=' + (auth.uid || '?')
      + '，设备 ' + Object.keys(deviceCache).length + ' 台');
    return { state: 'success' };
  },

  async loginCancel() {
    qrSession = null;
    return { state: 'cancelled' };
  },

  /**
   * ⑤ 家庭容器。
   *
   * ⚠️ 字段名必须是 `id` / `name` / `uid` / `dids` / `roomlist`。
   * 写成 roomIds / deviceIds 的话宿主会解析出一个空家庭（它不会猜字段名）。
   *
   * 扫码账号能还原**真实的家庭 / 房间层级**（这是手机端接口相对 OpenAPI 的
   * 一大优势）；OpenAPI 与纯局域网拿不到层级，统一收进一个家庭。
   */
  async getHomes() {
    if (hasAccount()) {
      try {
        const homes = await ensureAccountHomes();
        if (homes.length > 0) return buildAccountHomes(homes);
      } catch (e) {
        safeLog('error', TAG, '拉取家庭列表失败：' + describeError(e));
      }
    }
    return [fixedHome()];
  },

  /** ⑥ 设备列表。key 必须是 did，值必须是 JSON 可序列化的普通对象。 */
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
   * ⑦ 能力描述 —— 真正实现，因为 plugin.json 里 capabilities.spec = true。
   * 返回 MIoT instance JSON，宿主自己解析（与内置 mijia-cloud 的契约一致）。
   */
  async getSpecForDevice(device) {
    const did = didOf(device);
    if (!did) throw new Error('getSpecForDevice 缺少 did');
    const m = await ensureMapping(did, device);
    return m.spec;
  },

  /**
   * ⑧ 控制通道。priority 小的先试。
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
    const acc = accountDeviceCache[did];
    const canLan = !!((cached && cached.ip && cached.key)
      || (manual && manual.ip && manual.key)
      || (acc && acc.ip && acc.key));
    if (canLan || hasAnyCloud() || manual) {
      out.push({ id: 'lan', kind: 'lan', priority: 10 });
    }
    if (hasAnyCloud()) {
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
    if (transportId === 'cloud') return hasAnyCloud();
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

  /** ⑨ 读单个属性。读失败 throw；"读到但没这个属性"返回 undefined。 */
  async getProperty(transportId, did, siid, piid) {
    const list = await readPropertiesInternal(transportId, did, [{ siid: siid, piid: piid }]);
    return list.length > 0 ? list[0].value : undefined;
  },

  /**
   * ⑩ 批量读。
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
   * ⑪ 写属性。
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
      if (!hasAnyCloud()) throw new Error('没有可用的云凭据');
      // 云侧一律按语义化 code 寻址（dp 编号只在局域网协议里有意义）
      const cmd = [{ code: entry.code, value: dpValue }];
      if (hasAccount()) {
        // ⚠️ mobileRequest 在 success=false 时会抛错 —— 这正是宿主需要的行为：
        //    返回 false / undefined 会被当成写成功，界面显示"已打开"而设备没动。
        await mobileSendCommands(auth, d, cmd);
      } else {
        await cloudSetDeviceStatus(auth, d, cmd);
      }
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
   * ⑫ 执行动作。
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
   * ⑬ 销毁。本插件没有常驻 socket / 定时器（每次读写都是"开→用→关"），
   * 所以这里只清运行时缓存，**不清凭据** —— 清了用户就得重新登录一遍。
   */
  async dispose() {
    clearMappingCache();
    lanInfoCache = {};
    deviceCache = {};
    categoryCache = {};
    discoveryCache = null;
    versionHint = {};
    accountHomes = null;
    roomCache = {};
    accountDeviceCache = {};
    qrSession = null;
    pluginCtx = null;
    safeLog('info', TAG, '已释放运行时缓存');
  }
});
