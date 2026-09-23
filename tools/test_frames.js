/*
 * 帧编解码的交叉验证：拿 Python tinytuya 生成的「标准答案」逐字节比对。
 *
 * 这是没有真机时最强的验证手段 —— 只要字节完全一致，涂鸦设备就没有理由
 * 认不出我们发的包。
 *
 * 前置：先用 tools/gen_expected_frames.py 生成 expected_frames.json
 * 用法：node tools/test_frames.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const EXPECTED = path.join(__dirname, 'expected_frames.json');

if (!fs.existsSync(EXPECTED)) {
  console.error('缺少 ' + EXPECTED + '，请先运行：');
  console.error('  python tools/gen_expected_frames.py expected_frames.json');
  process.exit(1);
}

const files = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.js'); }).sort();
let bundle = '';
for (const f of files) bundle += fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';

const sandbox = { console: console, btoa: btoa, atob: atob, Math: Math, Date: Date, JSON: JSON, Uint8Array: Uint8Array, Uint32Array: Uint32Array, Error: Error, Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout };
vm.createContext(sandbox);
sandbox.Plugin = { register: function () {} };
sandbox.Host = new Proxy({}, { get: function () { return function () { return Promise.resolve({}); }; } });

vm.runInContext(bundle, sandbox, { filename: 'bundle.js' });
const G = sandbox;

const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
const meta = expected._meta;

let passed = 0;
let failed = 0;

const sessionKey = G.hexToBytes(meta.sessionKeyHex);
const fixedIv = G.hexToBytes(meta.gcmFixedIvHex);
const plainKey = G.latin1Bytes(meta.key);

console.log('\n== 编码方向：与 tinytuya 逐字节比对 ==');

for (const name of Object.keys(expected)) {
  if (name.charAt(0) === '_') continue; // _meta / _derivations 是元数据，不是用例
  const c = expected[name];
  const key = c.useSessionKey ? sessionKey : plainKey;

  let frame;
  try {
    const enc = G.encodeRequest(c.version, c.cmd, c.payloadJson, key);
    if (c.version >= 3.5) {
      frame = G.pack6699(1, enc.cmd, enc.body, key, fixedIv);
    } else {
      frame = G.pack55aa(1, enc.cmd, enc.body, c.version >= 3.4 ? key : null);
    }
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + ' —— 编码抛错: ' + e.message);
    continue;
  }

  const actualHex = G.bytesToHex(frame);
  if (actualHex === c.frameHex) {
    passed++;
    console.log('  ok   ' + name + '  (' + frame.length + ' 字节)');
  } else {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       期望 ' + c.frameHex);
    console.log('       实际 ' + actualHex);
    // 指出第一个不一致的字节，方便定位
    for (let i = 0; i < Math.max(c.frameHex.length, actualHex.length); i += 2) {
      if (c.frameHex.substr(i, 2) !== actualHex.substr(i, 2)) {
        console.log('       首个差异在第 ' + i / 2 + ' 字节: 期望 ' +
          c.frameHex.substr(i, 2) + ' 实际 ' + actualHex.substr(i, 2));
        break;
      }
    }
  }
}

/* ---------------------------------------------------------------------------
 * 解码方向：验证我们自己包的帧能被自己的解析器还原
 * （解码语义与 tinytuya 的 unpack_message 对齐 —— 帧里含 4 字节 retcode）
 * ------------------------------------------------------------------------- */

console.log('\n== 解码方向：构造设备响应并还原 ==');

/** 造一个「设备响应」帧：在 payload 前补 4 字节 retcode，并重算校验。 */
function makeResponseFrame(version, cmd, payloadJson, key) {
  const enc = G.encodeRequest(version, cmd, payloadJson, key);
  const retcode = new Uint8Array([0, 0, 0, 0]);

  if (version >= 3.5) {
    // 6699 的 retcode 在明文里，直接拼进明文再走 GCM
    const plain = G.bytesConcat([retcode, enc.body]);
    return { frame: G.pack6699(9, cmd, plain, key, fixedIv), cmd: cmd };
  }

  const payload = G.bytesConcat([retcode, enc.body]);
  // pack55aa 的 length 是 payload + tail，而响应方向 length 要含 retcode —— 
  // 这里正是靠把 retcode 拼进 payload 来自然满足
  const hmacKey = version >= 3.4 ? key : null;
  return { frame: G.pack55aa(9, enc.cmd, payload, hmacKey), cmd: enc.cmd };
}

const decodeCases = [
  ['v33 DP_QUERY 响应', 3.3, 10, '{"devId":"bf1234","dps":{"1":true,"2":50}}', false],
  ['v33 CONTROL 响应', 3.3, 7, '{"devId":"bf1234","dps":{"1":true}}', false],
  ['v31 CONTROL 响应', 3.1, 7, '{"devId":"bf1234","dps":{"1":false}}', false],
  ['v34 DP_QUERY_NEW 响应', 3.4, 16, '{"dps":{"1":true}}', true],
  ['v34 CONTROL_NEW 响应', 3.4, 13, '{"dps":{"1":true}}', true],
  ['v35 DP_QUERY_NEW 响应', 3.5, 16, '{"dps":{"1":true}}', true],
  ['v35 CONTROL_NEW 响应', 3.5, 13, '{"dps":{"1":true}}', true]
];

