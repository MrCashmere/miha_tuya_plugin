/*
 * 插件契约自检：不联任何真实网络，只用替身把宿主会走的链路全走一遍。
 *
 * 验的是「装进去会不会不动」这一类问题 —— 也就是 miha 插件文档里
 * 反复强调的那些硬约束：
 *
 *   ① 顶层不抛异常、确实调了 Plugin.register
 *   ② 钩子齐全，且返回值 JSON 可序列化（函数 / 循环引用会被宿主卡住）
 *   ③ Device 字段名逐字对齐米家命名（isOnline / room_id / local_ip / parent_id）
 *   ④ getHomes / getDevices 的形状（id/name/uid/dids/roomlist；key 必须是 did）
 *   ⑤ 读失败 throw、写失败 throw、不存在的属性 throw
 *   ⑥ 所有用到的 Host.* 都在 plugin.json 的 permissions 里声明了
 *   ⑦ capabilities 里每个 true 都有对应实现
 *
 * 前置：node tools/build.js（或本脚本自己拼一份，见下）
 * 用法：node tools/test_plugin.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const MANIFEST = path.join(ROOT, 'plugin.json');

/* ------------------------------------------------ 拼一份 bundle 并跑起来 */

const files = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.js'); }).sort();
let bundle = '';
for (const f of files) bundle += fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';

/** 记录所有被调用过的 Host 方法，用来反查权限声明 */
const hostCalls = [];
/** secureStore 的替身存储 */
const store = {};

function rejectMethod(name, message) {
  return function () {
    hostCalls.push(name);
    return Promise.reject(new Error(message || (name + ' 在测试环境里被禁用了')));
  };
}

const HostMock = {
  http: rejectMethod('http', '测试环境不发真实网络请求'),
  httpForm: rejectMethod('httpForm', '测试环境不发真实网络请求'),
  secureStore: {
    get: function (key) {
      hostCalls.push('secureStore.get');
      return Promise.resolve(store[key] === undefined ? null : store[key]);
    },
    set: function (key, value) {
      hostCalls.push('secureStore.set');
      store[key] = value;
      return Promise.resolve(true);
    },
    delete: function (key) {
      hostCalls.push('secureStore.delete');
      delete store[key];
      return Promise.resolve(true);
    }
  },
  crypto: {
    sha1Hex: function (s) { hostCalls.push('crypto.sha1Hex'); return Promise.resolve(''); },
    sha256Hex: function (s) { hostCalls.push('crypto.sha256Hex'); return Promise.resolve(''); },
    sha256Base64: function (s) { hostCalls.push('crypto.sha256Base64'); return Promise.resolve(''); },
    sha1BytesBase64: function (s) { hostCalls.push('crypto.sha1BytesBase64'); return Promise.resolve(''); },
    sha256BytesBase64: function (s) { hostCalls.push('crypto.sha256BytesBase64'); return Promise.resolve(''); },
    base64ToHex: function (s) { hostCalls.push('crypto.base64ToHex'); return Promise.resolve(''); },
    hexToBase64: function (s) { hostCalls.push('crypto.hexToBase64'); return Promise.resolve(''); },
    hmacSha1: function (k, s) { hostCalls.push('crypto.hmacSha1'); return Promise.resolve(''); },
    randomBytes: function (n) { hostCalls.push('crypto.randomBytes'); return Promise.resolve(''); }
  },
  log: {
    info: function (tag, msg) { hostCalls.push('log.info'); return Promise.resolve(true); },
    error: function (tag, msg) { hostCalls.push('log.error'); return Promise.resolve(true); }
  },
  getDevice: function (did) { hostCalls.push('getDevice'); return Promise.resolve(null); },
  // 局域网：open 直接失败 → 广播发现立刻返回空，测试跑得快
  udp: {
    open: rejectMethod('udp.open', '测试环境没有局域网权限'),
    onMessage: rejectMethod('udp.onMessage'),
    send: rejectMethod('udp.send'),
    close: rejectMethod('udp.close')
  },
  tcp: {
    open: rejectMethod('tcp.open', '测试环境连不上设备'),
    onMessage: rejectMethod('tcp.onMessage'),
    onClose: rejectMethod('tcp.onClose'),
    send: rejectMethod('tcp.send'),
    close: rejectMethod('tcp.close')
  },
  tls: {
    open: rejectMethod('tls.open'),
    onMessage: rejectMethod('tls.onMessage'),
    onClose: rejectMethod('tls.onClose'),
    send: rejectMethod('tls.send'),
    close: rejectMethod('tls.close')
  }
};

