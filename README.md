# miha 涂鸦插件（Tuya Local）

> ## ⚠️ 免责声明
>
> **由DeepSeek V4.1 Flash根据SKILLs直接生成，未经测试，仅供参考**
>
> 这份代码是按 miha（羊绒家居 / HarmonyOS）插件的开发规范与协议文档，
> 对照 `tuya-local` 集成、`tinytuya` 与涂鸦官方 SDK 移植出来的，**没有在任何真实
> 涂鸦设备上跑过**。加解密、报文帧、二维码、云端签名这些**能离线比对**的部分
> 都做了字节级交叉验证（见下文「测试」，406 项全绿），但有两件事没法在没有硬件、
> 没有真实账号的情况下证明：
>
> 1. 「装到机器上点开关能不能真的亮灯」
> 2. **扫码登录的首次「两步」交互**（先填用户码、再点一次出二维码）——
>    它依赖宿主对登录视图的渲染方式，见「已知限制」第 2 条
>
> 请自行评估风险后再使用。协议与签名算法来自公开资料与开源实现的反推，
> 不保证与所有固件版本一致。设备固件升级、涂鸦改协议都可能让这里失效。

---

## 这是什么

把涂鸦（Tuya）设备接进 miha 的一个 JS 插件。它有三条接入路径：

| 路径 | 靠什么 | 什么时候用 |
| --- | --- | --- |
| **扫码登录**（手机端 API） | 涂鸦智能 / 智能生活 App 扫一下二维码 | **推荐**。一次拿到设备列表、`local_key`、IP、家庭与房间层级、功能点与语义名的对应关系，**没有配额限制** |
| **局域网直控** | 设备 ID + localKey + IP + 协议版本，走 TCP 6668 的涂鸦私有协议 | 零云依赖、最快、断网也能用（只要在同一个局域网） |
| **云 OpenAPI**（**已弃用**） | 涂鸦 IoT 平台的 Access ID / Access Secret | 仅为兼容存量凭据保留，见下方说明 |

设备控制优先走**局域网**（快、不烧云配额），不通时回落到**云端通道**。

设备能力描述走 miha 的 MIoT 模型：涂鸦的功能点（DP）会被翻译成
`siid` / `piid` 属性，这样宿主的详情页、控制面板能直接复用。

> ### 为什么弃用云 OpenAPI 这条路
>
> 它和上面那条是**两套完全不同的接口**。涂鸦的开放平台（`/v1.0/iot-03/...`）
> **只给 1 个月试用期**，且试用版最多 50 台设备、只能控制其中 10 台，
> 过期后所有接口一律返回 `28841002`。
>
> 而 HA 官方集成与 `tuya-local` 这条线用的都是**账号扫码 + 手机端接口**
> （`/v1.0/m/life/...`，`client_id = HA_3y9q4ak7g4ephrvke`、`schema = haauthorize`，
> 这两个是涂鸦官方发给 HA 的），没有这些限制。
> 本插件 v1.1.0 起以扫码为主路径，OpenAPI 那条只为已存凭据保留（不再提供填写入口）。

---

## 安装

### 方式一：用打好的包（推荐）

