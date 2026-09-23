/* ============================================================================
 * §9  Tuya DP ⇄ MIoT 能力描述映射
 *
 * 这一层解决的是移植里最"脏"的那部分：Tuya 的数据模型是
 *   「品类 + DP（功能点，数字 id + 字符串 code + 类型 + 数值约束）」
 * 而 miha 宿主只认 MIoT：
 *   「siid（服务） / piid（属性） + format + access + value-range / value-list」
 *
 * 用户选定的策略是**通用品类映射表**：
 *   ① 有一份静态的「DP code → MIoT 属性」规则表（覆盖涂鸦各品类最常见的那批 code）；
 *   ② 设备真实的功能点列表（云 spec 或局域网 DP_QUERY）决定实际生成哪些属性；
 *   ③ 规则表认不出来的 DP 一律塞进「自定义」服务，绝不丢功能；
 *   ④ 纯手动局域网接入（没有云端 spec）时，再退到品类参考模板。
 *
 * 直接读 miha 内核对 spec 的契约（mijia-cloud/main.js:2406 getSpecForDevice）：
 *   - 返回 **miot-spec.org 的原始 instance JSON**，宿主自己 parse，插件不做二次加工；
 *   - 形状：{ type, description, services:[ {iid, type, description, properties:[], actions:[]} ] }
 *   - properties[].iid 就是 piid；数值约束用 kebab-case 的 value-range / value-list；
 *   - 宿主**按服务名/属性名去找**，不硬编码 siid（mijia-cloud 里反复强调过），
 *     所以 siid / piid 只要自洽即可，urn 里的 token 才是宿主的语义锚点。
 *
 * 三个方向都要能translate，否则控制链路会断：
 *   getProperties(siid,piid)  → 找 dp  → 读原始值 → 按 divisor/enum 转成 MIoT 值
 *   setProperty(siid,piid,v)  → 找 dp  → MIoT 值转回原始值 → 下发
 *   callAction(siid,aiid,in)  → 查伪动作表 → 落到某个 dp 写入
 * ========================================================================== */

/* ---------------------------------------------------------------- MIoT urn */

/**
 * 服务 urn 表。
 *
 * 数字段（000078xx）是 MIoT 规范里的 service id：常见的那几个我按规范写，
 * 少数几个规范里少见的用 00007 8xx 段的近似值 —— 宿主只从 urn 里取
 * **token**（`serviceToken()` 用 split(':')[3]）来决定语义，数字段不参与判断，
 * 所以近似值不会影响宿主行为，只影响"看起来像不像规范"。
 */
const MIOT_SERVICES = {
  'device-information': { urn: 'urn:miot-spec-v2:service:device-information:00007801', desc: '设备信息' },
  light: { urn: 'urn:miot-spec-v2:service:light:00007802', desc: '灯光' },
  'air-conditioner': { urn: 'urn:miot-spec-v2:service:air-conditioner:00007805', desc: '空调' },
  'air-purifier': { urn: 'urn:miot-spec-v2:service:air-purifier:00007806', desc: '空气净化器' },
  'dehumidifier': { urn: 'urn:miot-spec-v2:service:dehumidifier:00007807', desc: '除湿机' },
  fan: { urn: 'urn:miot-spec-v2:service:fan:00007808', desc: '风扇' },
  heater: { urn: 'urn:miot-spec-v2:service:heater:00007809', desc: '取暖器' },
  environment: { urn: 'urn:miot-spec-v2:service:environment:0000780A', desc: '环境' },
  'thermostat': { urn: 'urn:miot-spec-v2:service:thermostat:0000780B', desc: '温控器' },
  'switch': { urn: 'urn:miot-spec-v2:service:switch:0000780C', desc: '开关' },
  battery: { urn: 'urn:miot-spec-v2:service:battery:0000780E', desc: '电池' },
  'humidifier': { urn: 'urn:miot-spec-v2:service:humidifier:00007804', desc: '加湿器' },
  alarm: { urn: 'urn:miot-spec-v2:service:alarm:00007818', desc: '告警' },
  'water-heater': { urn: 'urn:miot-spec-v2:service:water-heater:00007821', desc: '热水器' },
  curtain: { urn: 'urn:miot-spec-v2:service:curtain:00007820', desc: '窗帘' },
  // 兜底：规则表认不出来的 DP 全进这里，保证「功能不丢」
  'custom-dp': { urn: 'urn:miot-spec-v2:service:custom-dp:000078FF', desc: '其他功能点' }
};

/** 属性的 urn。数字段同上：常见属性按规范写，冷门属性近似。 */
const MIOT_PROPS = {
  'name': 'urn:miot-spec-v2:property:name:00000001',
  'model': 'urn:miot-spec-v2:property:model:00000002',
  'serial-number': 'urn:miot-spec-v2:property:serial-number:00000003',
  'firmware-revision': 'urn:miot-spec-v2:property:firmware-revision:00000004',
  'on': 'urn:miot-spec-v2:property:on:00000006',
  'status': 'urn:miot-spec-v2:property:status:00000007',
  'mode': 'urn:miot-spec-v2:property:mode:00000008',
  'fault': 'urn:miot-spec-v2:property:fault:00000009',
  'alarm': 'urn:miot-spec-v2:property:alarm:0000000C',
  'brightness': 'urn:miot-spec-v2:property:brightness:0000000D',
  'color': 'urn:miot-spec-v2:property:color:0000000E',
  'color-temperature': 'urn:miot-spec-v2:property:color-temperature:0000000F',
  'battery-level': 'urn:miot-spec-v2:property:battery-level:00000014',
  'charging-state': 'urn:miot-spec-v2:property:charging-state:00000015',
  'fan-level': 'urn:miot-spec-v2:property:fan-level:00000016',
  'temperature': 'urn:miot-spec-v2:property:temperature:00000020',
  'target-temperature': 'urn:miot-spec-v2:property:target-temperature:00000021',
  'vertical-swing': 'urn:miot-spec-v2:property:vertical-swing:00000025',
  'horizontal-swing': 'urn:miot-spec-v2:property:horizontal-swing:00000026',
  'relative-humidity': 'urn:miot-spec-v2:property:relative-humidity:0000002B',
  'motor-control': 'urn:miot-spec-v2:property:motor-control:0000002F',
  'current-position': 'urn:miot-spec-v2:property:current-position:00000030',
  'target-position': 'urn:miot-spec-v2:property:target-position:00000031',
  'pm2.5-density': 'urn:miot-spec-v2:property:pm2.5-density:00000034',
  'co2-density': 'urn:miot-spec-v2:property:co2-density:00000035',
  'tvoc-density': 'urn:miot-spec-v2:property:tvoc-density:00000036',
  'illumination': 'urn:miot-spec-v2:property:illumination:00000027',
  'form-aldehyde': 'urn:miot-spec-v2:property:form-aldehyde:00000037',
  'target-humidity': 'urn:miot-spec-v2:property:target-humidity:0000002C',
  'water-level': 'urn:miot-spec-v2:property:water-level:0000003A',
  'anion': 'urn:miot-spec-v2:property:anion:0000003B',
  'eco-mode': 'urn:miot-spec-v2:property:eco-mode:00000038',
  'sleep-mode': 'urn:miot-spec-v2:property:sleep-mode:00000039',
  'child-lock': 'urn:miot-spec-v2:property:child-lock:00000017',
  'target-temperature-low': 'urn:miot-spec-v2:property:target-temperature-low:00000022',
  'target-temperature-high': 'urn:miot-spec-v2:property:target-temperature-high:00000023',
  'temperature-correction': 'urn:miot-spec-v2:property:temperature-correction:00000024'
};

/* ------------------------------------------------- 每个服务的属性声明顺序
 *
 * 这个顺序就是 **piid 的分配顺序** —— 同一个设备每次构建映射，
 * 同 (siid,piid) 一定对应同一个属性，缓存与重建都稳定。
 */