let registered = null;
const sandbox = {
  console: console,
  btoa: btoa,
  atob: atob,
  Math: Math,
  Date: Date,
  JSON: JSON,
  Uint8Array: Uint8Array,
  Uint32Array: Uint32Array,
  Error: Error,
  Promise: Promise,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
vm.createContext(sandbox);
sandbox.Plugin = {
  register: function (obj) {
    registered = obj;
  }
};
sandbox.Host = HostMock;
sandbox.Object = Object;
sandbox.Number = Number;
sandbox.String = String;
sandbox.Array = Array;
sandbox.isNaN = isNaN;
sandbox.isFinite = isFinite;
sandbox.parseInt = parseInt;
sandbox.RegExp = RegExp;

let topLevelError = null;
try {
  vm.runInContext(bundle, sandbox, { filename: 'main.js' });
} catch (e) {
  topLevelError = e;
}

/* ------------------------------------------------------------- 断言工具 */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, 'got ' + a + ' want ' + e);
}

function group(title) {
  console.log('\n' + title);
}

/** 深查：返回值里不能有函数、也不能有循环引用（跨桥只能是 JSON）。 */
function jsonSafe(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch (e) {
    return false;
  }
}

function hasFunction(value, seen) {
  seen = seen || [];
  if (typeof value === 'function') return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.indexOf(value) >= 0) return true; // 循环
  seen.push(value);
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    if (hasFunction(value[keys[i]], seen)) return true;
  }
  seen.pop();
  return false;
}

/* ---------------------------------------------------------------- 用例 */

