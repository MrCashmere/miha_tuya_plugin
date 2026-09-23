/*
 * 密码学层的标准测试向量自检。
 *
 * 这些向量来自公开标准（RFC 1321 / FIPS 180-4 / RFC 4231 / FIPS 197 / NIST GCM），
 * 不是「自己算一遍自己也对」的假测试 —— 每一条都是独立可查的权威值。
 *
 * 用法：node tools/test_crypto.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

// 把 src 下所有 .js 按文件名顺序拼成一个脚本，在同一个作用域里求值，
// 等价于宿主把 main.js 包进 IIFE 的行为。
const files = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.js'); }).sort();
let bundle = '';
for (const f of files) bundle += fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';

const sandbox = { console: console, btoa: btoa, atob: atob, Math: Math, Date: Date, JSON: JSON, Uint8Array: Uint8Array, Uint32Array: Uint32Array, Error: Error, btoa: btoa };
vm.createContext(sandbox);

// 只取 crypto 部分来跑（后面章节可能引用 Host，这里先注入假 Host）
sandbox.Plugin = { register: function () {} };
sandbox.Host = new Proxy({}, { get: function () { return function () { return Promise.resolve({}); }; } });

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  const a = String(actual);
  const e = String(expected);
  if (a === e) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + '\n         期望 ' + e + '\n         实际 ' + a);
  }
}

try {
  vm.runInContext(bundle, sandbox, { filename: 'bundle.js' });
} catch (e) {
  console.error('！！！ 拼接后的脚本无法求值（语法错误或顶层异常）：');
  console.error(e);
  process.exit(1);
}

const G = sandbox;

console.log('\n== MD5 (RFC 1321) ==');
eq('md5("")', G.md5Hex(G.utf8Bytes('')), 'd41d8cd98f00b204e9800998ecf8427e');
eq('md5("abc")', G.md5Hex(G.utf8Bytes('abc')), '900150983cd24fb0d6963f7d28e17f72');
eq(
  'md5("message digest")',
  G.md5Hex(G.utf8Bytes('message digest')),
  'f96b697d7cb7938d525a2f31aaf161d0'
);
eq(
  'md5(长串 80 字符)',
  G.md5Hex(G.utf8Bytes('12345678901234567890123456789012345678901234567890123456789012345678901234567890')),
  '57edf4a22be3c955ac49da2e2107b67a'
);

console.log('\n== SHA-256 (FIPS 180-4) ==');
eq('sha256("")', G.sha256Hex(G.utf8Bytes('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
eq('sha256("abc")', G.sha256Hex(G.utf8Bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
eq(
  'sha256("abcdbcde...")',
  G.sha256Hex(G.utf8Bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
);

console.log('\n== HMAC-SHA256 (RFC 4231) ==');
eq(
  'hmac key=0x0b*20 msg="Hi There"',
  G.bytesToHex(G.hmacSha256Bytes(new Uint8Array(20).fill(0x0b), G.utf8Bytes('Hi There'))),
  'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
);
eq(
  'hmac key="Jefe" msg="what do ya want for nothing?"',
  G.bytesToHex(G.hmacSha256Bytes(G.utf8Bytes('Jefe'), G.utf8Bytes('what do ya want for nothing?'))),
  '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
);

console.log('\n== CRC32 ==');
eq('crc32("123456789")', G.crc32(G.utf8Bytes('123456789')).toString(16), 'cbf43926');

console.log('\n== AES-128-ECB (FIPS 197 C.1) ==');
const aesKey = G.hexToBytes('000102030405060708090a0b0c0d0e0f');
const aesPlain = G.hexToBytes('00112233445566778899aabbccddeeff');
eq(
  'ECB 单块加密',
  G.bytesToHex(G.aesEcbEncrypt(aesKey, aesPlain, true)),
  '69c4e0d86a7b0430d8cdb78070b4c55a'
);
eq(
  'ECB 单块解密',
  G.bytesToHex(G.aesEcbDecrypt(aesKey, G.hexToBytes('69c4e0d86a7b0430d8cdb78070b4c55a'), true)),
  '00112233445566778899aabbccddeeff'
);

console.log('\n== AES-128-GCM (NIST SP 800-38D) ==');
const gcmKey0 = new Uint8Array(16);
const gcmIv0 = new Uint8Array(12);
{
  const r = G.aesGcmEncrypt(gcmKey0, gcmIv0, new Uint8Array(0), new Uint8Array(0));
  eq('GCM 空明文 tag', G.bytesToHex(r.tag), '58e2fccefa7e3061367f1d57a4e7455a');
}
{
  const p = G.hexToBytes('00000000000000000000000000000000');
  const r = G.aesGcmEncrypt(gcmKey0, gcmIv0, new Uint8Array(0), p);
  eq('GCM 16 字节密文', G.bytesToHex(r.cipher), '0388dace60b6a392f328c2b971b2fe78');
  eq('GCM 16 字节 tag', G.bytesToHex(r.tag), 'ab6e47d42cec13bdf53a67b21257bddf');
  const back = G.aesGcmDecrypt(gcmKey0, gcmIv0, new Uint8Array(0), r.cipher, r.tag);
  eq('GCM 往返还原', G.bytesToHex(back), '00000000000000000000000000000000');
}
{
  // 带 AAD 的向量：验证 AAD 真的进了 tag
  const key = G.hexToBytes('feffe9928665731c6d6a8f9467308308');
  const iv = G.hexToBytes('cafebabefacedbaddecaf888');
  const plain = G.hexToBytes(
    'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39'
  );
  const aad = G.hexToBytes('feedfacedeadbeeffeedfacedeadbeefabaddad2');
  const r = G.aesGcmEncrypt(key, iv, aad, plain);
  eq(
    'GCM 带 AAD 密文',
    G.bytesToHex(r.cipher),
    '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091'
  );
  eq('GCM 带 AAD tag', G.bytesToHex(r.tag), '5bc94fbc3221a5db94fae95ae7121a47');
}

console.log('\n== UTF-8 / Base64 / hex 工具 ==');
eq('utf8 往返（含 emoji）', G.bytesUtf8(G.utf8Bytes('灯·开关🌊abc')), '灯·开关🌊abc');
eq('base64 往返', G.bytesToB64(G.b64ToBytes('SGVsbG8=')), 'SGVsbG8=');
eq('latin1 16 字节 key', G.latin1Bytes('0123456789abcdef').length, 16);
eq('hex 往返', G.bytesToHex(G.hexToBytes('deadBEEF')), 'deadbeef');

console.log('\n--------------------------------');
console.log('通过 ' + passed + ' / 失败 ' + failed);
process.exit(failed === 0 ? 0 : 1);