const SERVICE_PROPS = {
  'switch': ['on'],
  'light': ['on', 'brightness', 'color-temperature', 'color', 'mode'],
  'air-conditioner': ['on', 'target-temperature', 'mode', 'fan-level',
    'vertical-swing', 'horizontal-swing', 'eco-mode', 'sleep-mode', 'child-lock'],
  'heater': ['on', 'target-temperature', 'mode', 'eco-mode', 'child-lock', 'temperature-correction'],
  'thermostat': ['on', 'target-temperature', 'target-temperature-low', 'target-temperature-high',
    'mode', 'eco-mode', 'child-lock', 'temperature-correction'],
  'water-heater': ['on', 'target-temperature', 'mode', 'eco-mode', 'child-lock'],
  'fan': ['on', 'fan-level', 'mode', 'vertical-swing', 'horizontal-swing'],
  'humidifier': ['on', 'target-humidity', 'mode', 'water-level', 'anion', 'child-lock'],
  'dehumidifier': ['on', 'target-humidity', 'mode', 'anion', 'water-level', 'child-lock'],
  'air-purifier': ['on', 'mode', 'fan-level', 'anion'],
  'curtain': ['motor-control', 'current-position', 'target-position'],
  'environment': ['temperature', 'relative-humidity', 'pm2.5-density', 'co2-density',
    'tvoc-density', 'form-aldehyde', 'illumination'],
  'battery': ['battery-level', 'charging-state'],
  'alarm': ['alarm'],
  'device-information': ['name', 'model', 'serial-number', 'firmware-revision'],
  'custom-dp': []
};

/* --------------------------------------------------- 属性默认定义（被设备真实
 * 的 values 覆盖）—— 没写 value-range 的表示"约束未知，留空不猜"。
 */

const PROP_DEFS = {
  'on': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'brightness': { format: 'uint8', access: ['read', 'write'], unit: '%', range: [1, 100, 1] },
  'color-temperature': { format: 'uint16', access: ['read', 'write'], unit: 'K', range: [1700, 6500, 1] },
  'color': { format: 'uint32', access: ['read', 'write'], range: [0, 16777215, 1] },
  'mode': { format: 'uint8', access: ['read', 'write'] },
  'fan-level': { format: 'uint8', access: ['read', 'write'] },
  'target-temperature': { format: 'float', access: ['read', 'write'], unit: '℃', range: [5, 35, 1] },
  'temperature': { format: 'float', access: ['read'], unit: '℃', range: [-40, 125, 0.1] },
  'relative-humidity': { format: 'uint8', access: ['read'], unit: '%', range: [0, 100, 1] },
  'pm2.5-density': { format: 'uint16', access: ['read'], unit: 'μg/m³', range: [0, 999, 1] },
  'co2-density': { format: 'uint16', access: ['read'], unit: 'ppm', range: [0, 5000, 1] },
  'tvoc-density': { format: 'uint16', access: ['read'], unit: 'μg/m³', range: [0, 10000, 1] },
  'form-aldehyde': { format: 'float', access: ['read'], unit: 'mg/m³', range: [0, 10, 0.01] },
  'illumination': { format: 'uint32', access: ['read'], unit: 'lx', range: [0, 100000, 1] },
  'battery-level': { format: 'uint8', access: ['read'], unit: '%', range: [0, 100, 1] },
  'charging-state': {
    format: 'uint8', access: ['read'],
    valueList: [{ value: 0, description: '未充电' }, { value: 1, description: '充电中' },
      { value: 2, description: '已充满' }]
  },
  'alarm': { format: 'bool', access: ['read'], boolLabels: ['正常', '告警'] },
  'motor-control': { format: 'uint8', access: ['read', 'write'] },
  'current-position': { format: 'uint8', access: ['read'], unit: '%', range: [0, 100, 1] },
  'target-position': { format: 'uint8', access: ['read', 'write'], unit: '%', range: [0, 100, 1] },
  'target-humidity': { format: 'uint8', access: ['read', 'write'], unit: '%', range: [0, 100, 1] },
  'water-level': { format: 'uint8', access: ['read'], unit: '%', range: [0, 100, 1] },
  'anion': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'eco-mode': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'sleep-mode': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'child-lock': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'vertical-swing': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'horizontal-swing': { format: 'bool', access: ['read', 'write'], boolLabels: ['关闭', '打开'] },
  'target-temperature-low': { format: 'float', access: ['read', 'write'], unit: '℃', range: [5, 35, 1] },
  'target-temperature-high': { format: 'float', access: ['read', 'write'], unit: '℃', range: [5, 35, 1] },
  'temperature-correction': { format: 'int32', access: ['read', 'write'], unit: '℃', range: [-10, 10, 1] },
  'name': { format: 'string', access: ['read'] },
  'model': { format: 'string', access: ['read'] },
  'serial-number': { format: 'string', access: ['read'] },
  'firmware-revision': { format: 'string', access: ['read'] }
};

/* --------------------------------------------------------------- 枚举标签表
 *
 * 涂鸦 Enum 型的 range 是一串英文小写单词，直接摊给用户可读性差。
 * 这里查一遍常见值给中文标签；查不到就原样显示，不猜。
 */
const ENUM_LABELS = {
  auto: '自动', automatic: '自动', manual: '手动', program: '编程', programing: '编程',
  cool: '制冷', cold: '制冷', heat: '制热', hot: '制热', wind: '送风', dry: '除湿',
  fan: '送风', wet: '除湿', strong: '强劲', normal: '标准', gentle: '柔和', soft: '柔和',
  high: '高', mid: '中', middle: '中', low: '低', mute: '静音', silent: '静音',
  white: '白光', colour: '彩光', color: '彩光', scene: '场景', music: '音乐',
  sleep: '睡眠', eco: '节能', comfort: '舒适', smart: '智能', away: '离家', home: '在家',
  open: '打开', close: '关闭', stop: '暂停', continue: '继续', pause: '暂停',
  on: '开', off: '关', idle: '待机', running: '运行', standby: '待机', charging: '充电中',
  charge: '充电', discharge: '放电', full: '已充满', none: '无', no: '否', yes: '是',
  celsius: '摄氏度', fahrenheit: '华氏度', c: '摄氏度', f: '华氏度',
  position: '位置', zone: '分区', single: '单次', repeat: '重复', daily: '每天',
  monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四',
  friday: '周五', saturday: '周六', sunday: '周日', everyday: '每天',
  forward: '正转', reverse: '反转', left: '左', right: '右', up: '上', down: '下',
  horizontal: '水平', vertical: '垂直', both: '双向', swing: '扫风',
  schedule: '定时', timer: '定时', countdown: '倒计时', inching: '点动',
  charge_only: '仅充电', discharge_only: '仅放电', self_consumption: '自发自用',
  ultra_charge: '极速充电', boost: '强劲', standard: '标准', fast: '快'
};

/** 给一个涂鸦枚举值挑中文标签；查不到原样返回。 */
function enumLabel(value) {
  if (value === null || value === undefined) return '';
  const key = String(value).trim().toLowerCase();
  if (ENUM_LABELS[key] !== undefined) return ENUM_LABELS[key];
  return String(value);
}

/* ------------------------------------------------------------ DP code 规则表
 *
 * 顺序即优先级，**先匹配先赢**。每条规则：
 *   token       → 落到哪个 MIoT 属性（PROP_DEFS 的 key）
 *   svc         → 该属性的"归属服务"（若设备主服务已声明它，则留在主服务）
 *   codes       → 精确 code 名单（小写）
 *   re          → 正则（用于 switch_1..switch_8 这类带序号的）
 *   multi       → 允许同一规则命中多个 DP（各自占一个 piid）
 *   attach      → "附加型"属性：永远跟着设备主服务走，不单独开服务。
 *                 像童锁 / 节能 / 摆风这类，语义上属于"这台设备"而不是
 *                 某个固定品类 —— 硬塞进 thermostat 服务只会让灯上多出
 *                 一个莫名其妙的温控服务。
 *   sensor      → 只读（覆盖 PROP_DEFS 的 access）
 *   divisor     → 固定缩放（否则取设备 values.scale）
 *
 * 规则来源：涂鸦各品类标准功能点命名（对照 tuya-local 1770 个设备定义里
 * 实际出现过的 code 归并），只收"跨厂商稳定"的那批。认不出的走 custom-dp。
 */
