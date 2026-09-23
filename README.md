# miha 涂鸦插件（Tuya Local）

> ## ⚠️ 免责声明
>
> **由DeepSeek V4.1 Flash根据SKILLs直接生成，未经测试，仅供参考**
>
> 这份代码是按 miha（羊绒家居 / HarmonyOS）插件的开发规范与协议文档，
> 对照 `tuya-local` 集成与 `tinytuya` 的协议实现移植出来的，**没有在任何真实
> 涂鸦设备上跑过**。加解密、报文帧、云端签名这些**能离线比对**的部分都做了
> 字节级交叉验证（见下文「测试」），但「装到机器上点开关能不能真的亮灯」
> 这件事没法在没有硬件的情况下证明。请自行评估风险后再使用。
>
> 协议与签名算法来自公开资料与开源实现的反推，不保证与所有固件版本一致。
> 设备固件升级、涂鸦改协议都可能让这里失效。

---

## 这是什么

把涂鸦（Tuya）设备接进 miha 的一个 JS 插件。它有两条链路：

| 链路 | 靠什么 | 什么时候用 |
| --- | --- | --- |
| **局域网直控** | 设备 ID + localKey + IP + 协议版本，走 TCP 6668 的涂鸦私有协议 | 首选。快、不烧云配额、断网也能用（只要在同一个局域网） |
| **云 OpenAPI 增强** | 涂鸦 IoT 平台的 Access ID / Access Secret | ① 自动拉设备列表和 `local_key`，省去手抄 ② 设备不在同一网段时的兜底 |

两条链路可以只用一条，也可以一起用（局域网优先，云端兜底）。

设备能力描述走 miha 的 MIoT 模型：涂鸦的功能点（DP）会被翻译成
`siid` / `piid` 属性，这样宿主的详情页、控制面板能直接复用。

---

## 安装

### 方式一：用打好的包（推荐）

