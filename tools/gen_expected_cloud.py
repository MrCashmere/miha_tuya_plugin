# -*- coding: utf-8 -*-
"""
用涂鸦官方 SDK（tuya-connector-python）生成云请求签名的「标准答案」。

时间戳被 mock 成固定值，否则每次结果都不一样、没法逐字节比。
POST 用例需要把 SDK 内部的 json.dumps 换成紧凑版（separators 无空格），
才能和 JS 的 JSON.stringify 对齐 —— 实际调用时两边各自自洽即可，
这里只是为了能比对。
"""
import json
import sys
import time
from unittest import mock

import tuya_connector.openapi as oapi
from tuya_connector import TuyaOpenAPI

# 让 SDK 的 body 序列化与 JS 的 JSON.stringify 一致（无空格）。
# 注意不能直接改 json.dumps —— oapi.json 就是全局 json 模块，改了会污染全局。
_ORIG_DUMPS = json.dumps


class _CompactJson:
    """只替换 openapi 模块内看到的 json 引用。"""

    @staticmethod
    def dumps(obj):
        return _ORIG_DUMPS(obj, separators=(",", ":"))


oapi.json = _CompactJson

ACCESS_ID = "testaccessid123456"
ACCESS_SECRET = "testsecretabcdefghijklmnopqrstuvwxyz"
ACCESS_TOKEN = "testtoken0123456789abcdef"
FIXED_TIME = 1700000000.0

api = TuyaOpenAPI("https://openapi.tuyacn.com", ACCESS_ID, ACCESS_SECRET)


class FakeToken:
    access_token = ACCESS_TOKEN
    refresh_token = "r"
    expire_time = 0
    uid = "u"


api.token_info = FakeToken()

CASES = [
    # (名字, 方法, 路径, params, body, 是否带 token)
    ("token_no_auth", "GET", "/v1.0/token", {"grant_type": 1}, None, False),
    ("devices_list", "GET", "/v1.0/devices", None, None, True),
    ("paged_devices", "GET", "/v1.0/iot-03/devices",
     {"page_size": 100, "page_no": 1}, None, True),
    ("device_detail", "GET", "/v1.0/devices/bf1234567890abcdefghij", None, None, True),
    ("spec", "GET", "/v1.0/iot-03/devices/bf1234567890abcdefghij/specification", None, None, True),
    ("commands", "POST", "/v1.0/iot-03/devices/bf1234567890abcdefghij/commands", None,
     {"commands": [{"code": "switch_1", "value": True}]}, True),
]


class NoToken:
    pass


out = {}
with mock.patch("time.time", return_value=FIXED_TIME):
    for name, method, path, params, body, use_token in CASES:
        if not use_token:
            api.token_info = None
        else:
            api.token_info = FakeToken()
        sign, t = api._calculate_sign(method, path, params, body)
        out[name] = {
            "method": method,
            "path": path,
            "query": params or {},
            "bodyJson": json.dumps(body, separators=(",", ":")) if body else "",
            "useToken": use_token,
            "sign": sign,
            "t": t,
        }

out["_meta"] = {
    "accessId": ACCESS_ID,
    "accessSecret": ACCESS_SECRET,
    "accessToken": ACCESS_TOKEN,
    "endpoint": "https://openapi.tuyacn.com",
    "fixedTimeMs": str(int(FIXED_TIME * 1000)),
}

dest = sys.argv[1] if len(sys.argv) > 1 else "expected_cloud.json"
with open(dest, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2, ensure_ascii=False)

print("已生成 %d 个云签名用例 -> %s" % (len(CASES), dest))
for name, _, _, _, _, _ in CASES:
    print("  %-16s t=%s sign=%s" % (name, out[name]["t"], out[name]["sign"]))
