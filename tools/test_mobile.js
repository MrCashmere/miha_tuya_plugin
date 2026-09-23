/*
 * 手机端云 API 自检：签名、加密、URL 全部和**官方 SDK** 逐字段比对。
 *
 * 参照物是 `tuya-device-sharing-sdk` 本身（涂鸦官方维护、HA 主线在用），
 * 不是我们自己转写的版本 —— 所以这是真的独立验证。
 *
 * 前置：python tools/gen_expected_mobile.py > tools/expected_mobile.json
 * 用法：node tools/test_mobile.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const EXPECTED = path.join(ROOT, 'tools', 'expected_mobile.json');

/* ---------------------------------------------------------- 装载源码 */

// 除了 register 那层，其余全带上：模块间共享闭包作用域，缺一个就可能 undefined
const FILES = ['00-util.js', '05-qr.js', '10-crypto.js', '20-lan.js', '30-cloud.js',
  '35-mobile.js', '40-mapping.js'];
let bundle = '';
for (const f of FILES) bundle += fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';

const httpCalls = [];

const sandbox = {
  console: console,
  btoa: btoa,
  atob: atob,
  Math: Math,
  Date: Date,
  JSON: JSON,
  Object: Object,
  Array: Array,
  Number: Number,
  String: String,
  Boolean: Boolean,
  RegExp: RegExp,
  Error: Error,
  TypeError: TypeError,
  Uint8Array: Uint8Array,
  Uint32Array: Uint32Array,
  Int32Array: Int32Array,
  Promise: Promise,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  isNaN: isNaN,
  isFinite: isFinite,
  parseInt: parseInt,
  parseFloat: parseFloat,
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent
};
vm.createContext(sandbox);
sandbox.Host = {
  http: function (method, url, headers, body) {
    httpCalls.push({ method: method, url: url, headers: headers, body: body });
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({ success: true, result: {}, t: 1 }),
      headers: {},
      cookies: {}
    });
  },
  crypto: {
    randomBytes: function (n) {
      // 固定字节流，配合 mobileSetTestVector 让结果可复现
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 0xff;
      return Promise.resolve(b.toString('base64'));
    }
  },
  log: {
    info: function () { return Promise.resolve(true); },
    error: function () { return Promise.resolve(true); }
  }
};
vm.runInContext(bundle, sandbox, { filename: 'bundle.js' });

const {
  mobileHashKey, mobileSecret, mobileSign, mobileEncrypt, mobileDecrypt,
  mobileSignStr, mobileQrCreate, mobileQrPoll, mobileSetTestVector,
  mobileAuthFromLogin, mobileReadTokenFields, mobileCompactJson
} = sandbox;

/* ---------------------------------------------------------- 断言工具 */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    const line = name + (detail ? '  → ' + detail : '');
    failures.push(line);
    console.log('  \u2717 ' + line);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

/* --------------------------------------------------------------- 用例 */

const data = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));