async function main() {
  group('① 加载期：顶层不抛异常、确实注册了插件');

  ok('顶层代码没有抛异常', topLevelError === null,
    topLevelError ? String(topLevelError && topLevelError.message) : '');
  ok('Plugin.register 被调用', registered !== null && typeof registered === 'object',
    typeof registered);

  if (!registered) {
    console.log('\n插件没注册，后面的用例没法跑。');
    process.exit(1);
  }

  group('② 钩子齐全 + 返回值可序列化');

  const api = ['init', 'loginBegin', 'loginSubmit', 'loginPoll', 'loginCancel',
    'getHomes', 'getDevices', 'getSpecForDevice', 'createTransports',
    'getProperty', 'getProperties', 'setProperty', 'callAction', 'dispose'];
  const missing = api.filter(function (k) { return typeof registered[k] !== 'function'; });
  eq('全部钩子都在', missing, []);

  group('③ init：没有凭据时返回 false（宿主据此显示登录入口）');

  eq('空白环境 init → false', await registered.init({ pluginId: 'tuya-local' }), false);

  group('④ loginBegin：form 视图的每个字段都合规');

  const begin = await registered.loginBegin();
  ok('loginBegin 可序列化', jsonSafe(begin) && !hasFunction(begin));
  ok('sessionId 非空', typeof begin.sessionId === 'string' && begin.sessionId.length > 0,
    String(begin.sessionId));
  ok('view 存在', !!begin.view);
  eq('view.type = form', begin.view.type, 'form');
  ok('fields 是数组且非空',
    Array.isArray(begin.view.fields) && begin.view.fields.length > 0,
    String(begin.view.fields && begin.view.fields.length));

  const allowedTypes = ['text', 'password', 'switch'];
  const badFields = begin.view.fields.filter(function (f) {
    return !f.key || !f.label || allowedTypes.indexOf(f.type) < 0;
  });
  eq('字段都带 key/label 且类型合法', badFields, []);
  ok('给了 submitLabel', typeof begin.view.submitLabel === 'string' && begin.view.submitLabel.length > 0,
    String(begin.view.submitLabel));

  group('⑤ loginPoll 排队态必须返回 pending（不能抛错）');

  const poll = await registered.loginPoll(begin.sessionId);
  eq('loginPoll → pending', poll.state, 'pending');
  const cancelled = await registered.loginCancel(begin.sessionId);
  eq('loginCancel → cancelled', cancelled.state, 'cancelled');

  group('⑥ loginSubmit：云模式凭据校验失败要报错，不是静默成功');

  const cloudFail = await registered.loginSubmit(begin.sessionId, {
    useCloud: 'true',
    accessId: 'id123',
    accessSecret: 'secret123',
    region: 'cn'
  });
  eq('云凭据不通 → error', cloudFail.state, 'error');
  ok('错误信息点明了是云凭据校验',
    /云凭据校验失败/.test(String(cloudFail.message)), String(cloudFail.message));

  const emptyBoth = await registered.loginSubmit(begin.sessionId, { useCloud: 'false' });
  eq('两样都不填 → error', emptyBoth.state, 'error');

  group('⑦ loginSubmit：局域网模式（本用例后面全都用这份配置）');

  const DID = 'tuya_test_device_0001';
  const KEY = '0123456789abcdef'; // 恰好 16 字符
  const IP = '192.168.1.50';

  const badKey = await registered.loginSubmit(begin.sessionId, {
    useCloud: 'false',
    devices: DID + ',shortkey,' + IP
  });
  eq('localKey 长度不对 → error', badKey.state, 'error');
  ok('错误信息点明了 16 个字符', /16 个字符/.test(String(badKey.message)), String(badKey.message));

  const localOk = await registered.loginSubmit(begin.sessionId, {
    useCloud: 'false',
    devices: DID + ',' + KEY + ',' + IP + ',3.3,测试开关,kg'
  });
  eq('合法配置 → success', localOk.state, 'success');
  ok('凭据写进了 secureStore', typeof store.auth === 'string' || typeof store.auth === 'object',
    typeof store.auth);

  group('⑧ 登录后 init 要变成 true（幂等）');

  eq('再 init → true', await registered.init({ pluginId: 'tuya-local' }), true);
  eq('第三次 init 仍为 true（幂等）', await registered.init({ pluginId: 'tuya-local' }), true);

  group('⑨ getHomes：字段名必须是 id/name/uid/dids/roomlist');

  const homes = await registered.getHomes();
  ok('getHomes 可序列化', jsonSafe(homes) && !hasFunction(homes));
  ok('返回至少一个家庭', Array.isArray(homes) && homes.length >= 1);
  const home = homes[0];
  ok('home.id 非空', typeof home.id === 'string' && home.id.length > 0, String(home.id));
  ok('home.name 非空', typeof home.name === 'string' && home.name.length > 0, String(home.name));
  ok('有 uid 字段', home.uid !== undefined, String(home.uid));
  ok('dids 是数组', Array.isArray(home.dids), typeof home.dids);
  ok('roomlist 是数组', Array.isArray(home.roomlist), typeof home.roomlist);

  group('⑩ getDevices：key 是 did，Device 字段逐字对齐米家命名');

  const devices = await registered.getDevices();
  ok('getDevices 可序列化', jsonSafe(devices) && !hasFunction(devices));
  ok('至少一台设备', Object.keys(devices).length >= 1, String(Object.keys(devices).length));
  ok('key 就是 did', !!devices[DID], Object.keys(devices).join(','));

  const dev = devices[DID];
  const expectExact = ['did', 'name', 'model', 'spec_type', 'room_id', 'room_name',
    'home_id', 'home_name', 'isOnline', 'token', 'local_ip', 'parent_id',
    'uid', 'pid', 'icon', 'group_id', 'ssid', 'bssid', 'orderTime', 'rssi', 'extra'];
  const wrongNames = expectExact.filter(function (k) { return dev[k] === undefined; });
  eq('米家命名的字段一个不少', wrongNames, []);
  ok('isOnline 是布尔（不是 online）', typeof dev.isOnline === 'boolean', typeof dev.isOnline);
  eq('token 是 localKey', dev.token, KEY);
  eq('local_ip 是 IP', dev.local_ip, IP);
  eq('home_id 指向家庭', dev.home_id, home.id);
  ok('没有驼峰别名 online / localIp / homeId',
    dev.online === undefined && dev.localIp === undefined && dev.homeId === undefined,
    JSON.stringify([dev.online, dev.localIp, dev.homeId]));
  ok('extra.fw_version 存在', dev.extra && typeof dev.extra.fw_version === 'string',
    JSON.stringify(dev.extra));

  group('⑪ getSpecForDevice：MIoT instance JSON 的形状');

  const spec = await registered.getSpecForDevice(dev);
  ok('spec 可序列化', jsonSafe(spec) && !hasFunction(spec));
  ok('有 type', typeof spec.type === 'string' && spec.type.indexOf('urn:') === 0, String(spec.type));
  ok('services 是数组且非空', Array.isArray(spec.services) && spec.services.length >= 2,
    String(spec.services && spec.services.length));

  const svc = spec.services[1];
  ok('siid 2 是主服务', svc.iid === 2, String(svc.iid));
  ok('主服务有 properties', Array.isArray(svc.properties) && svc.properties.length > 0);
  ok('actions 是数组（涂鸦没有动作，应当为空）',
    Array.isArray(svc.actions) && svc.actions.length === 0, JSON.stringify(svc.actions));

  const prop = svc.properties[0];
  ok('property.iid 就是 piid', typeof prop.iid === 'number', typeof prop.iid);
  ok('property.type 是 urn', String(prop.type).indexOf('urn:miot-spec-v2:property:') === 0,
    String(prop.type));
  ok('property.format 存在', typeof prop.format === 'string' && prop.format.length > 0,
    String(prop.format));
  ok('property.access 是数组', Array.isArray(prop.access), typeof prop.access);
  ok('kebab-case 的 value-list（宿主 parser 吃这个）',
    prop['value-list'] === undefined || Array.isArray(prop['value-list']),
    typeof prop['value-list']);
  ok('没有 camelCase 的 valueList / valueRange 泄漏',
    prop.valueList === undefined && prop.valueRange === undefined,
    JSON.stringify([prop.valueList, prop.valueRange]));

  const activeSpec = await registered.getSpecForDevice({ did: DID });
  eq('同一台设备两次 getSpec 一致', JSON.stringify(activeSpec), JSON.stringify(spec));

  group('⑫ createTransports / isTransportAvailable');

  const transports = await registered.createTransports(dev);
  ok('transports 可序列化', jsonSafe(transports));
  ok('至少一条通道', Array.isArray(transports) && transports.length >= 1);
  ok('通道带 id/kind/priority',
    transports.every(function (t) {
      return typeof t.id === 'string' && typeof t.kind === 'string' && typeof t.priority === 'number';
    }), JSON.stringify(transports));
  const lanT = transports.filter(function (t) { return t.kind === 'lan'; });
  ok('capabilities.lanControl=true → 必须有 lan 通道', lanT.length === 1, String(lanT.length));
  eq('lan 排在 cloud 前面（priority 更小）',
    transports.map(function (t) { return t.priority; }).join(',') ===
    transports.map(function (t) { return t.priority; }).sort(function (a, b) { return a - b; }).join(','),
    true);

  eq('isTransportAvailable(cloud) 在无云凭据时 false',
    await registered.isTransportAvailable('cloud', dev), false);
  ok('isTransportAvailable 返回布尔',
    typeof (await registered.isTransportAvailable('lan', dev)) === 'boolean');

  group('⑬ 读：读失败必须 throw');

  let readErr = null;
  try {
    await registered.getProperties('lan', DID, [{ siid: 2, piid: 1 }]);
  } catch (e) {
    readErr = e;
  }
  ok('局域网不可达时读属性抛错', readErr !== null, readErr ? 'no throw' : '');
  ok('错误信息能看出是连接问题',
    readErr ? /连接|超时|失败/.test(describe(readErr)) : false,
    readErr ? describe(readErr) : '');

  let singleErr = null;
  try {
    await registered.getProperty('lan', DID, 2, 1);
  } catch (e) {
    singleErr = e;
  }
  ok('getProperty 同样抛错', singleErr !== null);

  group('⑭ 写：不存在的属性要拒绝，写失败要 throw');

  let badWrite = null;
  try {
    await registered.setProperty('lan', DID, 99, 99, true);
  } catch (e) {
    badWrite = e;
  }
  ok('写不存在的 (siid,piid) 抛错', badWrite !== null);
  ok('错误信息点明了能力描述里没有',
    badWrite ? /能力描述里没有/.test(describe(badWrite)) : false,
    badWrite ? describe(badWrite) : '');

  let writeErr = null;
  try {
    await registered.setProperty('lan', DID, 2, 1, true);
  } catch (e) {
    writeErr = e;
  }
  ok('局域网写不通时抛错（不能返回 false）', writeErr !== null);
  ok('抛的确实是 Error 实例', writeErr instanceof Error, typeof writeErr);

  group('⑮ callAction：涂鸦没有动作模型，必须明确报错');

  let actionErr = null;
  try {
    await registered.callAction('lan', DID, 2, 1, []);
  } catch (e) {
    actionErr = e;
  }
  ok('callAction 抛错', actionErr !== null);
  ok('错误信息解释了原因',
    actionErr ? /不支持动作调用|只有功能点/.test(describe(actionErr)) : false,
    actionErr ? describe(actionErr) : '');

  group('⑯ 兼容两种调用形状（宿主版本间有过差异）');

  // 短形状：(device, [{siid,piid}]) —— 协议参考文档里的写法
  let shortShapeErr = null;
  try {
    await registered.getProperties(dev, [{ siid: 2, piid: 1 }]);
  } catch (e) {
    shortShapeErr = e;
  }
  ok('getProperties 短形状能识别出 did（走到连接阶段而不是参数错误）',
    shortShapeErr !== null && /连接|超时|失败/.test(describe(shortShapeErr)),
    shortShapeErr ? describe(shortShapeErr) : 'no throw');

  // 短形状：(device, siid, piid, value)
  let shortWriteErr = null;
  try {
    await registered.setProperty(dev, 99, 99, true);
  } catch (e) {
    shortWriteErr = e;
  }
  ok('setProperty 短形状能识别出 did（报的是属性不存在，不是缺 did）',
    shortWriteErr !== null && /能力描述里没有/.test(describe(shortWriteErr)),
    shortWriteErr ? describe(shortWriteErr) : 'no throw');

  // 摘出来的方法调用（不能依赖 this）
  const detached = registered.getProperties;
  let detachedErr = null;
  try {
    await detached('lan', DID, [{ siid: 2, piid: 1 }]);
  } catch (e) {
    detachedErr = e;
  }
  ok('方法被摘出来调用也不炸（不依赖 this）',
    detachedErr !== null && !/this/.test(describe(detachedErr)),
    detachedErr ? describe(detachedErr) : 'no throw');

  group('⑰ dispose 不抛错，且不清凭据');

  let disposeErr = null;
  try {
    await registered.dispose();
  } catch (e) {
    disposeErr = e;
  }
  ok('dispose 不抛错', disposeErr === null, disposeErr ? describe(disposeErr) : '');
  ok('dispose 没有清掉凭据（否则用户要重新登录）', !!store.auth);

  /* ------------------------------------------------ 清单与权限一致性 */

  group('⑱ plugin.json 与实现的一致性');

  ok('plugin.json 存在', fs.existsSync(MANIFEST));
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    ok('plugin.json 是合法 JSON', false, describe(e));
  }

  if (manifest) {
    ok('schemaVersion = 1', manifest.schemaVersion === 1, String(manifest.schemaVersion));
    ok('id 非空', typeof manifest.id === 'string' && manifest.id.length > 0, String(manifest.id));
    eq('runtime', manifest.runtime, 'js');
    eq('entry 指向 main.js', manifest.entry, 'main.js');
    ok('version 是 semver', /^\d+\.\d+\.\d+$/.test(String(manifest.version)), String(manifest.version));
    ok('license 是 MIT', manifest.license === 'MIT', String(manifest.license));
    ok('entry 文件真的存在', fs.existsSync(path.join(ROOT, manifest.entry)), String(manifest.entry));

    // 用到的 Host.* 必须都在 permissions 里
    const PERM_OF = {
      http: 'network', httpForm: 'network',
      secureStore: 'secureStore',
      crypto: 'crypto',
      log: 'log',
      udp: 'lan', tcp: 'lan',
      tls: 'mqtt',
      getDevice: null
    };

    const usedGroups = {};
    // 覆盖三种用法：Host.http(...) / Host.log.info(...) / Host.log[level](...)
    const re = /Host\.([A-Za-z_][A-Za-z0-9_]*)\s*[.\[(]/g;
    let m;
    while ((m = re.exec(bundle)) !== null) usedGroups[m[1]] = true;
    const usedList = Object.keys(usedGroups);
    const undeclared = usedList.filter(function (g) {
      const need = PERM_OF[g];
      if (need === null || need === undefined) return false;
      return (manifest.permissions || []).indexOf(need) < 0;
    });
    eq('用到的 Host 能力都在 permissions 里', undeclared, []);
    ok('真的用到了 secureStore（凭据要存本地）', usedGroups.secureStore === true);
    ok('真的用到了 lan（局域网直控）', usedGroups.udp === true && usedGroups.tcp === true);
    ok('真的用到了 network（云 OpenAPI）', usedGroups.http === true);

    const perms = manifest.permissions || [];
    ok('permissions 里没有多余的项（每个都要有对应调用）', perms.every(function (p) {
      return Object.keys(PERM_OF).some(function (g) { return PERM_OF[g] === p && usedGroups[g]; });
    }), JSON.stringify(perms));

    // capabilities 里每个 true 都必须有实现
    const caps = manifest.capabilities || {};
    if (caps.homes) ok('homes=true → 实现了 getHomes', typeof registered.getHomes === 'function');
    if (caps.devices) ok('devices=true → 实现了 getDevices', typeof registered.getDevices === 'function');
    if (caps.spec) {
      ok('spec=true → getSpecForDevice 返回的不是 null', spec !== null && spec !== undefined);
      ok('spec=true → 返回的 spec 真的有属性',
        spec && spec.services && spec.services.some(function (s) {
          return s.properties && s.properties.length > 0;
        }));
    }
    if (caps.lanControl) ok('lanControl=true → createTransports 会给 lan 通道', lanT.length > 0);

    // 声明 false 的能力，对应的钩子一个都不该实现
    const forbiddenHooks = ['getScenes', 'runScene', 'getStatistics', 'checkMessages',
      'getMessageList', 'getConsumableItems', 'getStreamUrl', 'saveStreamUrl',
      'clearStreamUrl', 'gatewayInfo', 'gatewayLogin', 'gatewayForget',
      'gatewayClients', 'gatewaySetBlocked', 'gatewayReboot'];
    const present = forbiddenHooks.filter(function (k) {
      return typeof registered[k] === 'function';
    });
    eq('没有实现未声明能力对应的钩子', present, []);

    ok('声明了 login（有凭据需求）', !!manifest.login);
    if (manifest.login) {
      ok('login.type 是合法值',
        ['qr', 'web', 'form'].indexOf(manifest.login.type) >= 0,
        String(manifest.login.type));
      eq('login.type 与 loginBegin 的视图一致', manifest.login.type, 'form');
    }
  }

  /* ---------------------------------------------------------------- 汇总 */
  console.log('\n' + '='.repeat(56));
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  if (fail > 0) {
    console.log('失败：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('插件契约自检全部通过 ♪');
}

function describe(e) {
  if (!e) return '';
  return String((e && e.message) || e);
}

main().catch(function (e) {
  console.error('用例执行出错：' + describe(e));
  console.error(e && e.stack);
  process.exit(1);
});