1. 到 [Releases](https://github.com/MrCashmere/miha_tuya_plugin/releases) 下载
   `tuya-local-1.0.0.zip`
2. 在 miha 里用「从文件导入」装上

如果 Releases 里还没有资产，仓库根目录也放了一份同名的 zip，可以直接粘直链：

```
https://github.com/MrCashmere/miha_tuya_plugin/raw/main/tuya-local-1.0.0.zip
```

包里的结构是 `plugin.json` + `main.js`（**根目录下直接是这两个文件**，
没有多套一层目录）。

### 方式二：从源码构建

```bash
git clone https://github.com/MrCashmere/miha_tuya_plugin.git
cd miha_tuya_plugin
node tools/build.js      # src/*.js → main.js（宿主要求单文件）
node tools/package.js    # → dist/tuya-local-1.0.0.zip
```

只需要 Node，**没有任何第三方依赖**。

---

## 配置

登录面板是一张表（`login.type = "form"`）。因为宿主不支持「按开关显示/隐藏字段」，
两种模式的字段都摆在上面，填完按 `useCloud` 取用对应的一半。

### 纯局域网模式

把「使用涂鸦云 OpenAPI」开关**关掉**，然后在「局域网设备」里一行一台：

```
设备ID,localKey,IP[,协议版本][,名称]
```

例如：

```
bf1234567890abcdef,0123456789abcdef,192.168.1.50,3.3,客厅灯
```

- `设备ID`：涂鸦 App 里设备详情能看到（也叫 Device ID / 虚拟 ID）
- `localKey`：**必须是 16 个字符**。老固件用涂鸦 App 本地缓存或
  `tinytuya wizard` 之类工具取；新固件（协议 ≥3.4）的密钥是每次会话协商的，
  这个字段填的是"真实密钥"，填错会连不上
- `协议版本`：`3.1` / `3.3` / `3.4` / `3.5`（写 `33` 也认）。**不填也能跑** ——
  插件会先靠 UDP 广播发现（发现报文里带版本），再不行就按 3.3 → 3.4 → 3.5 逐个试。
  但填对了会快很多
- `名称` 可省（省了就用设备 ID 当名字）
- 多台用**分号**隔开，或者换行

### 云 OpenAPI 模式

把开关**打开**，填：

| 字段 | 说明 |
| --- | --- |
| 云 Access ID | 涂鸦 IoT 平台的 Access ID / Client ID |
| 云 Access Secret | 对应的密钥。**只存在本机**（`Host.secureStore`），不上传 |
| 数据中心 | `cn` / `us` / `eu` / `in`，或直接填完整域名 |

点「保存并连接」时插件会**真发一次换 token 的请求**来校验凭据 ——
与其让用户以为登录成功、进列表发现一台设备都没有，不如当场报错。

云模式下「局域网设备」栏**依然可以填**，作用是：用手填的 `IP` / `协议版本`
覆盖云端拿到的值（云端**不返回协议版本**，所以想走局域网直连，
要么靠广播发现，要么手填版本）。

### 默认品类码（可选）

看不懂设备品类时（纯局域网模式、云端也没返回 category），可以填一个品类码
让插件套用**参考模板**。常用值：

`dj` 灯具 · `kg` 开关 · `cz` 插座 · `wk` 温控器 · `qn` 取暖器 · `rs` 热水器 ·
`kt` 空调 · `cl` 窗帘 · `fs` 风扇 · `js` 加湿器 · `cs` 除湿机 · `kj` 空气净化器 ·
`wsdcg` 温湿度传感器 · `mcs` 门窗磁 · `pir` 人体感应 · `sd` 扫地机

> ⚠️ 参考模板里的 DP 编号是按涂鸦各品类的**通用布局**写的，跨厂商大体一致但
> **不保证**。只有实在拿不到云端 spec、也读不到设备状态时才会用到它。

---

## 它是怎么把涂鸦 DP 翻译的

一台设备的映射表从三个来源里挑**最可靠的那个**来建：

```
① 云端 specification  →  语义化的 code（switch_1 / bright_value / temp_set），最准
② 局域网 DP_QUERY     →  拿得到 dp 编号和当前值，但没有 code —— 借品类模板对号
③ 品类参考模板         →  完全离线时的兜底，编号是"大概率"而非"保证"
```

三条都拿不到时**抛错**，而不是给一个空 spec。空 spec 会让用户看到一个
没有任何控件的详情页，还查不出原因。

映射规则是一张静态表（`src/40-mapping.js` 的 `DP_CODE_RULES`），覆盖涂鸦各品类
最常见的那批 code：`switch_1` / `switch_led` / `bright_value` / `temp_value` /
`colour_data` / `work_mode` / `fan_speed_enum` / `temp_set` / `temp_current` /
`percent_control` / `battery_percentage` / `alarm_state` …… 一百多条。

下游据此组装：

| 规则表认出来了 | 落进哪个服务 | 例子 |
| --- | --- | --- |
| 主功能 | `siid 2`（品类决定是 switch / light / air-conditioner / …） | `switch_1` → `on` |
| 附加型（童锁、摆风、节能…） | 跟着主服务走 | `child_lock` → `child-lock` |
| 环境量 | `environment` 服务 | `temp_current` → `temperature` |
| 电量 | `battery` 服务 | `battery_percentage` → `battery-level` |
| 告警 | `alarm` 服务 | `doorcontact_state` → `alarm` |
| **认不出来的** | `custom-dp` 服务 | `countdown_1` → `dp-countdown-1` |

最后那条是关键：**认不出的功能点也不丢**，会作为只读/可写的属性出现在
「其他功能点」服务里，能读能写，只是名字不好看。

值域也做双向转换：

- `scale=1` 的整数温度 → `float` 且自动除 10（`235` ⇄ `23.5 ℃`）
- `Enum` 的字符串选项 → `uint8` + `value-list`（下标 ↔ 字符串），
  顺带把 `auto` / `cool` / `heat` 这类值翻成中文标签
- 彩光 DP → `uint32` 的 0xRRGGBB，涂鸦的 v1（12 位 hex）和 v2（JSON）两种格式都认

---

## 已知限制（请务必读一遍）

1. **没有真机验证过。** 见开头的免责声明。
2. **不还原家庭 / 房间层级。** 涂鸦云的 homes/rooms 接口对不同账号开放程度不一样，
   猜出来的层级只会让用户看到"设备跑错房间"。所有设备统一收进一个「涂鸦设备」家庭。
3. **子设备（网关下的 Zigbee 设备）没有网关归属。** 设备列表接口不带 `parent_id`，
   子设备会当作独立设备显示。
4. **摄像头取流没实现**（`capabilities.stream = false`）。也没有场景、历史统计、
   消息、耗材、网关管理。
5. **没有协议动作。** 涂鸦的数据模型里只有功能点。`callAction` 会直接抛错
   解释原因，生成的 spec 里 `actions` 恒为空数组。
6. **局域网写入需要 dp 编号。** 云端的 specification 接口**不一定**返回 `dp_id`
   （因账号和接口版本而异）。拿不到编号时，写入只能靠 `code` 字符串寻址，
   而这要求固件 **≥3.4**。不满足时插件会明确报错，让用户改用云端通道。
   读属性不受这个限制。
7. **彩光是近似转换。** 标准 HSV ↔ RGB，和涂鸦 App 里的取色器可能略有差异。
8. **品类参考模板的 DP 编号是"通用布局"。** 不同厂商的同品类设备编号可能不同，
   模板只保证"铺一个能用的面板"，不保证每个功能都对。
9. **每次读写都新建 TCP 连接。** 这么做是为了避开 ArkWeb 重建后的陈旧 socket
   （重建后回调注册表会清空），代价是高频轮询时效率一般。
10. **局域网发现依赖 UDP 广播**，部分路由器 / AP 隔离会把它吞掉。发现失败不影响
    手填 IP 和云端 IP 两条路。
11. **加解密是纯 JS 实现**（鸿蒙的系统加密库不含 RC4，也不直接暴露 AES-ECB/GCM
    的裸接口，所以 AES、SHA-256、HMAC、MD5 都在 JS 里手写了）。涂鸦报文很小，
    理论上性能无碍，但**没有实测过**。
12. **涂鸦云 token 有效期约 2 小时**，靠请求层的「token 失效自动重试」续期。

---

## 目录结构

```
.
├── plugin.json          # 清单：权限、能力声明、登录方式
├── main.js              # 构建产物（由 src/ 拼接，可读但别直接改）
├── src/                 # 源码，按文件名排序拼接
│   ├── 00-util.js       #   通用工具（跨 realm 安全的 isArray 等）
│   ├── 10-crypto.js     #   MD5 / SHA-256 / HMAC-SHA256 / AES-128 / AES-GCM / CRC32
│   ├── 20-lan.js        #   涂鸦局域网协议：帧编解码、会话协商、UDP 发现
│   ├── 30-cloud.js      #   涂鸦云 OpenAPI：签名、token、设备/状态/命令
│   ├── 40-mapping.js    #   DP ⇄ MIoT 映射层
│   └── 50-plugin.js     #   插件入口：Plugin.register 的全部钩子
├── tools/
│   ├── build.js         # 拼接 + 语法检查 + 铁律检查
│   ├── package.js       # 手写 ZIP（store 模式，产物可复现）
│   ├── test_crypto.js   # 加解密标准测试向量
│   ├── test_frames.js   # 协议帧与 tinytuya 逐字节比对
│   ├── test_cloud.js    # 云签名与官方 SDK 比对
│   ├── test_mapping.js  # 映射层契约与双向值转换
│   ├── test_plugin.js   # 插件契约（钩子、字段名、权限清单一致性）
│   ├── gen_expected_frames.py  # 用 tinytuya 生成帧测试向量
│   └── gen_expected_cloud.py   # 用 tuya-connector-python 生成签名向量
└── dist/                # 打包产物
```

**为什么要拼接？** miha 宿主只读取 `plugin.json` 里 `entry` 指向的**那一个文件**，
把内容原样包进 IIFE 执行。所以 `import` / `export` 会直接语法错误，
拆出去的文件也永远不会被加载。唯一可行的多文件方案就是构建期拼接 ——
所有函数共享同一个闭包作用域，可以互相直接调用。

---

## 测试

```bash
node tools/build.js --check   # 语法 + 铁律检查
node tools/test_crypto.js     # 22 项
node tools/test_frames.js     # 21 项
node tools/test_cloud.js      # 12 项
node tools/test_mapping.js    # 84 项
node tools/test_plugin.js     # 95 项
```

**共 234 项，全绿。**

没有真机，所以「协议实现对不对」这件事是靠**和参考实现逐字节比对**来保证的：

| 测试 | 比什么 | 参照物 |
| --- | --- | --- |
| `test_crypto` | MD5 / SHA-256 / HMAC-SHA256 / AES-128-ECB / AES-GCM 的输入输出 | RFC 1321、FIPS 180-4、NIST 标准测试向量 |
| `test_frames` | 帧编码结果、解码回读、粘包重组、会话密钥推导、UDP 探测包 | **tinytuya 1.20.0** 的 `crypto_helper` / `message_helper` / `udp_helper` |
| `test_cloud` | 请求签名、路径与 query 拼接、endpoint 解析 | **tuya-connector-python** 的 `TuyaOpenAPI._calculate_sign` |

生成向量需要 Python 环境：

```bash
pip install tinytuya==1.20.0 tuya-connector-python
python tools/gen_expected_frames.py tools/expected_frames.json
python tools/gen_expected_cloud.py  tools/expected_cloud.json
```

> 这两个参考实现**只用来生成"标准答案"**，不会被打进插件，也不在运行期依赖。

`test_mapping` 和 `test_plugin` 不需要外部参照物 —— 它们验的是**契约**：
产出的 spec 是不是宿主吃的那种形状、字段名有没有写成驼峰、写失败有没有抛错、
用到的 `Host.*` 有没有都在 `permissions` 里声明。

这个交叉验证确实抓到过东西，比如：

- 6699 帧头是 **18 字节**（`>IHIII`）而不是 20 —— 少算 2 字节会导致 GCM 的 AAD 错位
- v3.3 的版本头是 **15 字节**（`"3.3"` + 12 个 0x00）而不是 16
- v3.4 的尾部是 **32 字节 HMAC** 而不是 4 字节 CRC
- 55AA 帧里校验和的位置：签的是 `frame[0 : bodyEnd-tailLen]`，比对的是
  `frame[bodyEnd-tailLen : bodyEnd-4]`

---

## 协议实现说明

| 项目 | 内容 |
| --- | --- |
| TCP 端口 | 6668 |
| UDP 发现端口 | 7000（新版）、6666 / 6667（老设备） |
| 帧格式 | `55AA`：前缀(4) + seqno(4) + cmd(4) + 长度(4) + 载荷 + 校验 + 后缀(4) |
| 帧格式 | `6699`：u16 + seqno(4) + cmd(4) + 长度(4) + 载荷 + 后缀(4)（用于 UDP 发现） |
| 协议 3.1/3.2/3.3 | AES-128-ECB + PKCS#7；版本头在密文**外面** |
| 协议 3.4 | AES-128-ECB + 会话密钥 + 尾部 HMAC-SHA256；版本头在密文**里面** |
| 协议 3.5 | AES-128-**GCM**（6699 帧） |
| 会话密钥 | AES(realKey, localNonce XOR remoteNonce)：3.4 用 ECB 不补位，3.5 走 GCM 取密文 `[12:28]` |
| UDP 发现密钥 | 公开的 `md5("yGAdlopoPVldABfn")` |
| 云签名 | HMAC-SHA256，**毫秒**时间戳，query 按 key 排序，大写十六进制 |

---

## 参考与致谢

- [make-all/tuya-local](https://github.com/make-all/tuya-local) — HA 集成，本插件的移植来源；
  1770 个设备定义是品类映射规则的重要参考
- [jasonacox/tinytuya](https://github.com/jasonacox/tinytuya) — 局域网协议的权威参考实现，
  本项目用它生成帧测试向量
- [tuya/tuya-connector-python](https://github.com/tuya/tuya-connector-python) — 官方云 SDK，
  用于生成签名测试向量
- miha 插件开发指南与 `miha-plugin-dev` skill — 插件契约、Host 桥、十条铁律

---

## License

[MIT](LICENSE)
