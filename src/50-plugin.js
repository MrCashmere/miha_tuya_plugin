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