for (const [label, version, cmd, json, useSession] of decodeCases) {
  const key = useSession ? sessionKey : plainKey;
  try {
    const r = makeResponseFrame(version, cmd, json, key);
    const extracted = G.tryExtractFrame(r.frame);
    if (!extracted || extracted.bad) {
      failed++;
      console.log('  FAIL ' + label + ' —— 切帧失败');
      continue;
    }
    if (extracted.frame.length !== r.frame.length) {
      failed++;
      console.log('  FAIL ' + label + ' —— 切帧长度不符（吃掉 ' + extracted.frame.length +
        ' / 共 ' + r.frame.length + '）');
      continue;
    }

    let got;
    if (extracted.kind === '6699') {
      const msg = G.unpack6699(extracted.frame, key);
      if (!msg.crcOk) throw new Error('GCM 校验失败');
      got = G.parseJsonPayload(msg.payload);
    } else {
      const hmacKey = version >= 3.4 ? key : null;
      const msg = G.unpack55aa(extracted.frame, hmacKey);
      if (!msg.crcOk) throw new Error('CRC/HMAC 校验失败');
      got = G.decodeResponse(version, msg.payload, key);
      if (!got) throw new Error('payload 解密失败');
    }

    const gotDps = G.extractDps(got);
    const wantDps = JSON.parse(json).dps;
    if (JSON.stringify(gotDps) === JSON.stringify(wantDps)) {
      passed++;
      console.log('  ok   ' + label);
    } else {
      failed++;
      console.log('  FAIL ' + label + ' —— dps 不符');
      console.log('       期望 ' + JSON.stringify(wantDps));
      console.log('       实际 ' + JSON.stringify(gotDps) + '  (完整: ' + JSON.stringify(got) + ')');
    }
  } catch (e) {
    failed++;
    console.log('  FAIL ' + label + ' —— ' + e.message);
  }
}

/* ---------------------------------------------------------------------------
 * 粘包 / 切包：TCP 是流，必须能处理任意切分
 * ------------------------------------------------------------------------- */

console.log('\n== 流式切帧：粘包与任意切分 ==');

{
  const key = plainKey;
  const a = makeResponseFrame(3.3, 10, '{"dps":{"1":true}}', key).frame;
  const b = makeResponseFrame(3.3, 10, '{"dps":{"2":false}}', key).frame;
  const merged = G.bytesConcat([a, b]);

  // 模拟一次只喂 7 字节的极窄切分
  let buf = new Uint8Array(0);
  const got = [];
  for (let i = 0; i < merged.length; i += 7) {
    buf = G.bytesConcat([buf, merged.subarray(i, Math.min(i + 7, merged.length))]);
    for (;;) {
      const ex = G.tryExtractFrame(buf);
      if (!ex) break;
      buf = ex.rest;
      if (ex.bad) continue;
      got.push(ex.frame.length);
    }
  }
  if (got.length === 2 && got[0] === a.length && got[1] === b.length) {
    passed++;
    console.log('  ok   两帧粘在一起、按 7 字节切分仍能各切出一帧');
  } else {
    failed++;
    console.log('  FAIL 粘包切分 —— 切出 ' + JSON.stringify(got) + '，期望 [' + a.length + ',' + b.length + ']');
  }
}

/* ---------------------------------------------------------------------------
 * 会话密钥派生 + UDP 探测包：同样与 tinytuya / cryptography 对答案
 * ------------------------------------------------------------------------- */

console.log('\n== 会话密钥派生与 UDP 探测包 ==');
{
  const deriv = expected._derivations;
  const localNonce = G.hexToBytes(deriv.localNonceHex);
  const remoteNonce = G.hexToBytes(deriv.remoteNonceHex);
  const xored = new Uint8Array(16);
  for (let i = 0; i < 16; i++) xored[i] = localNonce[i] ^ remoteNonce[i];
  if (G.bytesToHex(xored) === deriv.xorHex) {
    passed++;
    console.log('  ok   nonce 异或');
  } else {
    failed++;
    console.log('  FAIL nonce 异或');
  }

  const sk34 = G.aesEcbEncrypt(plainKey, xored, true);
  if (G.bytesToHex(sk34) === deriv.sessionKey34Hex) {
    passed++;
    console.log('  ok   v3.4 会话密钥派生（ECB）');
  } else {
    failed++;
    console.log('  FAIL v3.4 会话密钥派生\n       期望 ' + deriv.sessionKey34Hex +
      '\n       实际 ' + G.bytesToHex(sk34));
  }

  const sk35 = G.aesGcmCtrEncrypt(plainKey, localNonce.subarray(0, 12), xored).subarray(0, 16);
  if (G.bytesToHex(sk35) === deriv.sessionKey35Hex) {
    passed++;
    console.log('  ok   v3.5 会话密钥派生（GCM-CTR）');
  } else {
    failed++;
    console.log('  FAIL v3.5 会话密钥派生\n       期望 ' + deriv.sessionKey35Hex +
      '\n       实际 ' + G.bytesToHex(sk35));
  }

  // 探测包：用 Python json.dumps 的默认格式（带空格）对齐字节
  const probe = G.buildDiscoveryFrame('192.168.1.100', fixedIv, 0, deriv.udpProbePlain);
  if (G.bytesToHex(probe) === deriv.udpProbeFrameHex) {
    passed++;
    console.log('  ok   UDP 探测包（6699 + REQ_DEVINFO + 公开 udpkey）');
  } else {
    failed++;
    console.log('  FAIL UDP 探测包\n       期望 ' + deriv.udpProbeFrameHex +
      '\n       实际 ' + G.bytesToHex(probe));
  }
}

console.log('\n--------------------------------');
console.log('通过 ' + passed + ' / 失败 ' + failed);
process.exit(failed === 0 ? 0 : 1);