const DP_CODE_RULES = [
  /* ── 开关类 ───────────────────────────────────────── */
  { token: 'on', svc: 'switch', multi: true,
    codes: ['switch', 'switch_1', 'switch_led', 'switch_led_1', 'switch_usb1', 'switch_usb2',
      'switch_app', 'switch_socket', 'power', 'power_1', 'on', 'relay', 'relay_1', 'plug',
      'socket', 'valve', 'light', 'smart_switch', 'switch_1_1'],
    re: /^(switch|relay|power|socket|plug|outlet|gang)(_[0-9a-z]+)?$/ },

  /* ── 灯光 ─────────────────────────────────────────── */
  { token: 'brightness', svc: 'light',
    codes: ['bright_value', 'bright_value_v2', 'bright_value_1', 'bright_value_2', 'brightness',
      'bright_percentage', 'std_brightness', 'light_value', 'brightness_value'],
    re: /^bright(_value|ness)(_[0-9a-z]+)?$/ },
  { token: 'color-temperature', svc: 'light',
    codes: ['temp_value', 'temp_value_v2', 'temp_value_1', 'temp_value_2', 'color_temp',
      'colour_temp', 'std_color_temp', 'color_temperature', 'temperature_value'],
    re: /^(temp|colour|color)_(value|temp)(_[0-9a-z]+)?$/ },
  { token: 'color', svc: 'light', codec: 'hsv',
    codes: ['colour_data', 'colour_data_v2', 'colour_data_1', 'colour_data_2', 'color_data',
      'color_data_v2', 'rgbhsv', 'std_rgbhsv', 'colour', 'color', 'rgb', 'rgb_color'],
    re: /^colou?r_(data|r)(_[0-9a-z]+)?$/ },

  /* ── 模式 / 档位 / 风速 ───────────────────────────── */
  { token: 'mode', svc: 'switch', multi: true, attach: true,
    codes: ['mode', 'work_mode', 'operation_mode', 'hvac_mode', 'color_mode', 'colour_mode',
      'dehumidifier_mode', 'air_mode', 'workmode', 'run_mode', 'device_mode'] },
  { token: 'fan-level', svc: 'fan', multi: true,
    codes: ['fan_speed_enum', 'fan_speed', 'fan_level', 'speed', 'wind_speed', 'windspeed',
      'gear', 'fan_speed_1', 'level', 'wind_level', 'fan_speed_value'] },

  /* ── 温度闭环 ─────────────────────────────────────── */
  { token: 'temperature', svc: 'environment', sensor: true, multi: true,
    codes: ['temp_current', 'temp_current_f', 'current_temperature', 'current_temp', 'temp_indoor',
      'temperature', 'va_temperature', 'room_temp', 'room_temperature', 'temp_room',
      'in_room_temperature', 'temperature_current', 'temp_cur', 'temp_f', 'sensor_temp',
      'current_temperature_f', 'internal_temp', 'temp', 'sensor_f', 'temp_now'] },
  { token: 'target-temperature', svc: 'thermostat', multi: true,
    codes: ['temp_set', 'temp_set_f', 'temp_setting', 'target_temperature', 'temperature_set',
      'set_temp', 'target_temp', 'temp_target', 'temperature_target', 'temp_target_set'] },
  { token: 'target-temperature-high', svc: 'thermostat', attach: true,
    codes: ['upper_temp', 'max_temperature', 'temp_top', 'max_temp', 'upper_temperature',
      'target_temp_high', 'max_temperature_f', 'max_temp_f', 'upper_temp_f', 'upper_limit'] },
  { token: 'target-temperature-low', svc: 'thermostat', attach: true,
    codes: ['lower_temp', 'min_temperature', 'temp_bottom', 'min_temp', 'lower_temperature',
      'target_temp_low', 'min_temperature_f', 'min_temp_f', 'lower_temp_f', 'lower_limit'] },
  { token: 'temperature-correction', svc: 'thermostat', attach: true,
    codes: ['temp_correction', 'temp_calibration', 'temperature_correction', 'temp_adjust',
      'temperature_calibration', 'calibration', 'temp_compensation'] },

  /* ── 湿度闭环 ─────────────────────────────────────── */
  { token: 'relative-humidity', svc: 'environment', sensor: true, multi: true,
    codes: ['humidity_value', 'current_humidity', 'humidity', 'va_humidity', 'humidity_indoor',
      'humidity_current', 'rh', 'humidity_now', 'sensor_humidity'] },
  { token: 'target-humidity', svc: 'humidifier', multi: true,
    codes: ['humidity_set', 'humidity_setting', 'target_humidity', 'humidity_target',
      'dehumidify_set_value', 'humidity_value_set', 'humidity_set_value'] },

  /* ── 空气质量 ─────────────────────────────────────── */
  { token: 'pm2.5-density', svc: 'environment', sensor: true,
    codes: ['pm25_value', 'pm25_value_v2', 'pm25', 'pm2p5', 'pm2_5', 'pm2_5_value', 'pm25_value_1'] },
  { token: 'co2-density', svc: 'environment', sensor: true,
    codes: ['co2_value', 'co2', 'carbon_dioxide', 'co2_value_v2', 'co2_state'] },
  { token: 'tvoc-density', svc: 'environment', sensor: true,
    codes: ['tvoc', 'tvoc_value', 'ch2o_value', 'formaldehyde', 'hcho', 'voc', 'voc_value'] },
  { token: 'illumination', svc: 'environment', sensor: true,
    codes: ['illuminance_value', 'illuminance', 'lux', 'brightness_lux', 'light_lux'] },

  /* ── 电池 ─────────────────────────────────────────── */
  { token: 'battery-level', svc: 'battery', sensor: true,
    codes: ['battery_percentage', 'battery', 'battery_capacity', 'residual_electricity',
      'battery_value', 'battery_level', 'battery_power'] },
  { token: 'charging-state', svc: 'battery', sensor: true,
    codes: ['charge_state', 'charging_state', 'charge_status', 'charging_status'] },

  /* ── 告警 / 门磁 / 人体 ───────────────────────────── */
  { token: 'alarm', svc: 'alarm', sensor: true, multi: true,
    codes: ['alarm_state', 'alarm', 'alarm_set_1', 'alarm_set_2', 'alarm_lock', 'alarm_message',
      'alarm_msg', 'siren_state', 'smoke_sensor_state', 'gas_sensor_state', 'watersensor_state',
      'pir', 'doorcontact_state', 'motion', 'flood', 'submersion_state', 'water_alarm',
      'temp_alarm', 'leak', 'contact_state', 'tamper', 'tamper_alarm', 'smoke_state',
      'gas_state', 'smoke_value', 'gas_value'] },

  /* ── 窗帘 / 推窗 ──────────────────────────────────── */
  { token: 'motor-control', svc: 'curtain',
    codes: ['control', 'curtain_control', 'operation', 'motor_control', 'mach_operate'] },
  { token: 'current-position', svc: 'curtain', sensor: true, multi: true,
    codes: ['percent_state', 'position', 'current_position', 'curtain_position', 'percent',
      'position_current', 'curtain_state'] },
  { token: 'target-position', svc: 'curtain',
    codes: ['percent_control', 'position_control', 'target_position', 'curtain_control_value'] },

  /* ── 摆风 / 摇摆 ──────────────────────────────────── */
  { token: 'vertical-swing', svc: 'fan', multi: true, attach: true,
    codes: ['swing', 'swing_v', 'swing_mode', 'windshake', 'swing_vertical', 'vertical_swing',
      'shake', 'up_down'] },
  { token: 'horizontal-swing', svc: 'fan', multi: true, attach: true,
    codes: ['swing_h', 'swing_lr', 'swing_horizontal', 'horizontal_swing', 'windshake_h',
      'shake_h', 'left_right'] },

  /* ── 其他布尔开关 ─────────────────────────────────── */
  { token: 'eco-mode', svc: 'thermostat', attach: true,
    codes: ['eco', 'eco_mode', 'energy_saving', 'save_mode'] },
  { token: 'sleep-mode', svc: 'thermostat', attach: true,
    codes: ['sleep', 'sleep_mode', 'sleep_switch'] },
  { token: 'child-lock', svc: 'thermostat', attach: true,
    codes: ['child_lock', 'key_lock', 'lock_key', 'childlock', 'lock_set', 'child_lock_1'] },
  { token: 'anion', svc: 'air-purifier', attach: true,
    codes: ['anion', 'negative_ion', 'ionizer', 'ion', 'purify', 'uv', 'uvc'] },
  { token: 'water-level', svc: 'humidifier', attach: true, sensor: true,
    codes: ['water_lack', 'waterlevel', 'water_level', 'water_state', 'waterlack', 'no_water'] }
];

