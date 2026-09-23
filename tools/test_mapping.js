/*
 * 映射层的自检：不依赖任何外部参考实现，验的是"契约"——
 *
 *   ① 产出的 spec 是不是宿主吃的那种 instance JSON 形状
 *      （services[].iid / properties[].iid+format+access+value-range+value-list）
 *   ② siid / piid 分配是否稳定、可复现（同输入同输出）
 *   ③ 双向值转换是否闭环：设备原始值 → MIoT 值 → 设备原始值
 *   ④ 三条来源（云 spec / DP_QUERY / 品类模板）都能铺出可用映射
 *   ⑤ 认不出的 DP 有没有落进 custom-dp（功能不丢）
 *
 * 用法：node tools/test_mapping.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const files = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.js'); }).sort();
let bundle = '';
for (const f of files) bundle += fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';

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
sandbox.Plugin = { register: function () {} };
sandbox.Host = new Proxy({}, { get: function () { return function () { return Promise.resolve({}); }; } });
vm.runInContext(bundle, sandbox, { filename: 'bundle.js' });
const G = sandbox;

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

/* ---------------------------------------------------------------- 用例 1：灯 */
group('① 灯具（dj）—— 布尔/枚举/整数/彩光都要转对');

const lightSpec = {
  category: 'dj',
  functions: [
    { code: 'switch_led', dp_id: 1, type: 'Boolean', values: '{}' },
    { code: 'work_mode', dp_id: 2, type: 'Enum', values: '{"range":["white","colour","scene","music"]}' },
    { code: 'bright_value', dp_id: 3, type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":1}' },
    { code: 'temp_value', dp_id: 4, type: 'Integer', values: '{"min":0,"max":1000,"scale":0,"step":1}' },
    { code: 'colour_data', dp_id: 5, type: 'Json', values: '{}' }
  ]
};

const light = G.buildMapping(lightSpec.category, G.functionsFromCloudSpec({ functions: lightSpec.functions }));

eq('主服务是 light', light.primarySvc, 'light');
eq('device urn token', light.spec.type.split(':')[3], 'light');
eq('服务数 = 2（设备信息 + 灯光）', light.spec.services.length, 2);

const lightSvc = light.spec.services[1];
eq('灯光服务 siid', lightSvc.iid, 2);
eq('灯光服务 urn token', lightSvc.type.split(':')[3], 'light');
eq('属性 iid 顺序按声明序', lightSvc.properties.map(function (p) { return p.iid; }), [1, 2, 3, 4, 5]);
// work_mode 是 attach 型，跟着主服务走 → 留在灯光服务里当第 5 个属性
eq('属性 token 顺序', lightSvc.properties.map(function (p) { return p.type.split(':')[3]; }),
  ['on', 'brightness', 'color-temperature', 'color', 'mode']);

const pOn = lightSvc.properties[0];
eq('on.format', pOn.format, 'bool');
eq('on.access', pOn.access, ['read', 'write']);
eq('on 有两条 value-list', pOn['value-list'].length, 2);
eq('on value-list 值', pOn['value-list'].map(function (v) { return v.value; }), [false, true]);

const pBright = lightSvc.properties[1];
// max=1000 > 255，所以按 uint16 出（不是 uint8）—— 范围决定位宽
eq('brightness.format 由范围决定', pBright.format, 'uint16');
eq('brightness.value-range 来自设备 values', pBright['value-range'], [10, 1000, 1]);

const pColor = lightSvc.properties[3];
eq('color.format', pColor.format, 'uint32');
eq('color.value-range', pColor['value-range'], [0, 16777215, 1]);

// 设备侧布尔 → MIoT
const eOn = G.findEntry(light, 2, 1);
eq('findEntry(2,1) 是 switch_led', eOn.code, 'switch_led');
eq('dp true → true', G.dpValueToMiot(eOn, true), true);
eq('dp false → false', G.dpValueToMiot(eOn, false), false);
eq('miot true → dp true', G.miotValueToDp(eOn, true), true);

// 枚举：字符串 ↔ 索引
const eMode = G.findEntryByCode(light, 'work_mode');
eq('work_mode enumValues', eMode.enumValues, ['white', 'colour', 'scene', 'music']);
eq('"colour" → 索引 1', G.dpValueToMiot(eMode, 'colour'), 1);
eq('索引 3 → "music"', G.miotValueToDp(eMode, 3), 'music');
eq('越界索引夹到末位', G.miotValueToDp(eMode, 99), 'music');
eq('未知枚举值 → undefined（不显示错档）', G.dpValueToMiot(eMode, 'nonsense'), undefined);

// 数值原样
const eBright = G.findEntryByCode(light, 'bright_value');
eq('亮度 500 → 500', G.dpValueToMiot(eBright, 500), 500);
eq('亮度写 500 → 500', G.miotValueToDp(eBright, 500), 500);

// 彩光：hex v1 与 json v2 都要认，且往返闭环
const eColor = G.findEntryByCode(light, 'colour_data');
eq('hex 红 → 0xFF0000', G.dpValueToMiot(eColor, '000003e803e8'), 0xff0000);
eq('json 红 → 0xFF0000', G.dpValueToMiot(eColor, '{"h":0,"s":1000,"v":1000}'), 0xff0000);
eq('0xFF0000 → hex 红', G.miotValueToDp(eColor, 0xff0000), '000003e803e8');
eq('空串彩光 → undefined', G.dpValueToMiot(eColor, ''), undefined);

/* ------------------------------------------------- 用例 2：多路开关 + 未知 DP */
group('② 三路开关（kg）—— multi 规则占多个 piid，未知 DP 进 custom-dp');

const kg = G.buildMapping('kg', G.functionsFromCloudSpec({
  functions: [
    { code: 'switch_1', dp_id: 1, type: 'Boolean', values: '{}' },
    { code: 'switch_2', dp_id: 2, type: 'Boolean', values: '{}' },
    { code: 'switch_3', dp_id: 3, type: 'Boolean', values: '{}' },
    { code: 'countdown_1', dp_id: 9, type: 'Integer', values: '{"unit":"s","min":0,"max":86400,"scale":0,"step":1}' }
  ]
}));

eq('主服务 switch', kg.primarySvc, 'switch');
const kgSwitch = kg.spec.services[1];
eq('三路开关占 piid 1/2/3', kgSwitch.properties.map(function (p) { return p.iid; }), [1, 2, 3]);
ok('三路都是 on 属性',
  kgSwitch.properties.every(function (p) { return p.type.split(':')[3] === 'on'; }),
  JSON.stringify(kgSwitch.properties.map(function (p) { return p.type; })));

const kgCustom = kg.spec.services[2];
ok('第三个服务是 custom-dp', kgCustom.type.indexOf('custom-dp') >= 0, kgCustom.type);
eq('countdown_1 落到 custom-dp', kgCustom.properties.length, 1);
eq('custom 属性 format 保留整数', kgCustom.properties[0].format, 'uint32');
eq('custom 属性带 value-range', kgCustom.properties[0]['value-range'], [0, 86400, 1]);

eq('dp2 映射到 piid 2', G.findEntryByDpId(kg, 2).piid, 2);
eq('byCode switch_3 存在', G.findEntryByCode(kg, 'switch_3').dpId, 3);

/* ------------------------------------------------ 用例 3：温控（缩放 + 枚举） */
group('③ 温控器（wk）—— 主服务 + 环境服务拆分、枚举/缩放闭环');

const wk = G.buildMapping('wk', G.functionsFromCloudSpec({
  functions: [
    { code: 'switch', dp_id: 1, type: 'Boolean', values: '{}' },
    { code: 'temp_set', dp_id: 2, type: 'Integer', values: '{"unit":"℃","min":5,"max":35,"scale":0,"step":1}' },
    { code: 'temp_current', dp_id: 3, type: 'Integer', values: '{"unit":"℃","min":-10,"max":50,"scale":0,"step":1}' },
    { code: 'mode', dp_id: 4, type: 'Enum', values: '{"range":["manual","auto"]}' },
    { code: 'child_lock', dp_id: 7, type: 'Boolean', values: '{}' }
  ]
}));

eq('主服务 thermostat', wk.primarySvc, 'thermostat');
const wkMain = wk.spec.services[1];
eq('温控服务 siid 2', wkMain.iid, 2);
eq('温控属性顺序', wkMain.properties.map(function (p) { return p.type.split(':')[3]; }),
  ['on', 'target-temperature', 'mode', 'child-lock']);
eq('童锁留在主服务（attach 生效）', G.findEntryByCode(wk, 'child_lock').svc, 'thermostat');

const wkEnv = wk.spec.services[2];
eq('环境服务 siid 3', wkEnv.iid, 3);
eq('环境服务 urn token', wkEnv.type.split(':')[3], 'environment');
eq('当前温度只读', wkEnv.properties[0].access, ['read']);
// min = -10 < 0 → 有符号；scale = 0 → 不进 float 分支
eq('当前温度 format', wkEnv.properties[0].format, 'int32');
eq('温度进入环境服务', G.findEntryByCode(wk, 'temp_current').svc, 'environment');

const eTempSet = G.findEntryByCode(wk, 'temp_set');
eq('目标温度 22 → 22', G.dpValueToMiot(eTempSet, 22), 22);
eq('目标温度写 22 → 22', G.miotValueToDp(eTempSet, 22), 22);
eq('目标温度 value-range 来自设备', G.toSpecProperty(eTempSet)['value-range'], [5, 35, 1]);

const eModeWk = G.findEntryByCode(wk, 'mode');
eq('mode 枚举标签', eModeWk.valueList.map(function (v) { return v.description; }), ['手动', '自动']);
eq('"auto" → 1', G.dpValueToMiot(eModeWk, 'auto'), 1);

/* ------------------------------------------------------ 用例 4：缩放（scale） */
group('④ 温湿度传感器（wsdcg）—— scale=1 的小数要还原');

const wsdcg = G.buildMapping('wsdcg', G.functionsFromCloudSpec({
  functions: [
    { code: 'va_temperature', dp_id: 1, type: 'Integer', values: '{"unit":"℃","min":-200,"max":800,"scale":1,"step":1}' },
    { code: 'va_humidity', dp_id: 2, type: 'Integer', values: '{"unit":"%","min":0,"max":100,"scale":0,"step":1}' },
    { code: 'battery_percentage', dp_id: 3, type: 'Integer', values: '{"unit":"%","min":0,"max":100,"scale":0,"step":1}' }
  ]
}));

const eTemp = G.findEntryByCode(wsdcg, 'va_temperature');
eq('scale=1 → divisor 10', eTemp.divisor, 10);
eq('设备 235 → 23.5℃', G.dpValueToMiot(eTemp, 235), 23.5);
eq('写 23.5℃ → 设备 235', G.miotValueToDp(eTemp, 23.5), 235);
eq('写 23.4℃ → 四舍五入 234', G.miotValueToDp(eTemp, 23.4), 234);
eq('温度 value-range 已除 10', G.toSpecProperty(eTemp)['value-range'], [-20, 80, 0.1]);
eq('温度 format float', eTemp.format, 'float');

eq('湿度走环境服务', G.findEntryByCode(wsdcg, 'va_humidity').svc, 'environment');
eq('电池走电池服务', G.findEntryByCode(wsdcg, 'battery_percentage').svc, 'battery');
ok('传感器拆出设备信息+环境+电池三个服务', wsdcg.spec.services.length >= 3,
  String(wsdcg.spec.services.length));

/* ------------------------------------------------------ 用例 5：品类模板兜底 */
group('⑤ 纯手动局域网 —— 品类模板 / DP_QUERY 两条兜底');

const tplFn = G.functionsFromTemplate('kt');
ok('kt 模板非空', tplFn.length > 0, String(tplFn.length));
ok('kt 模板含 temp_set', tplFn.some(function (f) { return f.code === 'temp_set'; }));

const ktTpl = G.buildMapping('kt', tplFn);
eq('模板主服务 air-conditioner', ktTpl.primarySvc, 'air-conditioner');
eq('模板空调服务 urn token', ktTpl.spec.services[1].type.split(':')[3], 'air-conditioner');

// DP_QUERY：键是 dp id，值给类型线索；品类模板能对上号就用模板的 code
const fromDps = G.functionsFromDps({ '1': true, '2': 23, '3': 235 }, 'wsdcg');
eq('DP_QUERY 借模板认出 code', fromDps.map(function (f) { return f.code; }),
  ['va_temperature', 'va_humidity', 'battery_percentage']);
const dpsMap = G.buildMapping('wsdcg', fromDps);
eq('DP_QUERY 路线也能出温度属性', G.findEntryByCode(dpsMap, 'va_temperature').piid, 1);

// 完全没有模板的品类：只能造 dp_N，全进 custom-dp
const unknown = G.functionsFromDps({ '1': true, '7': 'hello' }, 'zzzz');
eq('未知品类 → dp_1 / dp_7', unknown.map(function (f) { return f.code; }), ['dp_1', 'dp_7']);
const unknownMap = G.buildMapping('zzzz', unknown);
eq('未知品类回退主服务 switch', unknownMap.primarySvc, 'switch');
const uCustom = unknownMap.spec.services[unknownMap.spec.services.length - 1];
ok('全部落进 custom-dp', uCustom.type.indexOf('custom-dp') >= 0, uCustom.type);
eq('custom 服务有两条', uCustom.properties.length, 2);

/* ---------------------------------------------------------- 用例 6：稳定与寻址 */
group('⑥ 稳定性与寻址能力');

const a = G.buildMapping('dj', G.functionsFromCloudSpec({ functions: lightSpec.functions }));
const b = G.buildMapping('dj', G.functionsFromCloudSpec({ functions: lightSpec.functions }));
eq('两次构建结果完全一致', JSON.stringify(a.spec), JSON.stringify(b.spec));

const addrEntry = G.findEntryByCode(a, 'switch_led');
eq('有 dpId → 载荷键用数字 id', G.dpPayloadKey(addrEntry, 3.3), '1');
ok('有 dpId → 任何版本可寻址', G.isEntryAddressable(addrEntry, 3.1) === true);

const noId = { dpId: null, code: 'switch_led' };
eq('无 dpId + v3.3 → 用 code（不可靠）', G.dpPayloadKey(noId, 3.3), 'switch_led');
ok('无 dpId + v3.3 → 标记为不可寻址', G.isEntryAddressable(noId, 3.3) === false);
ok('无 dpId + v3.4 → 认为可寻址', G.isEntryAddressable(noId, 3.4) === true);

/* ------------------------------------------------------------ 用例 7：边界 */
group('⑦ 边界输入不能炸');

ok('空函数列表不炸', G.buildMapping('kg', []).spec.services.length >= 1);
ok('null 函数列表不炸', G.buildMapping('kg', null).spec.services.length >= 1);
ok('坏 values 字符串不炸', (function () {
  const m = G.buildMapping('kg', [{ code: 'temp_set', dpId: 2, type: 'Integer', values: '{bad json' }]);
  return G.findEntryByCode(m, 'temp_set') !== null;
})());
eq('空 code 被跳过', G.buildMapping('kg', [{ code: '', dpId: 1, type: 'Boolean' }]).entries.length, 0);
ok('未知品类不炸', G.buildMapping('', [{ code: 'switch_1', dpId: 1, type: 'Boolean' }]).primarySvc === 'switch');
ok('枚举空 range 不产生空 value-list', (function () {
  const m = G.buildMapping('kg', [{ code: 'work_mode', dpId: 2, type: 'Enum', values: '{"range":[]}' }]);
  const p = G.toSpecProperty(G.findEntryByCode(m, 'work_mode'));
  return p['value-list'] === undefined;
})());

/* ------------------------------------------------------------------ 汇总 */
console.log('\n' + '='.repeat(56));
console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fail > 0) {
  console.log('失败：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('映射层自检全部通过 ♪');
