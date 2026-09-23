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

/**
 * 真实网络在测试里一律禁掉。需要云链路的用例先用 `stubHttp()` 换上替身。
 *
 * ⚠️ 替身按 URL 分派，**不解密 result**：插件的 `mobileRequest` 对"非字符串
 *    的 result"原样返回（见 35-mobile.js），所以这里直接给明文对象即可。
 *    签名/加解密本身由 test_mobile.js 对着涂鸦官方 SDK 验过，不在这里重复。
 */
let httpHandler = null;

function stubHttp(handler) {
  const prev = httpHandler;
  httpHandler = handler;
  return prev;
}

function jsonRes(obj) {
  return { status: 200, body: JSON.stringify(obj), headers: {} };
}

const HostMock = {
  http: function (method, url, headers, body) {
    hostCalls.push('http');
    if (!httpHandler) return Promise.reject(new Error('测试环境不发真实网络请求'));
    return Promise.resolve(httpHandler(method, url, headers, body));
  },
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

/* ------------------------------------------- 涂鸦手机端接口的替身（明文 mode） */

const ACC_DID = 'tuya_acc_device_0001';
const ACC_KEY = 'fedcba9876543210'; // 恰好 16 字符
const ACC_IP = '192.168.1.77';

/** 手填（局域网）那台设备 —— 和账号拉回来的那台并存，用来验"两条路径不互相冲掉" */
const DID = 'tuya_test_device_0001';
const KEY = '0123456789abcdef'; // 恰好 16 字符
const IP = '192.168.1.50';

/**
 * @param {{badUserCode?:boolean, scanned?:boolean}} opts
 */
function tuyaApiStub(opts) {
  const o = opts || {};
  return function (method, url) {
    let path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const q = path.indexOf('?');
    if (q >= 0) path = path.substring(0, q);

    // 建单 = 校验用户码的接口，空/错值都会返回 USERCODE_INCORRECT
    if (path === '/v1.0/m/life/home-assistant/qrcode/tokens') {
      if (o.badUserCode) {
        return jsonRes({ success: false, code: 'USERCODE_INCORRECT', msg: 'User Code Incorrect' });
      }
      return jsonRes({ success: true, result: { qrcode: 'QR_TOKEN_TEST' } });
    }
    // 轮询：没扫时 success:false —— 这不是错误
    if (path.indexOf('/v1.0/m/life/home-assistant/qrcode/tokens/') === 0) {
      if (!o.scanned) return jsonRes({ success: false, code: 'NOT_SCAN', msg: 'not scanned' });
      return jsonRes({
        success: true,
        t: 1730000000000,
        result: {
          endpoint: 'https://apigw.iotbing.com',
          terminal_id: 'term-test',
          access_token: 'ACCESS_TOKEN_TEST',
          refresh_token: 'REFRESH_TOKEN_TEST',
          expire_time: 7200,
          uid: 'uid-test'
        }
      });
    }

    if (path === '/v1.0/m/life/users/homes') {
      return jsonRes({ success: true, result: [{ ownerId: 'home-a', name: '我的家' }] });
    }
    if (path === '/v1.0/m/life/ha/home/devices') {
      return jsonRes({
        success: true,
        result: [{
          id: ACC_DID, name: '客厅灯', category: 'dj', product_id: 'pid-1',
          product_name: '彩光灯泡', local_key: ACC_KEY, ip: ACC_IP,
          online: true, uuid: 'uuid-1',
          status: [{ code: 'switch_led', value: true }]
        }]
      });
    }
    if (/^\/v1\.0\/m\/thing\/ha\/[^/]+\/room$/.test(path)) {
      return jsonRes({ success: true, result: { id: 'room-1', name: '客厅', displayOrder: 1 } });
    }
    if (path === '/v1.0/m/life/ha/devices/detail') {
      return jsonRes({
        success: true,
        result: [{
          id: ACC_DID, local_key: ACC_KEY, ip: ACC_IP, category: 'dj',
          status: [{ code: 'switch_led', value: true }]
        }]
      });
    }
    if (/^\/v1\.1\/m\/life\/[^/]+\/specifications$/.test(path)) {
      return jsonRes({
        success: true,
        result: {
          functions: [
            { code: 'switch_led', type: 'Boolean', values: '{}' },
            { code: 'work_mode', type: 'Enum', values: '{"range":["white","colour"]}' },
            { code: 'bright_value', type: 'Integer', values: '{"min":10,"max":1000}' }
          ],
          status: [{ code: 'switch_led', type: 'Boolean', values: '{}' }]
        }
      });
    }
    if (/^\/v1\.0\/m\/life\/devices\/[^/]+\/status$/.test(path)) {
      return jsonRes({
        success: true,
        result: {
          productKey: 'pk-1',
          dpStatusRelationDTOS: [
            { dpId: 20, statusCode: 'switch_led', supportLocal: true, valueType: 'Boolean', valueDesc: '{}' },
            { dpId: 21, statusCode: 'work_mode', supportLocal: true, valueType: 'Enum', valueDesc: '{}' },
            { dpId: 22, statusCode: 'bright_value', supportLocal: true, valueType: 'Integer', valueDesc: '{}' }
          ]
        }
      });
    }
    if (/^\/v1\.1\/m\/thing\/[^/]+\/commands$/.test(path)) {
      return jsonRes({ success: true, result: true });
    }

    throw new Error('替身没有覆盖这个请求：' + method + ' ' + url);
  };
}

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

/**
 * 再起一个**全新实例**（新沙箱 + 新存储 + 新模块状态）。
 *
 * 主沙箱跑到后面插件内部已经有账号凭据了，验不出"从零开始的用户"会看到什么。
 * 而"没有任何涂鸦账号、只用局域网手填"恰恰是最需要单独验的一条路
 * （插件内部的 auth 是模块级变量，没有任何钩子能把它清掉）。
 *
 * 这条路径不发任何网络请求，所以这里连 http 替身都不用配。
 */
function bootFreshPlugin() {
  const box = { store: {}, registered: null };
  const host = {
    http: rejectMethod('http', '测试环境不发真实网络请求'),
    httpForm: rejectMethod('httpForm'),
    secureStore: {
      get: function (k) { return Promise.resolve(box.store[k] === undefined ? null : box.store[k]); },
      set: function (k, v) { box.store[k] = v; return Promise.resolve(true); },
      delete: function (k) { delete box.store[k]; return Promise.resolve(true); }
    },
    crypto: HostMock.crypto,
    log: HostMock.log,
    getDevice: HostMock.getDevice,
    udp: HostMock.udp,
    tcp: HostMock.tcp,
    tls: HostMock.tls
  };
  const ctx = Object.assign({}, sandbox);
  ctx.Plugin = { register: function (o) { box.registered = o; } };
  ctx.Host = host;
  vm.createContext(ctx);
  vm.runInContext(bundle, ctx, { filename: 'main.fresh.js' });
  return { registered: box.registered, store: box.store };
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

  group('④ 无云凭据时，transport 可用性判断要保守');

  eq('isTransportAvailable(cloud) 无凭据时 false',
    await registered.isTransportAvailable('cloud', { did: ACC_DID }), false);

  group('⑤ loginBegin 首次：还没有用户码 → 出用户码表单');

  const begin = await registered.loginBegin();
  ok('loginBegin 可序列化', jsonSafe(begin) && !hasFunction(begin));
  ok('sessionId 非空', typeof begin.sessionId === 'string' && begin.sessionId.length > 0,
    String(begin.sessionId));
  ok('view 存在', !!begin.view);

  const ALLOWED_VIEWS = ['qr', 'web', 'form'];
  ok('view.type 是协议三选一', ALLOWED_VIEWS.indexOf(begin.view.type) >= 0,
    String(begin.view.type));
  eq('首次是 form（还缺用户码）', begin.view.type, 'form');

  const allowedFieldTypes = ['text', 'password', 'switch'];
  const badFields = begin.view.fields.filter(function (f) {
    return !f.key || !f.label || allowedFieldTypes.indexOf(f.type) < 0;
  });
  eq('字段都带 key/label 且类型合法', badFields, []);
  ok('有 userCode 字段', begin.view.fields.some(function (f) { return f.key === 'userCode'; }),
    begin.view.fields.map(function (f) { return f.key; }).join(','));
  ok('给了 submitLabel',
    typeof begin.view.submitLabel === 'string' && begin.view.submitLabel.length > 0,
    String(begin.view.submitLabel));

  group('⑥ loginSubmit：用户码填错要当场说清楚，不能静默存下来');

  // 从这里开始云链路一直用替身（后面的取规格、读状态也走它）
  const stubOpts = { badUserCode: false, scanned: false };
  stubHttp(function (method, url) { return tuyaApiStub(stubOpts)(method, url); });

  stubOpts.badUserCode = true;
  const badCode = await registered.loginSubmit(begin.sessionId, { userCode: 'WRONG-CODE' });
  stubOpts.badUserCode = false;

  eq('用户码错 → error', badCode.state, 'error');
  ok('错误信息指了去找用户码的路径',
    /用户码不正确/.test(String(badCode.message)) && /账号与安全/.test(String(badCode.message)),
    String(badCode.message));
  eq('错的用户码没有写进 secureStore', store.tuya_user_code, undefined);

  group('⑦ loginSubmit：用户码正确 → 存下来，并明确提示再点一次');

  const okCode = await registered.loginSubmit(begin.sessionId, {
    userCode: 'TEST-USER-CODE',
    manual: DID + ',' + KEY + ',' + IP + ',3.3,测试开关,kg'
  });

  // ⚠️ 这里返回 error 是**协议限制**下的有意设计：loginSubmit 只能回 {state}，
  //    没法说"下一步给你看二维码"。所以断言它必须是一条**进度提示**而不是失败。
  eq('返回 error（协议所限）', okCode.state, 'error');
  ok('但文案是进度提示，不是报错',
    /已校验通过/.test(String(okCode.message)) && /再点一次/.test(String(okCode.message)),
    String(okCode.message));
  eq('用户码写进了 secureStore', store.tuya_user_code, 'TEST-USER-CODE');
  ok('手填设备同时被保存了（两条路径可以共存）', !!store.auth);

  group('⑧ loginBegin 第二次：有用户码了 → 出二维码视图');

  const beginQr = await registered.loginBegin();
  eq('view.type = qr', beginQr.view.type, 'qr');
  ok('imageUrl 是 data: URI（宿主只认 http(s) / data:）',
    /^data:image\/png;base64,/.test(String(beginQr.view.imageUrl)),
    String(beginQr.view.imageUrl).slice(0, 40));
  ok('pollInterval > 0（否则宿主根本不轮询）',
    typeof beginQr.view.pollInterval === 'number' && beginQr.view.pollInterval > 0,
    String(beginQr.view.pollInterval));
  ok('pollInterval ≥ 2000ms（涂鸦要求轮询间隔不低于 2s）',
    beginQr.view.pollInterval >= 2000, String(beginQr.view.pollInterval));
  ok('expiresIn > 0（宿主据此倒计时）',
    typeof beginQr.view.expiresIn === 'number' && beginQr.view.expiresIn > 0,
    String(beginQr.view.expiresIn));
  ok('hint 告诉了用户用哪个 App 扫',
    typeof beginQr.view.hint === 'string' && /涂鸦|智能生活|扫/.test(beginQr.view.hint),
    String(beginQr.view.hint));

  const pngBytes = Buffer.from(String(beginQr.view.imageUrl).split(',')[1], 'base64');
  ok('二维码是一张真 PNG（签名 + IEND）',
    pngBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    && pngBytes.subarray(pngBytes.length - 8).toString('latin1').indexOf('IEND') >= 0,
    'len=' + pngBytes.length);

  // 二维码内容必须正好是 tuyaSmart--qrLogin?token=<token>（涂鸦 App 靠它认）
  let expectQrUri = '';
  try {
    expectQrUri = vm.runInContext(
      "qrMakePngDataUri('tuyaSmart--qrLogin?token=QR_TOKEN_TEST', 5, 4, 'Q')", sandbox
    );
  } catch (e) {
    expectQrUri = '生成失败：' + describe(e);
  }
  ok('二维码内容就是 tuyaSmart--qrLogin?token=<token>',
    beginQr.view.imageUrl === expectQrUri,
    '长度 ' + String(beginQr.view.imageUrl).length + ' vs ' + expectQrUri.length);

  group('⑨ loginPoll：还没扫必须 pending，扫到了才 success');

  const stillPending = await registered.loginPoll(beginQr.sessionId);
  eq('还没扫 → pending（不能抛错）', stillPending.state, 'pending');

  stubOpts.scanned = true;
  const done = await registered.loginPoll(beginQr.sessionId);
  eq('扫到了 → success', done.state, 'success');
  ok('凭据写进了 secureStore（用户码 + auth）',
    !!store.auth && store.tuya_user_code === 'TEST-USER-CODE');

  const replayed = await registered.loginPoll(beginQr.sessionId);
  eq('同一个会话再轮询不会二次成功', replayed.state, 'pending');

  const cancelled = await registered.loginCancel(beginQr.sessionId);
  eq('loginCancel → cancelled', cancelled.state, 'cancelled');

  group('⑩ 登录后 init 要变成 true（幂等）');

  eq('再 init → true', await registered.init({ pluginId: 'tuya-local' }), true);
  eq('第三次 init 仍为 true（幂等）', await registered.init({ pluginId: 'tuya-local' }), true);

  group('⑪ getHomes：还原真实的家庭 / 房间层级');

  const homes = await registered.getHomes();
  ok('getHomes 可序列化', jsonSafe(homes) && !hasFunction(homes));
  ok('返回至少一个家庭', Array.isArray(homes) && homes.length >= 1);
  const home = homes[0];
  ok('home.id 非空', typeof home.id === 'string' && home.id.length > 0, String(home.id));
  ok('home.name 非空', typeof home.name === 'string' && home.name.length > 0, String(home.name));
  ok('有 uid 字段', home.uid !== undefined, String(home.uid));
  ok('dids 是数组', Array.isArray(home.dids), typeof home.dids);
  ok('roomlist 是数组', Array.isArray(home.roomlist), typeof home.roomlist);
  eq('家庭用的是涂鸦的 ownerId', home.id, 'home-a');
  eq('家庭名来自接口', home.name, '我的家');
  ok('家庭里含账号拉回来的设备', home.dids.indexOf(ACC_DID) >= 0, home.dids.join(','));
  ok('手填设备也没被漏掉', home.dids.indexOf(DID) >= 0, home.dids.join(','));
  eq('还原出了 1 个房间', home.roomlist.length, 1);
  eq('房间字段是 id/name/dids', Object.keys(home.roomlist[0]).sort().join(','), 'dids,id,name');
  eq('房间名来自接口', home.roomlist[0].name, '客厅');
  ok('房间 dids 指向设备', home.roomlist[0].dids.indexOf(ACC_DID) >= 0,
    home.roomlist[0].dids.join(','));

  group('⑫ getDevices：key 是 did，Device 字段逐字对齐米家命名');

  const devices = await registered.getDevices();
  ok('getDevices 可序列化', jsonSafe(devices) && !hasFunction(devices));
  ok('两台设备（账号 1 + 手填 1）', Object.keys(devices).length >= 2,
    String(Object.keys(devices).length));
  ok('key 就是 did', !!devices[ACC_DID] && !!devices[DID], Object.keys(devices).join(','));

  const dev = devices[ACC_DID];
  const manualDev = devices[DID];
  const expectExact = ['did', 'name', 'model', 'spec_type', 'room_id', 'room_name',
    'home_id', 'home_name', 'isOnline', 'token', 'local_ip', 'parent_id',
    'uid', 'pid', 'icon', 'group_id', 'ssid', 'bssid', 'orderTime', 'rssi', 'extra'];
  eq('账号设备的米家命名字段一个不少',
    expectExact.filter(function (k) { return dev[k] === undefined; }), []);
  eq('手填设备的米家命名字段一个不少',
    expectExact.filter(function (k) { return manualDev[k] === undefined; }), []);
  ok('isOnline 是布尔（不是 online）', typeof dev.isOnline === 'boolean', typeof dev.isOnline);
  eq('token 是云端的 local_key', dev.token, ACC_KEY);
  eq('local_ip 是云端的 IP', dev.local_ip, ACC_IP);
  eq('home_id 指向真实家庭', dev.home_id, home.id);
  eq('room_id / room_name 来自房间接口', dev.room_id + '/' + dev.room_name, 'room-1/客厅');
  eq('手填设备的 token / IP 没被云数据冲掉',
    manualDev.token + '/' + manualDev.local_ip, KEY + '/' + IP);
  ok('没有驼峰别名 online / localIp / homeId',
    dev.online === undefined && dev.localIp === undefined && dev.homeId === undefined,
    JSON.stringify([dev.online, dev.localIp, dev.homeId]));
  ok('extra.fw_version 存在', dev.extra && typeof dev.extra.fw_version === 'string',
    JSON.stringify(dev.extra));

  group('⑬ getSpecForDevice：MIoT instance JSON 的形状');

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

  const activeSpec = await registered.getSpecForDevice({ did: ACC_DID });
  eq('同一台设备两次 getSpec 一致', JSON.stringify(activeSpec), JSON.stringify(spec));
  const manualSpec = await registered.getSpecForDevice(manualDev);
  ok('手填设备也能拿到 spec（不会被账号设备挤掉）',
    !!manualSpec && Array.isArray(manualSpec.services) && manualSpec.services.length >= 2,
    JSON.stringify(manualSpec && manualSpec.services && manualSpec.services.length));

  group('⑭ createTransports / isTransportAvailable');

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

  eq('isTransportAvailable(cloud) 登录后为 true',
    await registered.isTransportAvailable('cloud', dev), true);
  ok('isTransportAvailable 返回布尔',
    typeof (await registered.isTransportAvailable('lan', dev)) === 'boolean');

  group('⑮ 读：读失败必须 throw');

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

  group('⑯ 写：不存在的属性要拒绝，写失败要 throw');

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

  group('⑰ callAction：涂鸦没有动作模型，必须明确报错');

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

  group('⑱ 兼容两种调用形状（宿主版本间有过差异）');

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

  group('⑲ 已登录时提交空用户码，不能把账号凭据弄丢');

  // 场景：登录过之后又打开面板，"只想补一台手填设备" —— 用户码字段是空的
  const beginAgain = await registered.loginBegin();
  eq('已有用户码 → 直接出二维码，不再出表单', beginAgain.view.type, 'qr');

  const noopSubmit = await registered.loginSubmit(beginAgain.sessionId, {});
  eq('空用户码 + 没新增设备 → 幂等 success', noopSubmit.state, 'success');
  ok('账号凭据还是 account 模式（没被降级成 local）',
    /"mode"\s*:\s*"account"/.test(String(store.auth)), String(store.auth).slice(0, 160));
  eq('用户码也还在', store.tuya_user_code, 'TEST-USER-CODE');

  const addManual = await registered.loginSubmit(beginAgain.sessionId, {
    manual: 'tuya_test_device_0002,0123456789abcdef,192.168.1.51,3.3,补充开关,kg'
  });
  eq('空用户码 + 新增手填设备 → success', addManual.state, 'success');
  ok('账号凭据依旧保留', /"mode"\s*:\s*"account"/.test(String(store.auth)),
    String(store.auth).slice(0, 160));
  ok('新增的手填设备被合并进去了（不是覆盖）',
    String(store.auth).indexOf('tuya_test_device_0002') >= 0
    && String(store.auth).indexOf(DID) >= 0, String(store.auth).slice(0, 200));

  await registered.loginCancel(beginAgain.sessionId);

  group('⑳ 全新实例：没有任何涂鸦账号，只用局域网手填');

  const fresh = bootFreshPlugin();
  eq('全新实例 init → false（宿主据此显示登录入口）',
    await fresh.registered.init({ pluginId: 'tuya-local' }), false);

  const freshBegin = await fresh.registered.loginBegin();
  eq('首次是用户码表单', freshBegin.view.type, 'form');

  const freshLocal = await fresh.registered.loginSubmit(freshBegin.sessionId, {
    manual: DID + ',' + KEY + ',' + IP + ',3.3,测试开关,kg'
  });
  eq('只填设备不填用户码 → success', freshLocal.state, 'success');
  ok('存下来的是本地模式凭据',
    /"mode"\s*:\s*"local"/.test(String(fresh.store.auth)), String(fresh.store.auth).slice(0, 120));
  eq('没有顺手把用户码也写进去', fresh.store.tuya_user_code, undefined);

  eq('本地模式下 init → true', await fresh.registered.init({ pluginId: 'tuya-local' }), true);
  const freshDevices = await fresh.registered.getDevices();
  ok('设备列表不为空', Object.keys(freshDevices).length >= 1,
    String(Object.keys(freshDevices).length));
  const freshHome = (await fresh.registered.getHomes())[0];
  eq('收进一个固定家庭', freshHome.id, 'tuya');
  eq('没有房间层级', freshHome.roomlist.length, 0);
  eq('固定家庭的 dids 指向设备', freshHome.dids.join(','), DID);

  group('㉑ dispose 不抛错，且不清凭据');

  let disposeErr = null;
  try {
    await registered.dispose();
  } catch (e) {
    disposeErr = e;
  }
  ok('dispose 不抛错', disposeErr === null, disposeErr ? describe(disposeErr) : '');
  ok('dispose 没有清掉凭据（否则用户要重新登录）', !!store.auth);

  /* ------------------------------------------------ 清单与权限一致性 */

  group('㉒ plugin.json 与实现的一致性');

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
      // ⚠️ 声明的是 qr，但**首次** loginBegin 会返回 form（要收一次用户码）——
      //    这是有意为之：宿主按 view.type 渲染，qr 视图塞不下输入框。
      //    协议里 loginSubmit 也没法返回"下一个视图"，所以只能分两步。
      eq('login.type = qr（默认走扫码）', manifest.login.type, 'qr');
      ok('loginBegin 返回的 view.type 在协议三选一里',
        ALLOWED_VIEWS.indexOf(begin.view.type) >= 0 && ALLOWED_VIEWS.indexOf(beginQr.view.type) >= 0,
        begin.view.type + '/' + beginQr.view.type);
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
