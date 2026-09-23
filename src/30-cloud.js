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