/** 把 DP code 归一成小写去空格，规则表按这个匹配。 */
function normDpCode(code) {
  return String(code === undefined || code === null ? '' : code).trim().toLowerCase();
}

/** 给一个 DP code 找规则；找不到返回 null。 */
function findDpRule(code) {
  const k = normDpCode(code);
  if (!k) return null;
  for (let i = 0; i < DP_CODE_RULES.length; i++) {
    const r = DP_CODE_RULES[i];
    if (r.codes) {
      for (let j = 0; j < r.codes.length; j++) {
        if (r.codes[j] === k) return r;
      }
    }
    if (r.re && r.re.test(k)) return r;
  }
  return null;
}

/* ------------------------------------------------------- 品类 → 主服务 / 模板
 *
 * 主服务决定 siid=2 是什么（"这个设备主要是个什么东西"）。
 * 涂鸦品类码是官方的，但**谁都可能记岔**，所以这里只当"提示"用：
 * 真正权威的是云 spec 返回的 category，认不出就退到 switch。
 */
const CATEGORY_INFO = {
  kg: { svc: 'switch', device: 'switch', label: '开关' },
  cz: { svc: 'switch', device: 'outlet', label: '插座' },
  pc: { svc: 'switch', device: 'outlet', label: '排插' },
  zndb: { svc: 'switch', device: 'outlet', label: '计量插座' },
  dj: { svc: 'light', device: 'light', label: '灯具' },
  dd: { svc: 'light', device: 'light', label: '灯带' },
  xdd: { svc: 'light', device: 'light', label: '吸顶灯' },
  tgq: { svc: 'light', device: 'light', label: '投光灯' },
  fwd: { svc: 'light', device: 'light', label: '氛围灯' },
  dc: { svc: 'light', device: 'light', label: '灯串' },
  gd: { svc: 'light', device: 'light', label: '轨道灯' },
  wk: { svc: 'thermostat', device: 'thermostat', label: '温控器' },
  qn: { svc: 'heater', device: 'heater', label: '取暖器' },
  rs: { svc: 'water-heater', device: 'water-heater', label: '热水器' },
  kt: { svc: 'air-conditioner', device: 'air-conditioner', label: '空调' },
  ntq: { svc: 'thermostat', device: 'thermostat', label: '暖通温控' },
  cl: { svc: 'curtain', device: 'curtain', label: '窗帘' },
  fs: { svc: 'fan', device: 'fan', label: '风扇' },
  js: { svc: 'humidifier', device: 'humidifier', label: '加湿器' },
  cs: { svc: 'dehumidifier', device: 'dehumidifier', label: '除湿机' },
  kj: { svc: 'air-purifier', device: 'air-purifier', label: '空气净化器' },
  wsdcg: { svc: 'environment', device: 'temperature-humidity-sensor', label: '温湿度传感器' },
  rqbj: { svc: 'alarm', device: 'gas-detector', label: '燃气报警器' },
  ywbj: { svc: 'alarm', device: 'smoke-detector', label: '烟雾报警器' },
  jwbj: { svc: 'alarm', device: 'submersion-sensor', label: '水浸报警器' },
  sgbj: { svc: 'alarm', device: 'siren', label: '声光报警器' },
  pir: { svc: 'alarm', device: 'motion-sensor', label: '人体感应器' },
  mcs: { svc: 'alarm', device: 'contact-sensor', label: '门窗传感器' },
  ms: { svc: 'switch', device: 'lock', label: '门锁' },
  sd: { svc: 'switch', device: 'vacuum', label: '扫地机器人' },
  cwwsq: { svc: 'switch', device: 'pet-feeder', label: '宠物喂食器' },
  evcharger: { svc: 'switch', device: 'ev-charger', label: '充电桩' }
};

/**
 * 品类参考模板：**只在完全没有云端 spec、也没读到 DP_QUERY 时**用来铺一个
 * 能用的面板。数字 id 按涂鸦该品类的标准布局写，跨厂商大体一致但不保证 ——
 * 所以它是最后的兜底，不是主路径。
 */
