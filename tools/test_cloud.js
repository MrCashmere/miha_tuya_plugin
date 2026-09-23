/*
 * 云 OpenAPI 签名的交叉验证：与涂鸦官方 SDK（tuya-connector-python）对答案。
 *
 * 时间戳被固定住（sandbox 里的 Date.now 是假的），否则签名每次都不同。
 *
 * 前置：python tools/gen_expected_cloud.py expected_cloud.json
 * 用法：node tools/test_cloud.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const EXPECTED = path.join(__dirname, 'expected_cloud.json');

if (!fs.existsSync(EXPECTED)) {
  console.error('缺少 ' + EXPECTED + '，请先运行：');
  console.error('  python tools/gen_expected_cloud.py expected_cloud.json');
  process.exit(1);
}

const files = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.js'); }).sort();
let bundle = '';
for (const f of files) bundle += fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';

const FIXED_NOW = 1700000000000;

const sandbox = {
  console: console,
  btoa: btoa,
  atob: atob,
  Math: Math,
  // 固定时间，让签名可复现
  Date: { now: function () { return FIXED_NOW; } },
  JSON: JSON,
  Uint8Array: Uint8Array,
  Uint32Array: Uint32Array,
  Error: Error,
  Promise: Promise,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
vm.createContext(sandbox);
sandbox.Plugin = { register: function () {} };
sandbox.Host = new Proxy({}, { get: function () { return function () { return Promise.resolve({}); }; } });

vm.runInContext(bundle, sandbox, { filename: 'bundle.js' });
const G = sandbox;

const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
const meta = expected._meta;

let passed = 0;
let failed = 0;

function eq(name, actual, want) {
  if (String(actual) === String(want)) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + '\n       期望 ' + want + '\n       实际 ' + actual);
  }
}

console.log('\n== 云 OpenAPI 签名：与官方 SDK 逐字符比对 ==');

const auth = {
  accessId: meta.accessId,
  accessSecret: meta.accessSecret,
  accessToken: meta.accessToken,
  endpoint: meta.endpoint
};

for (const name of Object.keys(expected)) {
  if (name.charAt(0) === '_') continue;
  const c = expected[name];
  const a = Object.assign({}, auth, { accessToken: c.useToken ? meta.accessToken : '' });

  let signed;
  try {
    signed = G.cloudSign(a, c.method, c.path, c.query, c.bodyJson);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + ' —— 抛错: ' + e.message);
    continue;
  }

  const signOk = signed.sign === c.sign;
  const tOk = String(signed.t) === String(c.t);
  if (signOk && tOk) {
    passed++;
    console.log('  ok   ' + name + '  (' + c.method + ' ' + c.path + ')');
  } else {
    failed++;
    console.log('  FAIL ' + name);
    if (!tOk) console.log('       t 不符: 期望 ' + c.t + ' 实际 ' + signed.t);
    if (!signOk) {
      console.log('       sign 期望 ' + c.sign);
      console.log('       sign 实际 ' + signed.sign);
    }
  }
}

console.log('\n== 数据中心端点解析 ==');
eq('cn → tuyacn', G.resolveEndpoint('cn'), 'https://openapi.tuyacn.com');
eq('US（大写）→ tuyaus', G.resolveEndpoint('US'), 'https://openapi.tuyaus.com');
eq('eu → tuyaeu', G.resolveEndpoint('eu'), 'https://openapi.tuyaeu.com');
eq('in → tuyain', G.resolveEndpoint('in'), 'https://openapi.tuyain.com');
eq('留空 → 默认中国区', G.resolveEndpoint(''), 'https://openapi.tuyacn.com');
eq('完整 URL 原样用（去掉尾斜杠）', G.resolveEndpoint('https://my.tuya.proxy/'), 'https://my.tuya.proxy');

console.log('\n--------------------------------');
console.log('通过 ' + passed + ' / 失败 ' + failed);
process.exit(failed === 0 ? 0 : 1);