1. 到 [Releases](https://github.com/MrCashmere/miha_tuya_plugin/releases) 下载
   `tuya-local-1.1.0.zip`
2. 在 miha 里用「从文件导入」装上

如果 Releases 里还没有资产，仓库根目录也放了一份同名的 zip，可以直接粘直链：

```
https://github.com/MrCashmere/miha_tuya_plugin/raw/main/tuya-local-1.1.0.zip
```

包里的结构是 `plugin.json` + `main.js`（**根目录下直接是这两个文件**，
没有多套一层目录）。

### 方式二：从源码构建

```bash
git clone https://github.com/MrCashmere/miha_tuya_plugin.git
cd miha_tuya_plugin
node tools/build.js      # src/*.js → main.js（宿主要求单文件）
node tools/package.js    # → dist/tuya-local-1.1.0.zip
```

只需要 Node，**没有任何第三方依赖**。

---

## 配置

### 扫码登录（推荐）

点卡片上的「登录」。

**第一次**会先看到一个只填「用户码」的表单 —— 这是涂鸦的硬性要求，绕不过去：

> 涂鸦 App → **我的** → 右上角 **⚙️ 齿轮** → **账号与安全** → 拉到底部的 **用户码**

用户码是**账号级常量**（跟设备无关），服务端在建二维码时就校验它：
留空或填错都会返回 `USERCODE_INCORRECT`（实测）。所以插件必须先拿到它，
而宿主的二维码视图**放不下输入框** —— 于是首次登录分两步：

1. 填用户码 → 点提交（插件会真发一次请求校验，错了当场告诉你）
2. **再点一次「登录」** → 直接出二维码，之后就永远是一步到位

第 1 步提交后那条提示写的是「用户码已校验通过 ✓ 请再点一次…」，
**它是进度提示不是报错** —— 协议里 `loginSubmit` 只能回一个状态，
没有"下一步给你看二维码"这种通道。详见文末「已知限制」第 2 条。

之后用**涂鸦智能 / 智能生活** App 右上角的「扫一扫」扫屏幕上的二维码并确认即可。
二维码 3 分钟内有效，过期就再点一次「登录」。

**这一步是本地生成的**（`src/05-qr.js` 是手写的 QR 编码器 + PNG 编码器），
登录令牌不会被发给任何第三方二维码服务。

登录成功后会自动拉取：设备列表、`local_key`、IP、**家庭 / 房间层级**、
以及每个功能点的 DP 编号与语义名对应关系。

### 纯局域网模式（不用涂鸦账号）

同一个用户码表单里，「局域网设备」栏填一行一台：

```
设备ID,localKey,IP[,协议版本][,名称]
```

例如：

```
bf1234567890abcdef,0123456789abcdef,192.168.1.50,3.3,客厅灯
```

**用户码留空 + 至少填一台设备**，提交后会直接进本地模式。

- `设备ID`：涂鸦 App 里设备详情能看到（也叫 Device ID / 虚拟 ID）
- `localKey`：**必须是 16 个字符**。老固件用涂鸦 App 本地缓存或
  `tinytuya wizard` 之类工具取；新固件（协议 ≥3.4）的密钥是每次会话协商的，
  这个字段填的是"真实密钥"，填错会连不上
- `协议版本`：`3.1` / `3.3` / `3.4` / `3.5`（写 `33` 也认）。**不填也能跑** ——
  插件会先靠 UDP 广播发现（发现报文里带版本），再不行就按 3.3 → 3.4 → 3.5 逐个试。
  但填对了会快很多
- `名称` 可省（省了就用设备 ID 当名字）
- 多台用**分号**隔开，或者换行

**手填设备与扫码结果是并存的**，同 did 时手填的 `IP` / `localKey` / 协议版本
会覆盖云端的值（云端**不返回协议版本**，所以想走局域网直连，要么靠广播发现，
要么手填版本）。再登录一次不会把手填的冲掉。

### 云 OpenAPI 模式（**已弃用**）

这条路只为**已经存过** Access ID / Access Secret 的凭据保留，登录面板上
**不再提供填写入口**。仍在用的凭据会照常工作：

| 字段 | 说明 |
| --- | --- |
| 云 Access ID | 涂鸦 IoT 平台的 Access ID / Client ID |
| 云 Access Secret | 对应的密钥。**只存在本机**（`Host.secureStore`），不上传 |
| 数据中心 | `cn` / `us` / `eu` / `in`，或直接填完整域名 |

原有逻辑不变：换 token 时**真发一次请求**校验凭据；云模式下「局域网设备」栏
**依然可以填**，用手填的 `IP` / `协议版本` 覆盖云端拿到的值
（云端**不返回协议版本**，所以想走局域网直连，要么靠广播发现，要么手填版本）。

> ⚠️ 前提是那条凭据没到期。开放平台试用版**只有 1 个月**，
> 到期后所有接口返回 `28841002` —— 遇到这个错，就是该改用扫码登录了。

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
                         扫码模式下还会把 DP 关系表里的 dp 编号一并合进来
② 局域网 DP_QUERY     →  拿得到 dp 编号和当前值，但没有 code —— 借品类模板对号
③ 品类参考模板         →  完全离线时的兜底，编号是"大概率"而非"保证"
```

> **扫码登录那条路拿到的是一份"最全的 spec"**：手机端接口除了
> `/v1.1/m/life/{did}/specifications`（给 code / 类型 / 值域），还能查
> `/v1.0/m/life/devices/{did}/status` 拿到 `dpStatusRelationDTOS` ——
> **dpId ↔ statusCode 的直接对应**。开放平台那份 specification 不一定给 `dp_id`，
> 而局域网写又恰恰需要数字编号，所以这一份的价值很高（见「已知限制」第 8 条）。

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
2. **扫码登录的「首次两步」没在真机上走过。** `login.type` 声明的是 `qr`，
   但**第一次** `loginBegin` 返回的是一个 `form` 视图（收用户码）。
   按宿主文档，`login.type` 只决定"卡片上有没有登录按钮"、真正渲染看 `view.type`，
   所以这是合法的；但这条交互**没有真机验证过**。如果真机上首次看不到那个表单，
   请提 issue —— 那是宿主按声明类型渲染而非按视图渲染，需要换一种实现方式。
3. **家庭 / 房间层级只在扫码模式下还原。** 手机端接口（`/v1.0/m/life/users/homes`
   + `/v1.0/m/life/ha/home/devices` + `/v1.0/m/thing/ha/{did}/room`）能拿到真实层级；
   OpenAPI 与纯局域网拿不到，会统一收进一个「涂鸦设备」家庭。
   房间是"一台设备一次请求"的接口，所以结果按 did 缓存、并发拉（上限 6）。
4. **换涂鸦账号需要先清掉插件数据。** 用户码存下来之后，再点「登录」就直接出二维码了，
   没有回到输入框的入口（协议里没有登出钩子，也没有"重新输入"这种视图切换）。
   想换账号目前只能卸载插件重装、或清掉它的本地数据。
   另外"已登录时提交空用户码"**不会**把账号降级成本地模式 ——
   那种"只想补一台手填设备"的操作太常见，丢登录的代价比"意外保留"大得多。
5. **子设备（网关下的 Zigbee 设备）没有网关归属。** 手机端设备记录只有
   `sub`（是否子设备）没有 `parent_id`，子设备会当作独立设备显示。
6. **摄像头取流没实现**（`capabilities.stream = false`）。也没有场景、历史统计、
   消息、耗材、网关管理。
7. **没有协议动作。** 涂鸦的数据模型里只有功能点。`callAction` 会直接抛错
   解释原因，生成的 spec 里 `actions` 恒为空数组。
8. **局域网写入需要 dp 编号。** 扫码模式下能从 `dpStatusRelationDTOS` 拿到，
   所以这条基本不构成障碍；但 OpenAPI 那份 specification 不一定给 `dp_id`。
   拿不到编号时写入只能靠 `code` 字符串寻址，而这要求固件 **≥3.4**；不满足时
   插件会明确报错，让用户改用云端通道。读属性不受这个限制。
9. **轮询间隔 ≥ 2s。** 这是涂鸦官方对扫码登录的要求（写小了会被风控），
   所以扫码确认后到界面上出现设备，最多有 2 秒延迟。
10. **彩光是近似转换。** 标准 HSV ↔ RGB，和涂鸦 App 里的取色器可能略有差异。
11. **品类参考模板的 DP 编号是"通用布局"。** 不同厂商的同品类设备编号可能不同，
    模板只保证"铺一个能用的面板"，不保证每个功能都对。
12. **每次读写都新建 TCP 连接。** 这么做是为了避开 ArkWeb 重建后的陈旧 socket
    （重建后回调注册表会清空），代价是高频轮询时效率一般。
13. **局域网发现依赖 UDP 广播**，部分路由器 / AP 隔离会把它吞掉。发现失败不影响
    手填 IP 和云端 IP 两条路。
14. **加解密与二维码都是纯 JS 实现**（鸿蒙的系统加密库不含 RC4，也不直接暴露
    AES-ECB/GCM 的裸接口，所以 AES、SHA-256、HMAC、MD5 都在 JS 里手写了；
    二维码编码器也是从零写的）。涂鸦报文很小，理论上性能无碍，但**没有实测过**。
    二维码的**正确性**是硬验证过的：160 组矩阵与 Python `qrcode` 逐位比对，
    生成的 PNG 再用 OpenCV 真解码一遍。
15. **涂鸦云 token 有效期约 2 小时**，靠请求层的「提前 60 秒静默刷新」续期。

---

## 目录结构

```
.
├── plugin.json          # 清单：权限、能力声明、登录方式
├── main.js              # 构建产物（由 src/ 拼接，可读但别直接改）
├── src/                 # 源码，按文件名排序拼接
│   ├── 00-util.js       #   通用工具（跨 realm 安全的 isArray 等）
│   ├── 05-qr.js         #   纯 JS 二维码编码器（ISO/IEC 18004）+ 最小 PNG 编码器
│   ├── 10-crypto.js     #   MD5 / SHA-256 / HMAC-SHA256 / AES-128 / AES-GCM / CRC32
│   ├── 20-lan.js        #   涂鸦局域网协议：帧编解码、会话协商、UDP 发现
│   ├── 30-cloud.js      #   涂鸦云 OpenAPI（已弃用，仅兼容存量凭据）
│   ├── 35-mobile.js     #   涂鸦手机端 API：扫码登录、家庭/房间、DP 关系表、命令
│   ├── 40-mapping.js    #   DP ⇄ MIoT 映射层
│   └── 50-plugin.js     #   插件入口：Plugin.register 的全部钩子
├── tools/
│   ├── build.js                # 拼接 + 语法检查 + 铁律检查
│   ├── package.js              # 手写 ZIP（store 模式，产物可复现）
│   ├── test_crypto.js          # 加解密标准测试向量
│   ├── test_frames.js          # 协议帧与 tinytuya 逐字节比对
│   ├── test_qr.js              # 二维码矩阵与 Python qrcode 逐位比对
│   ├── test_mobile.js          # 手机端签名/加密与官方 SDK 逐字段比对
│   ├── test_cloud.js           # 云签名与官方 SDK 比对
│   ├── test_mapping.js         # 映射层契约与双向值转换
│   ├── test_plugin.js          # 插件契约（钩子、字段名、登录全流程、权限清单一致性）
│   ├── gen_expected_frames.py  # 用 tinytuya 生成帧测试向量
│   ├── gen_expected_cloud.py   # 用 tuya-connector-python 生成签名向量
│   ├── gen_expected_qr.py      # 用 Python qrcode 生成 160 组二维码矩阵
│   ├── gen_expected_mobile.py  # 用 tuya-device-sharing-sdk 生成手机端向量
│   └── check_qr_png.py         # 用 Pillow + OpenCV 真解码生成的二维码 PNG
└── dist/                # 打包产物
```

**为什么要拼接？** miha 宿主只读取 `plugin.json` 里 `entry` 指向的**那一个文件**，
把内容原样包进 IIFE 执行。所以 `import` / `export` 会直接语法错误，
拆出去的文件也永远不会被加载。唯一可行的多文件方案就是构建期拼接 ——
所有函数共享同一个闭包作用域，可以互相直接调用。

---

## 测试

```bash
npm test                      # 跑下面全部
node tools/build.js --check   # 语法 + 铁律检查
node tools/test_crypto.js     # 22 项
node tools/test_frames.js     # 21 项
node tools/test_qr.js         # 73 项
node tools/test_mobile.js     # 56 项
node tools/test_cloud.js      # 12 项
node tools/test_mapping.js    # 84 项
node tools/test_plugin.js     # 138 项（含扫码登录全流程）
```

**共 406 项，全绿。**

没有真机，所以「协议实现对不对」这件事是靠**和参考实现逐字节比对**来保证的：

| 测试 | 比什么 | 参照物 |
| --- | --- | --- |
| `test_crypto` | MD5 / SHA-256 / HMAC-SHA256 / AES-128-ECB / AES-GCM 的输入输出 | RFC 1321、FIPS 180-4、NIST 标准测试向量 |
| `test_frames` | 帧编码结果、解码回读、粘包重组、会话密钥推导、UDP 探测包 | **tinytuya 1.20.0** 的 `crypto_helper` / `message_helper` / `udp_helper` |
| `test_qr` | 160 组二维码矩阵（EC-M/Q × 版本 1–10 × 8 种掩码）逐位比对，外加自动掩码选择与边界用例 | **Python `qrcode`** 库；生成的 PNG 再用 **OpenCV `QRCodeDetector`** 真解码一次 |
| `test_mobile` | hashKey / secret 派生、AES-GCM 密文、X-sign 签名串、二维码请求 URL | **tuya-device-sharing-sdk 0.2.15**（涂鸦官方维护、HA 主线在用） |
| `test_cloud` | 请求签名、路径与 query 拼接、endpoint 解析 | **tuya-connector-python** 的 `TuyaOpenAPI._calculate_sign` |

生成向量需要 Python 环境：

```bash
pip install tinytuya==1.20.0 tuya-connector-python qrcode pillow opencv-python
pip install tuya-device-sharing-sdk==0.2.15
python tools/gen_expected_frames.py tools/expected_frames.json
python tools/gen_expected_cloud.py  tools/expected_cloud.json
python tools/gen_expected_qr.py     tools/expected_qr.json
python tools/gen_expected_mobile.py tools/expected_mobile.json
python tools/check_qr_png.py        tools/qr_selftest.png   # 端到端解码验证
```

> 这些参考实现**只用来生成"标准答案"**，不会被打进插件，也不在运行期依赖。

`test_mapping` 和 `test_plugin` 不需要外部参照物 —— 它们验的是**契约**：
产出的 spec 是不是宿主吃的那种形状、字段名有没有写成驼峰、写失败有没有抛错、
用到的 `Host.*` 有没有都在 `permissions` 里声明、扫码登录的四个钩子
（`loginBegin` / `loginSubmit` / `loginPoll` / `loginCancel`）在各种输入下的返回值。

`test_plugin` 用一个**按 URL 分派的网络替身**把云链路也覆盖了
（登录成功、家庭/房间、设备字段、spec 形状、云端读写），
不需要真账号、也不发真实请求。

这个交叉验证确实抓到过东西，比如：

- 6699 帧头是 **18 字节**（`>IHIII`）而不是 20 —— 少算 2 字节会导致 GCM 的 AAD 错位
- v3.3 的版本头是 **15 字节**（`"3.3"` + 12 个 0x00）而不是 16
- v3.4 的尾部是 **32 字节 HMAC** 而不是 4 字节 CRC
- 55AA 帧里校验和的位置：签的是 `frame[0 : bodyEnd-tailLen]`，比对的是
  `frame[bodyEnd-tailLen : bodyEnd-4]`
- 二维码的**格式信息位写反了行/列**（写成 `(row,col)` 而标准是 `(col,row)`）——
  160 组用例整齐地在第 8 列全挂，一眼看出是系统性错位而不是随机 bug
- 手机端请求的**紧凑 JSON 没有转义非 ASCII**（Python `json.dumps` 默认
  `ensure_ascii=True`，会把中文写成 `\uXXXX`）—— 密文因此对不上
- 生成测试向量时忘了把随机 nonce 钉住，导致密文不可复现 —— 这种"测试自己不稳定"
  的问题只能靠逐字段比对暴露

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
| OpenAPI 签名 | HMAC-SHA256，**毫秒**时间戳，query 按 key 排序，大写十六进制（**已弃用**） |
| 扫码登录网关 | `https://apigw.iotbing.com`，`client_id = HA_3y9q4ak7g4ephrvke`，`schema = haauthorize` |
| 二维码内容 | `tuyaSmart--qrLogin?token=<token>`（涂鸦 App 私有格式，不是 URL） |
| 二维码有效期 | 3 分钟；轮询间隔 **≥ 2 秒**（官方要求） |
| 手机端签名 | `hashKey = md5(rid + refreshToken)`；`secret = hmacSha256(rid, hashKey).hex[:16]` |
| 手机端加密 | 参数与 body 各自 `AES-GCM(secret, 12 字节随机 nonce)` → `base64(nonce) + base64(密文+tag)` 拼成一个 `encdata` |
| 手机端签名头 | `x-sign = hmacSha256(hashKey, "X-appKey=..||X-requestId=..||X-sid=..||X-time=..||X-token=.." + queryEncdata + bodyEncdata)` |
| 手机端紧凑 JSON | 必须和 Python `json.dumps` 一致 —— 非 ASCII 要转义成 `\uXXXX`，分隔符不带空格 |

> **两条云 API 的签名机制完全不同**，别混：OpenAPI 是官方文档化的 HMAC-SHA256；
> 手机端那套是"MD5 派生 hashKey → HMAC 派生 16 字节 secret → AES-GCM 加密 payload"
> 的自研组合，只能从 SDK 反推。本项目的 `test_mobile.js` 就是拿官方 SDK
> 当标准答案逐字段对齐的。

---

## 参考与致谢

- [make-all/tuya-local](https://github.com/make-all/tuya-local) — HA 集成，本插件的移植来源；
  1770 个设备定义是品类映射规则的重要参考；`cloud.py` 是扫码登录流程的参照
- [jasonacox/tinytuya](https://github.com/jasonacox/tinytuya) — 局域网协议的权威参考实现，
  本项目用它生成帧测试向量
- [tuya/tuya-device-sharing-sdk](https://github.com/tuya/tuya-device-sharing-sdk) — 涂鸦**官方**
  手机端云 SDK（HA 主线在用），本项目用它生成签名与加密的测试向量
- [tuya/tuya-connector-python](https://github.com/tuya/tuya-connector-python) — 官方云 SDK，
  用于生成 OpenAPI 签名向量
- [lincolnloop/python-qrcode](https://github.com/lincolnloop/python-qrcode) — 二维码矩阵比对的标准答案
- miha 插件开发指南与 `miha-plugin-dev` skill — 插件契约、Host 桥、十条铁律

---

## License

[MIT](LICENSE)