const CATEGORY_TEMPLATES = {
  kg: { dps: [{ id: 1, code: 'switch_1', type: 'Boolean' },
    { id: 9, code: 'countdown_1', type: 'Integer', values: { unit: 's', min: 0, max: 86400, scale: 0, step: 1 } }] },
  cz: { dps: [{ id: 1, code: 'switch_1', type: 'Boolean' },
    { id: 9, code: 'countdown_1', type: 'Integer', values: { unit: 's', min: 0, max: 86400, scale: 0, step: 1 } },
    { id: 17, code: 'cur_current', type: 'Integer', values: { unit: 'mA', min: 0, max: 30000, scale: 0, step: 1 } },
    { id: 18, code: 'cur_power', type: 'Integer', values: { unit: 'W', min: 0, max: 50000, scale: 1, step: 1 } },
    { id: 19, code: 'cur_voltage', type: 'Integer', values: { unit: 'V', min: 0, max: 5000, scale: 1, step: 1 } }] },
  pc: { dps: [{ id: 1, code: 'switch_1', type: 'Boolean' }, { id: 2, code: 'switch_2', type: 'Boolean' },
    { id: 3, code: 'switch_3', type: 'Boolean' }, { id: 4, code: 'switch_4', type: 'Boolean' },
    { id: 101, code: 'cur_power', type: 'Integer', values: { unit: 'W', min: 0, max: 50000, scale: 1, step: 1 } }] },
  dj: { dps: [{ id: 1, code: 'switch_led', type: 'Boolean' },
    { id: 2, code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene', 'music'] } },
    { id: 3, code: 'bright_value', type: 'Integer', values: { min: 10, max: 1000, scale: 0, step: 1 } },
    { id: 4, code: 'temp_value', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
    { id: 5, code: 'colour_data', type: 'Json', values: {} },
    { id: 7, code: 'countdown_1', type: 'Integer', values: { unit: 's', min: 0, max: 86400, scale: 0, step: 1 } }] },
  dd: { dps: [{ id: 1, code: 'switch_led', type: 'Boolean' },
    { id: 2, code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene', 'music'] } },
    { id: 3, code: 'bright_value', type: 'Integer', values: { min: 10, max: 1000, scale: 0, step: 1 } },
    { id: 4, code: 'temp_value', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
    { id: 5, code: 'colour_data', type: 'Json', values: {} }] },
  xdd: { dps: [{ id: 1, code: 'switch_led', type: 'Boolean' },
    { id: 2, code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene', 'music'] } },
    { id: 3, code: 'bright_value', type: 'Integer', values: { min: 10, max: 1000, scale: 0, step: 1 } },
    { id: 4, code: 'temp_value', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
    { id: 5, code: 'colour_data', type: 'Json', values: {} }] },
  wk: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'temp_set', type: 'Integer', values: { unit: '℃', min: 5, max: 35, scale: 0, step: 1 } },
    { id: 3, code: 'temp_current', type: 'Integer', values: { unit: '℃', min: -10, max: 50, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['manual', 'auto'] } }] },
  qn: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'temp_set', type: 'Integer', values: { unit: '℃', min: 5, max: 35, scale: 0, step: 1 } },
    { id: 3, code: 'temp_current', type: 'Integer', values: { unit: '℃', min: -10, max: 50, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['manual', 'auto', 'eco'] } }] },
  rs: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'temp_set', type: 'Integer', values: { unit: '℃', min: 30, max: 75, scale: 0, step: 1 } },
    { id: 3, code: 'temp_current', type: 'Integer', values: { unit: '℃', min: 0, max: 99, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['manual', 'auto'] } }] },
  kt: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'temp_set', type: 'Integer', values: { unit: '℃', min: 16, max: 30, scale: 0, step: 1 } },
    { id: 3, code: 'temp_current', type: 'Integer', values: { unit: '℃', min: -10, max: 50, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['auto', 'cold', 'hot', 'wind', 'wet'] } },
    { id: 5, code: 'fan_speed_enum', type: 'Enum', values: { range: ['auto', 'low', 'mid', 'high'] } }] },
  cl: { dps: [{ id: 1, code: 'control', type: 'Enum', values: { range: ['open', 'stop', 'close', 'continue'] } },
    { id: 2, code: 'percent_control', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 3, code: 'percent_state', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  fs: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'fan_speed_enum', type: 'Enum', values: { range: ['low', 'mid', 'high'] } },
    { id: 3, code: 'mode', type: 'Enum', values: { range: ['normal', 'sleep', 'natural'] } },
    { id: 4, code: 'oscillate', type: 'Boolean' }] },
  js: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'humidity_set', type: 'Integer', values: { unit: '%', min: 30, max: 80, scale: 0, step: 1 } },
    { id: 3, code: 'current_humidity', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['auto', 'manual'] } }] },
  cs: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'dehumidify_set_value', type: 'Integer', values: { unit: '%', min: 30, max: 80, scale: 0, step: 1 } },
    { id: 3, code: 'current_humidity', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 4, code: 'mode', type: 'Enum', values: { range: ['auto', 'manual', 'continuous'] } }] },
  kj: { dps: [{ id: 1, code: 'switch', type: 'Boolean' },
    { id: 2, code: 'mode', type: 'Enum', values: { range: ['auto', 'manual', 'sleep'] } },
    { id: 3, code: 'fan_speed_enum', type: 'Enum', values: { range: ['auto', 'low', 'mid', 'high'] } },
    { id: 4, code: 'pm25_value', type: 'Integer', values: { unit: 'μg/m³', min: 0, max: 999, scale: 0, step: 1 } }] },
  wsdcg: { dps: [{ id: 1, code: 'va_temperature', type: 'Integer', values: { unit: '℃', min: -20, max: 80, scale: 1, step: 1 } },
    { id: 2, code: 'va_humidity', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 3, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  mcs: { dps: [{ id: 1, code: 'doorcontact_state', type: 'Boolean' },
    { id: 2, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  pir: { dps: [{ id: 1, code: 'pir', type: 'Enum', values: { range: ['pir', 'none'] } },
    { id: 2, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  jwbj: { dps: [{ id: 1, code: 'watersensor_state', type: 'Enum', values: { range: ['alarm', 'normal'] } },
    { id: 3, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  ywbj: { dps: [{ id: 1, code: 'smoke_sensor_state', type: 'Enum', values: { range: ['alarm', 'normal'] } },
    { id: 10, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  rqbj: { dps: [{ id: 1, code: 'gas_sensor_state', type: 'Enum', values: { range: ['alarm', 'normal'] } },
    { id: 4, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  ms: { dps: [{ id: 8, code: 'alarm_lock', type: 'Enum', values: { range: ['wrong_password', 'normal'] } },
    { id: 9, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } }] },
  sd: { dps: [{ id: 1, code: 'power_go', type: 'Boolean' },
    { id: 2, code: 'mode', type: 'Enum', values: { range: ['smart', 'zone', 'pose', 'part', 'control'] } },
    { id: 5, code: 'battery_percentage', type: 'Integer', values: { unit: '%', min: 0, max: 100, scale: 0, step: 1 } },
    { id: 8, code: 'fault', type: 'Bitfield', values: {} }] }
};

/** 取品类的提示信息；认不出给个中性默认。 */
function categoryInfo(category) {
  const key = normDpCode(category);
  if (CATEGORY_INFO[key]) return CATEGORY_INFO[key];
  return { svc: 'switch', device: 'switch', label: key ? key : '设备' };
}

/* ------------------------------------------------------------ 值域解析工具 */

/** 把云 spec 的 values（字符串或对象）解析成对象；坏数据不抛错。 */
function parseDpValues(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return {};
  try {
    const o = JSON.parse(text);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    return {};
  }
}

/** 10 的 n 次幂，涂鸦的 scale 是「小数点位数」。 */
function pow10(n) {
  let r = 1;
  for (let i = 0; i < n; i++) r *= 10;
  return r;
}

/**
 * 把涂鸦的 (type, values) 翻成 MIoT 的 format / 约束 / 值转换器。
 *
 * 返回 { format, range, valueList, divisor, enumValues, unit, access }
 *   divisor    非 1 时表示"设备值 = MIoT 值 × divisor"
 *   enumValues 非空时表示"MIoT 索引 ↔ 涂鸦字符串"，要经 translate
 */
function describeDpType(type, values) {
  const t = String(type || '').trim().toLowerCase();
  const v = values || {};
  const out = { format: 'string', range: null, valueList: null, divisor: 1, enumValues: null, unit: '', access: null };

  if (v.unit) out.unit = String(v.unit);

  if (t === 'boolean' || t === 'bool') {
    out.format = 'bool';
    return out;
  }

  if (t === 'enum') {
    const range = isArray(v.range) ? v.range : [];
    out.format = 'uint8';
    out.enumValues = range.map(function (s) { return String(s); });
    out.valueList = out.enumValues.map(function (s, i) {
      return { value: i, description: enumLabel(s) };
    });
    if (out.valueList.length === 0) out.valueList = null;
    return out;
  }

  if (t === 'integer' || t === 'value' || t === 'number') {
    const scale = Number(v.scale || 0);
    const divisor = scale > 0 ? pow10(scale) : 1;
    const hasMin = (v.min !== undefined && v.min !== null && v.min !== '');
    const hasMax = (v.max !== undefined && v.max !== null && v.max !== '');
    const min = hasMin ? Number(v.min) : null;
    const max = hasMax ? Number(v.max) : null;
    const step = (v.step !== undefined && v.step !== null && v.step !== '') ? Number(v.step) : 1;

    out.divisor = divisor;
    if (divisor > 1) {
      out.format = 'float';
    } else if (min !== null && min < 0) {
      out.format = 'int32';
    } else if (max !== null && max <= 255) {
      out.format = 'uint8';
    } else if (max !== null && max <= 65535) {
      out.format = 'uint16';
    } else {
      out.format = 'uint32';
    }
    if (min !== null && max !== null) {
      out.range = [min / divisor, max / divisor, step / divisor];
    }
    return out;
  }

  // String / Json / Raw / Bitfield 一律按字符串透传 —— 这类值（IR 码、
  // 场景数据、bitfield 故障字）本来就没有可用的数值语义，硬转只会失真。
  out.format = 'string';
  return out;
}

/* ------------------------------------------------------- HSV 颜色编解码
 *
 * 灯光品类里彩光 DP 有两种历史格式，都得认：
 *   v1 `colour_data`     —— 12 个 hex 字符：hhhh ssss vvvv（h 0-360 / s,v 0-1000）
 *   v2 `colour_data_v2`  —— JSON 字符串 {"h":0-360,"s":0-1000,"v":0-1000}
 * MIoT 侧统一用 uint32 的 0xRRGGBB，所以两个方向都要转。
 */

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n) || 0);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** HSV（h 0-360 / s 0-1000 / v 0-1000）→ 0xRRGGBB */
function hsvToRgbInt(h, s, v) {
  const hh = ((Number(h) || 0) % 360 + 360) % 360;
  const ss = clampInt(s, 0, 1000) / 1000;
  const vv = clampInt(v, 0, 1000) / 1000;
  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) { r = c; g = x; }
  else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; }
  else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const R = clampInt((r + m) * 255, 0, 255);
  const G = clampInt((g + m) * 255, 0, 255);
  const B = clampInt((b + m) * 255, 0, 255);
  return (R << 16) | (G << 8) | B;
}

/** 0xRRGGBB → {h 0-360, s 0-1000, v 0-1000} */
function rgbIntToHsv(rgb) {
  const n = clampInt(rgb, 0, 0xffffff);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h: Math.round(h), s: Math.round(s * 1000), v: Math.round(max * 1000) };
}

/**
 * 涂鸦彩光值 → 0xRRGGBB。
 * 认不出来（空串、格式怪）返回 null —— 调用方据此把属性留空，
 * **不要**编一个默认颜色出来，那会让用户以为设备是那个颜色。
 */
function decodeTuyaColor(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return clampInt(raw, 0, 0xffffff);
  const text = String(raw).trim();
  if (!text) return null;
  if (text.charAt(0) === '{') {
    try {
      const o = JSON.parse(text);
      return hsvToRgbInt(o.h, o.s, o.v);
    } catch (e) {
      return null;
    }
  }
  if (/^[0-9a-fA-F]{12}$/.test(text)) {
    return hsvToRgbInt(parseInt(text.substring(0, 4), 16),
      parseInt(text.substring(4, 8), 16), parseInt(text.substring(8, 12), 16));
  }
  if (/^[0-9a-fA-F]{6}$/.test(text)) {
    return parseInt(text, 16);
  }
  return null;
}

/** 0xRRGGBB → 涂鸦彩光值。kind = 'json' | 'hex'（默认 hex）。 */
function encodeTuyaColor(rgb, kind) {
  const hsv = rgbIntToHsv(rgb);
  if (kind === 'json') {
    return JSON.stringify({ h: hsv.h, s: hsv.s, v: hsv.v });
  }
  function pad4(n) {
    let s = clampInt(n, 0, 0xffff).toString(16);
    while (s.length < 4) s = '0' + s;
    return s;
  }
  return pad4(hsv.h) + pad4(hsv.s) + pad4(hsv.v);
}

/* ============================================================ 映射构建核心 */

/**
 * 构建一台设备的 (siid,piid) ⇄ DP 映射表。
 *
 * 输入是一串「功能点声明」：
 *   { code, dpId, type, values }   ← 云 spec 或品类模板
 *   dpId 允许为空（老版云接口不给 dp id）—— 那时只能靠 code 寻址，
 *   局域网 ≤3.3 的固件会写不进去，日志里会说明（见 50-plugin.js）。
 *
 * 输出：
 *   {
 *     category, primarySvc, deviceToken,
 *     spec,                 // 直接交给宿主 getSpecForDevice 的 instance JSON
 *     entries: [...],       // 映射明细，getProperties/setProperty 都查它
 *     bySiidPiid: {2:{1:entry}},
 *     byCode: {switch_1: entry},
 *     byDpId: {'1': entry}
 *   }
 */
function buildMapping(category, functions) {
  const info = categoryInfo(category);
  const primarySvc = info.svc;
  const list = isArray(functions) ? functions : [];

  // ① 每个 DP 找规则，定 token，并决定它落在哪个服务
  const picked = [];
  const usedTokens = {};   // svc -> { token: true }（非 multi 的 token 只收一次）
  for (let i = 0; i < list.length; i++) {
    const fn = list[i] || {};
    const code = normDpCode(fn.code);
    if (!code) continue;
    const rule = findDpRule(code);
    if (!rule) continue;
    const groupKey = rule.svc + '|' + rule.token;
    // 非 multi 的属性，同一个服务里只收第一个
    if (!rule.multi && usedTokens[groupKey]) continue;
    usedTokens[groupKey] = true;
    picked.push({ fn: fn, code: code, rule: rule, token: rule.token });
  }

  // ② 决定每个 token 住哪个服务：主服务声明过（或规则标了 attach）就留主服务，
  //    否则去规则指定的那个专属性服务（环境 / 电池 / 告警 / 窗帘……）
  const declaredPrimary = SERVICE_PROPS[primarySvc] || [];
  for (let i = 0; i < picked.length; i++) {
    const p = picked[i];
    const staysHome = p.rule.attach || declaredPrimary.indexOf(p.token) >= 0;
    p.svc = staysHome ? primarySvc : p.rule.svc;
  }

  // ③ 分配 piid：按 SERVICE_PROPS 的声明顺序走，声明外的（multi 扩展）追加在后
  const svcOrder = [];
  function ensureSvc(svc) {
    if (svcOrder.indexOf(svc) < 0) svcOrder.push(svc);
  }
  ensureSvc(primarySvc);
  for (let i = 0; i < picked.length; i++) ensureSvc(picked[i].svc);

  const entries = [];
  for (let s = 0; s < svcOrder.length; s++) {
    const svc = svcOrder[s];
    const declared = SERVICE_PROPS[svc] || [];
    const mine = [];
    for (let i = 0; i < picked.length; i++) {
      if (picked[i].svc === svc) mine.push(picked[i]);
    }
    // 先按声明顺序塞
    let piid = 0;
    for (let d = 0; d < declared.length; d++) {
      for (let i = 0; i < mine.length; i++) {
        if (mine[i].token === declared[d]) {
          piid += 1;
          entries.push(makeEntry(mine[i], svc, piid));
        }
      }
    }
    // 声明顺序之外的同 token 重复项（switch_2 / fan_level_2 ...）继续往后排
    for (let i = 0; i < mine.length; i++) {
      const m = mine[i];
      if (declared.indexOf(m.token) >= 0) continue;
      piid += 1;
      entries.push(makeEntry(m, svc, piid));
    }
  }

  // ④ 规则表没认出来的 DP → custom-dp 服务，功能不丢
  const custom = [];
  let customPiid = 0;
  for (let i = 0; i < list.length; i++) {
    const fn = list[i] || {};
    const code = normDpCode(fn.code);
    if (!code) continue;
    if (findDpRule(code)) continue;
    if (custom.length >= 48) break;   // 上限：面板别被几十个裸 DP 淹掉
    custom.push(fn);
  }
  for (let i = 0; i < custom.length; i++) {
    customPiid += 1;
    entries.push(makeCustomEntry(custom[i], customPiid));
  }

  // ⑤ 组装 spec
  const spec = assembleSpec(info, primarySvc, svcOrder, entries, custom);

  const bySiidPiid = {};
  const byCode = {};
  const byDpId = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!bySiidPiid[e.siid]) bySiidPiid[e.siid] = {};
    bySiidPiid[e.siid][e.piid] = e;
    if (e.code) byCode[e.code] = e;
    if (e.dpId !== null && e.dpId !== undefined) byDpId[String(e.dpId)] = e;
  }

  return {
    category: normDpCode(category),
    primarySvc: primarySvc,
    deviceToken: info.device,
    label: info.label,
    spec: spec,
    entries: entries,
    bySiidPiid: bySiidPiid,
    byCode: byCode,
    byDpId: byDpId
  };
}

/** 把一条 (dp, rule) 落成映射条目。 */
function makeEntry(picked, svc, piid) {
  const fn = picked.fn || {};
  const rule = picked.rule;
  const token = picked.token;
  const values = parseDpValues(fn.values);
  const desc = describeDpType(fn.type, values);
  const def = PROP_DEFS[token] || { format: 'string', access: ['read', 'write'] };

  // 设备的真实类型能压过默认；但布尔/枚举这类语义一旦设备给了就信设备
  const format = desc.format !== 'string' || !def.format ? desc.format : def.format;

  let range = desc.range || (def.range ? def.range.slice() : null);
  let valueList = desc.valueList || null;
  let divisor = desc.divisor !== undefined ? desc.divisor : 1;
  if (rule.divisor) divisor = rule.divisor;

  const access = rule.sensor ? ['read']
    : (def.access ? def.access.slice() : ['read', 'write']);

  // 布尔属性补上 关闭/打开 的 value-list（MIoT 惯例）
  if (format === 'bool' && !valueList) {
    const labels = def.boolLabels || ['关闭', '打开'];
    valueList = [{ value: false, description: labels[0] }, { value: true, description: labels[1] }];
  }

  return {
    siid: 0,             // 由 assembleSpec 回填，便于集中管理
    svc: svc,
    piid: piid,
    code: normDpCode(fn.code),
    dpId: (fn.dpId === undefined || fn.dpId === null || fn.dpId === '') ? null : Number(fn.dpId),
    token: token,
    format: format,
    access: access,
    range: range,
    valueList: valueList,
    divisor: divisor,
    enumValues: desc.enumValues,
    unit: desc.unit || def.unit || '',
    codec: rule.codec || null,
    colorKind: rule.codec === 'hsv' ? 'hex' : null,
    desc: PROP_LABELS[token] || token
  };
}

/** 认不出的 DP → custom-dp 服务里的一个属性。 */
function makeCustomEntry(fn, piid) {
  const code = normDpCode(fn.code);
  const values = parseDpValues(fn.values);
  const desc = describeDpType(fn.type, values);
  const isState = /(_state|_status|fault|_life|_record|_total|_report|_info|check|error)/.test(code);

  let format = desc.format;
  let range = desc.range;
  let valueList = desc.valueList;
  if (format === 'bool' && !valueList) {
    valueList = [{ value: false, description: '关闭' }, { value: true, description: '打开' }];
  }
  // 数值但没给约束：退成字符串透传，比瞎猜一个范围安全
  if ((format === 'uint8' || format === 'uint16' || format === 'uint32' || format === 'int32')
    && !range && !valueList) {
    format = 'uint32';
  }

  return {
    siid: 0,
    svc: 'custom-dp',
    piid: piid,
    code: code,
    dpId: (fn.dpId === undefined || fn.dpId === null || fn.dpId === '') ? null : Number(fn.dpId),
    token: 'dp-' + code.replace(/[^0-9a-z]+/g, '-'),
    format: format,
    access: isState ? ['read'] : ['read', 'write'],
    range: range,
    valueList: valueList,
    divisor: desc.divisor !== undefined ? desc.divisor : 1,
    enumValues: desc.enumValues,
    unit: desc.unit || '',
    codec: null,
    colorKind: null,
    desc: code,
    custom: true
  };
}

/** 属性 token → 中文名，用于 spec 里的 description。 */
const PROP_LABELS = {
  'on': '开关', 'brightness': '亮度', 'color-temperature': '色温', 'color': '颜色',
  'mode': '模式', 'fan-level': '风速', 'target-temperature': '目标温度',
  'temperature': '当前温度', 'relative-humidity': '当前湿度', 'pm2.5-density': 'PM2.5',
  'co2-density': 'CO₂ 浓度', 'tvoc-density': 'TVOC', 'form-aldehyde': '甲醛',
  'illumination': '光照度', 'battery-level': '电量', 'charging-state': '充电状态',
  'alarm': '告警', 'motor-control': '开合控制', 'current-position': '当前位置',
  'target-position': '目标位置', 'target-humidity': '目标湿度', 'water-level': '水位',
  'anion': '负离子', 'eco-mode': '节能模式', 'sleep-mode': '睡眠模式', 'child-lock': '童锁',
  'vertical-swing': '上下摆风', 'horizontal-swing': '左右摆风',
  'target-temperature-low': '温度下限', 'target-temperature-high': '温度上限',
  'temperature-correction': '温度校准',
  'name': '设备名称', 'model': '型号', 'serial-number': '序列号', 'firmware-revision': '固件版本'
};

/** 拼出最终给宿主的 instance JSON。 */
function assembleSpec(info, primarySvc, svcOrder, entries, customDps) {
  const bySvc = {};
  function bucket(svc) {
    if (!bySvc[svc]) bySvc[svc] = [];
    return bySvc[svc];
  }
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].custom) continue;
    bucket(entries[i].svc).push(entries[i]);
  }

  // siid 编号：1 固定给 device-information，2 给主服务，其余按出现顺序 3、4……
  const siidOf = { 'device-information': 1 };
  let next = 2;
  siidOf[primarySvc] = next;
  next += 1;
  for (let i = 0; i < svcOrder.length; i++) {
    const svc = svcOrder[i];
    if (siidOf[svc] === undefined) {
      siidOf[svc] = next;
      next += 1;
    }
  }
  if (customDps.length > 0 && siidOf['custom-dp'] === undefined) {
    siidOf['custom-dp'] = next;
    next += 1;
  }

  // 回填 siid 到条目上，后面 getProperties/setProperty 直接用
  for (let i = 0; i < entries.length; i++) {
    entries[i].siid = siidOf[entries[i].svc];
  }

  const services = [];

  // siid 1：设备信息（只读，宿主普遍会读它显示型号/固件）
  const infoProps = [];
  const infoTokens = ['name', 'model', 'serial-number', 'firmware-revision'];
  for (let i = 0; i < infoTokens.length; i++) {
    const t = infoTokens[i];
    const d = PROP_DEFS[t];
    infoProps.push({
      iid: i + 1,
      type: MIOT_PROPS[t],
      description: PROP_LABELS[t] || t,
      format: d.format,
      access: ['read']
    });
  }
  services.push({
    iid: 1,
    type: MIOT_SERVICES['device-information'].urn,
    description: MIOT_SERVICES['device-information'].desc,
    properties: infoProps,
    actions: []
  });

  // 主服务 + 其余有属性的服务
  const orderedSvcs = [primarySvc];
  for (let i = 0; i < svcOrder.length; i++) {
    if (orderedSvcs.indexOf(svcOrder[i]) < 0) orderedSvcs.push(svcOrder[i]);
  }
  for (let s = 0; s < orderedSvcs.length; s++) {
    const svc = orderedSvcs[s];
    const list = bySvc[svc] || [];
    if (list.length === 0) continue;
    const meta = MIOT_SERVICES[svc] || MIOT_SERVICES['switch'];
    const props = [];
    for (let i = 0; i < list.length; i++) {
      props.push(toSpecProperty(list[i]));
    }
    services.push({
      iid: siidOf[svc],
      type: meta.urn,
      description: meta.desc,
      properties: props,
      actions: []
    });
  }

  // custom-dp 服务：认不出的功能点，保证控制不丢
  if (customDps.length > 0) {
    const props = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].custom) props.push(toSpecProperty(entries[i]));
    }
    if (props.length > 0) {
      services.push({
        iid: siidOf['custom-dp'],
        type: MIOT_SERVICES['custom-dp'].urn,
        description: MIOT_SERVICES['custom-dp'].desc,
        properties: props,
        actions: []
      });
    }
  }

  return {
    type: 'urn:miot-spec-v2:device:' + info.device + ':0000A001:tuya:1',
    description: 'Tuya ' + (info.label || '设备'),
    services: services
  };
}

/** 映射条目 → spec 里的 property 对象（kebab-case，宿主 parser 吃这个形状）。 */
function toSpecProperty(e) {
  const p = {
    iid: e.piid,
    type: MIOT_PROPS[e.token] || ('urn:miot-spec-v2:property:' + e.token + ':000000FF'),
    description: e.desc || e.token,
    format: e.format,
    access: e.access
  };
  if (e.range && (e.format === 'uint8' || e.format === 'uint16' || e.format === 'uint32'
    || e.format === 'int32' || e.format === 'float')) {
    p['value-range'] = e.range;
  }
  if (e.valueList && e.valueList.length > 0) {
    p['value-list'] = e.valueList;
  }
  if (e.unit) p.unit = e.unit;
  return p;
}

/* --------------------------------------------------- 从各种来源铺「功能点声明」 */

/**
 * 云 spec（/iot-03/.../specification）→ 功能点声明数组。
 * 该接口的 functions 有时不带 dp_id，这里两种形状都收。
 */
function functionsFromCloudSpec(result) {
  const out = [];
  if (!result) return out;
  const groups = ['functions', 'status'];
  for (let g = 0; g < groups.length; g++) {
    const arr = result[groups[g]];
    if (!isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i] || {};
      if (!it.code) continue;
      out.push({
        code: it.code,
        dpId: (it.dp_id !== undefined && it.dp_id !== null) ? it.dp_id
          : ((it.dpId !== undefined && it.dpId !== null) ? it.dpId : null),
        type: it.type,
        values: it.values
      });
    }
  }
  return out;
}

/**
 * 局域网 DP_QUERY 的回包（{ "1": true, "2": 235, ... }，键是 dp id）
 * → 功能点声明。类型从值的 JS 类型反推。
 *
 * ⚠️ 这时**不知道 code**，所以只能造 `dp_1` 这种名字 —— 规则表当然认不出，
 * 结果全进 custom-dp。这是"没有云 spec 的纯手动局域网"路线的必然降级，
 * 功能能读能写，只是名字不好看。有云凭据时优先走云 spec。
 */
function functionsFromDps(dps, category) {
  const out = [];
  if (!dps || typeof dps !== 'object') return out;
  const tpl = CATEGORY_TEMPLATES[normDpCode(category)];
  const tplById = {};
  if (tpl && isArray(tpl.dps)) {
    for (let i = 0; i < tpl.dps.length; i++) tplById[String(tpl.dps[i].id)] = tpl.dps[i];
  }
  const keys = Object.keys(dps);
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    const v = dps[id];
    // 品类模板能对上号就用模板的 code/类型 —— 这样规则表才有机会认出它
    if (tplById[id]) {
      out.push({
        code: tplById[id].code,
        dpId: Number(id),
        type: tplById[id].type,
        values: tplById[id].values || {}
      });
      continue;
    }
    let type = 'String';
    let values = {};
    if (typeof v === 'boolean') type = 'Boolean';
    else if (typeof v === 'number') type = 'Integer';
    else if (typeof v === 'string' && v.charAt(0) === '{') type = 'Json';
    out.push({ code: 'dp_' + id, dpId: Number(id), type: type, values: values });
  }
  return out;
}

/** 纯手动局域网、连 DP_QUERY 都还没跑过 → 品类参考模板。 */
function functionsFromTemplate(category) {
  const tpl = CATEGORY_TEMPLATES[normDpCode(category)];
  if (!tpl || !isArray(tpl.dps)) return [];
  const out = [];
  for (let i = 0; i < tpl.dps.length; i++) {
    const d = tpl.dps[i];
    out.push({ code: d.code, dpId: d.id, type: d.type, values: d.values || {} });
  }
  return out;
}

/* ------------------------------------------------------------ 值转换（双向） */

/**
 * 设备原始值 → 给宿主的 MIoT 值。
 * 顺序：bool 原样 → 枚举索引 → 颜色 → 缩放。
 */
function dpValueToMiot(e, raw) {
  if (raw === undefined || raw === null) return undefined;

  if (e.enumValues && e.enumValues.length > 0) {
    // 枚举：既可能是字符串（Tuya Enum），也可能是模板里的 0/1 数字
    if (typeof raw === 'number') {
      return (raw >= 0 && raw < e.enumValues.length) ? raw : raw;
    }
    const idx = e.enumValues.indexOf(String(raw));
    if (idx >= 0) return idx;
    // 认不出的枚举值：返回 undefined，让宿主显示"未知"而不是错位的档位
    return undefined;
  }

  if (e.codec === 'hsv') {
    const rgb = decodeTuyaColor(raw);
    if (rgb === null) return undefined;
    return rgb;
  }

  if (e.format === 'bool') return !!raw;

  if (typeof raw === 'number' && e.divisor && e.divisor !== 1) {
    return raw / e.divisor;
  }

  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    // 字符串型数值（少数固件把数值 DP 发成字符串）
    if (e.format !== 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
      const n = Number(raw);
      return (e.divisor && e.divisor !== 1) ? n / e.divisor : n;
    }
    return raw;
  }
  return raw;
}