async function main() {
  console.log('签名 / 加密与官方 SDK 逐字段比对（' + data.cases.length + ' 组）\n');

  // const 声明不会挂到沙箱全局对象上（只有 function 会），得在上下文里求值
  const appKey = vm.runInContext('MOBILE_APP_KEY', sandbox);
  const schema = vm.runInContext('MOBILE_SCHEMA', sandbox);
  eq('client_id 与官方一致', appKey, data.appKey);
  eq('schema 与官方一致', schema, data.schema);

  for (const c of data.cases) {
    console.log('· ' + c.name);
    mobileSetTestVector(c.rid, c.nonce);

    // ① hashKey = md5(rid + refresh_token)
    const hashKey = mobileHashKey(c.rid, c.refreshToken);
    eq('  hashKey', hashKey, c.hashKey);

    // ② secret = hmacSha256(rid, hashKey).hex[:16]
    const secret = mobileSecret(c.rid, hashKey);
    eq('  secret', secret, c.secret);
    eq('  secret 长度 16（AES-128 密钥）', secret.length, 16);

    // ③ 加密后的 query / body
    //    明文必须走 mobileCompactJson（紧凑 + 非 ASCII 转义），和 Python 的
    //    json.dumps(separators=(",", ":")) 对齐 —— 直接用 JSON.stringify 会差一截。
    let queryEnc = '';
    if (c.params) {
      const plain = mobileCompactJson(c.params);
      queryEnc = await mobileEncrypt(plain, secret);
      eq('  queryEnc', queryEnc, c.queryEnc);
      eq('  queryEnc 与 SDK 一致（长度）', queryEnc.length, c.queryEnc.length);
      // 反解：密文里必须就是那份明文
      eq('  queryEnc 能解回原参数', mobileDecrypt(queryEnc, secret), plain);
    } else {
      eq('  无参数时 queryEnc 为空', queryEnc, '');
    }

    let bodyEnc = '';
    if (c.body) {
      const plain = mobileCompactJson(c.body);
      bodyEnc = await mobileEncrypt(plain, secret);
      eq('  bodyEnc', bodyEnc, c.bodyEnc);
      eq('  bodyEnc 能解回原 body', mobileDecrypt(bodyEnc, secret), plain);
    } else {
      eq('  无 body 时 bodyEnc 为空', bodyEnc, '');
    }

    // ④ 签名
    const sign = mobileSign(hashKey, c.headers, queryEnc, bodyEnc);
    eq('  sign', sign, c.sign);

    // ⑤ 签名串拼法（头部用 || 连接、与密文之间无分隔符）
    const expectStr = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']
      .filter(function (k) { return c.headers[k]; })
      .map(function (k) { return k + '=' + c.headers[k]; })
      .join('||') + queryEnc + bodyEnc;
    eq('  签名串拼法', mobileSignStr(c.headers, queryEnc, bodyEnc), expectStr);
  }

  /* ------------------------------------------------------ 二维码 URL */

  console.log('\n二维码请求 URL 与 SDK 一致\n');

  sandbox.Host.http = function (method, url) {
    httpCalls.push({ method: method, url: url });
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({
        success: true,
        t: 1758600000000,
        result: { qrcode: 'QRTOKEN-abc123' }
      })
    });
  };

  httpCalls.length = 0;
  const token = await mobileQrCreate('usercode-01');
  eq('换二维码的方法', httpCalls[0].method, data.qrRequests[0].method);
  eq('换二维码的 URL', httpCalls[0].url, data.qrRequests[0].url);
  eq('取出了 qrcode token', token, 'QRTOKEN-abc123');

  httpCalls.length = 0;
  await mobileQrPoll('usercode-01', 'QRTOKEN-abc123');
  eq('轮询的方法', httpCalls[0] ? httpCalls[0].method : null, data.qrRequests[1].method);
  eq('轮询的 URL', httpCalls[0] ? httpCalls[0].url : null, data.qrRequests[1].url);

  /* ------------------------------------------------ 轮询的返回值语义 */

  console.log('\n轮询语义：还没扫不能抛错\n');

  // 「还没扫」时接口给的是 success:false —— 必须映射成 ok:false，不能抛
  sandbox.Host.http = function () {
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({ success: false, code: 1010, msg: '还没扫' })
    });
  };
  const pending = await mobileQrPoll('u', 't');
  eq('success=false 时 ok 为 false（上层据此返回 pending）', pending.ok, false);
  eq('保留了错误码，便于排查', pending.code, 1010);

  // success:true 且带结果
  sandbox.Host.http = function () {
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({
        success: true,
        t: 1758600000000,
        result: {
          uid: 'u1', endpoint: 'https://a1.tuyacn.com',
          terminal_id: 'tid', access_token: 'at', refresh_token: 'rt', expire_time: 7200
        }
      })
    });
  };
  const done = await mobileQrPoll('u', 't');
  eq('扫码成功后 ok 为 true', done.ok, true);
  eq('带回了 endpoint', done.result.endpoint, 'https://a1.tuyacn.com');

  const auth = sandbox.mobileAuthFromLogin('usercode-01', done.result);
  eq('落成的 auth.mode', auth.mode, 'account');
  eq('落成的 endpoint', auth.endpoint, 'https://a1.tuyacn.com');
  eq('落成的 terminalId', auth.terminalId, 'tid');
  eq('token 有效期是「现在 + expire_time」', auth.expireTime > Date.now() + 7000 * 1000, true);

  // 刷新令牌返回的是 camelCase —— 两种拼法都要认
  eq('camelCase 的刷新返回也能读',
    sandbox.mobileReadTokenFields({ accessToken: 'a2', refreshToken: 'r2', expireTime: 3600 }) !== null,
    true);

  /* ------------------------------------------------------------ 汇总 */

  console.log('\n' + '='.repeat(56));
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  if (fail > 0) {
    console.log('失败：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('手机端云 API 自检全部通过 ♪');
}

main().catch(function (e) {
  console.error('用例执行出错：' + (e && e.message));
  console.error(e && e.stack);
  process.exit(1);
});