/**
 * 宿主要写的 MIoT 值 → 设备原始值。
 * 转换不了就直接把原值丢过去（让设备自己判），但**不吞错**。
 */
function miotValueToDp(e, value) {
  if (e.enumValues && e.enumValues.length > 0) {
    if (typeof value === 'number') {
      const idx = clampInt(value, 0, e.enumValues.length - 1);
      const s = e.enumValues[idx];
      // 涂鸦枚举基本是字符串；模板里写的数字枚举才回数字
      if (/^-?\d+$/.test(s) && e.format !== 'string') return Number(s);
      return s;
    }
    const asStr = String(value);
    if (e.enumValues.indexOf(asStr) >= 0) return asStr;
    return value;
  }

  if (e.codec === 'hsv') {
    const rgb = (typeof value === 'number') ? value : decodeTuyaColor(value);
    if (rgb === null) return value;
    return encodeTuyaColor(rgb, e.colorKind === 'json' ? 'json' : 'hex');
  }

  if (e.format === 'bool') {
    if (typeof value === 'string') return value === 'true' || value === '1';
    return !!value;
  }

  if (typeof value === 'number' && e.divisor && e.divisor !== 1) {
    return Math.round(value * e.divisor);
  }

  if (e.format !== 'string' && typeof value === 'string') {
    const n = Number(value);
    if (!isNaN(n)) {
      return (e.divisor && e.divisor !== 1) ? Math.round(n * e.divisor) : n;
    }
  }
  return value;
}

/* ---------------------------------------------------------------- 缓存与查询 */

const MAPPING_CACHE = {};

function cacheMapping(did, mapping) {
  MAPPING_CACHE[String(did)] = mapping;
  return mapping;
}

function cachedMapping(did) {
  return MAPPING_CACHE[String(did)] || null;
}

function dropMapping(did) {
  delete MAPPING_CACHE[String(did)];
}

function clearMappingCache() {
  const keys = Object.keys(MAPPING_CACHE);
  for (let i = 0; i < keys.length; i++) delete MAPPING_CACHE[keys[i]];
}

/** 按 (siid, piid) 找映射条目；找不到返回 null。 */
function findEntry(mapping, siid, piid) {
  if (!mapping) return null;
  const row = mapping.bySiidPiid[String(siid)] || mapping.bySiidPiid[Number(siid)];
  if (!row) return null;
  return row[String(piid)] || row[Number(piid)] || null;
}

/** 按 dp code 找映射条目。 */
function findEntryByCode(mapping, code) {
  if (!mapping) return null;
  return mapping.byCode[normDpCode(code)] || null;
}

/** 按 dp id 找映射条目。 */
function findEntryByDpId(mapping, dpId) {
  if (!mapping) return null;
  return mapping.byDpId[String(dpId)] || null;
}

/**
 * 下发时 dps 对象用什么做键。
 *
 * 有 dp 编号就用编号（所有版本都认）；没有就只能用 code 字符串赌一把 ——
 * 那条路要求固件 ≥3.4 且认字符串键。是否允许赌由 `isEntryAddressable` 判断。
 */
function dpPayloadKey(entry) {
  if (entry.dpId !== null && entry.dpId !== undefined) return String(entry.dpId);
  return entry.code;
}

/** 这个条目能不能在给定协议版本下寻址（用于提前告诉用户"写不进去"）。 */
function isEntryAddressable(entry, version) {
  if (entry.dpId !== null && entry.dpId !== undefined) return true;
  const v = Number(version || 0);
  return v >= 3.4;
}
