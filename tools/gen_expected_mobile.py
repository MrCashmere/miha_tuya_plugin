"""
用**官方 SDK**（tuya-device-sharing-sdk）生成手机端云 API 的「标准答案」。

参照物是涂鸦官方维护、HA 主线在用的那个库本身 —— 不是我们自己转写的版本，
所以这份比对是真的独立验证，而不是"照着自己抄一遍再对自己比"。

给固定输入（rid / refresh_token / nonce / 参数）算出：

  hashKey    = md5(rid + refresh_token)
  secret     = hmacSha256(rid, hashKey).hex[:16]
  queryEnc   = AES-GCM(secret, nonce, 紧凑 JSON(params)) → base64(nonce)+base64(ct+tag)
  bodyEnc    同上
  sign       = hmacSha256(hashKey, 头部串 + queryEnc + bodyEnc).hex

另外捕获 LoginControl 实际发出的两个二维码请求 URL。

用法：
    pip install tuya-device-sharing-sdk==0.2.15
    python tools/gen_expected_mobile.py > tools/expected_mobile.json
"""

import json
import sys

import tuya_sharing.customerapi as capi

# ---------------------------------------------------------------- 固定向量

# 让密文可复现：nonce 由协议里随机，但必须能在测试里钉住
FIXED_NONCE = "Ab3Kd9MnPq2Z"
FIXED_RID = "11112222-3333-4444-8555-666677778888"


class _FixedNonce:
    """临时把 SDK 的随机 nonce 换成固定值。"""

    def __enter__(self):
        self._old = capi._random_nonce
        capi._random_nonce = lambda e=32: FIXED_NONCE[:e]
        return self

    def __exit__(self, *exc):
        capi._random_nonce = self._old
        return False


CASES = [
    {
        "name": "GET 无参",
        "method": "GET",
        "path": "/v1.0/m/life/users/homes",
        "refreshToken": "rt-aaaabbbbccccdddd",
        "accessToken": "at-1111222233334444",
        "params": None,
        "body": None,
    },
    {
        "name": "GET 带 query 参数",
        "method": "GET",
        "path": "/v1.0/m/life/ha/home/devices",
        "refreshToken": "rt-eeeeffff00001111",
        "accessToken": "at-5555666677778888",
        "params": {"homeId": "home-9x8y7z"},
        "body": None,
    },
    {
        "name": "POST 带 body",
        "method": "POST",
        "path": "/v1.1/m/thing/devid001/commands",
        "refreshToken": "rt-1234123412341234",
        "accessToken": "at-99990000aaaabbbb",
        "params": None,
        "body": {"commands": [{"code": "switch_1", "value": True}]},
    },
    {
        "name": "无 access_token（刷新令牌那一步）",
        "method": "GET",
        "path": "/v1.0/m/token/rt-abcdefabcdefabcd",
        "refreshToken": "rt-abcdefabcdefabcd",
        "accessToken": "",
        "params": None,
        "body": None,
    },
    {
        "name": "中文与转义字符",
        "method": "GET",
        "path": "/v1.0/m/life/ha/devices/detail",
        "refreshToken": "rt-中文也要能签",
        "accessToken": "at-x",
        "params": {"devIds": "a,b", "note": '引号"与反斜杠\\还有换行\n'},
        "body": None,
    },
]


def build_case(c: dict) -> dict:
    rid = FIXED_RID
    hash_key = capi.hashlib.md5((rid + c["refreshToken"]).encode("utf-8")).hexdigest()
    secret = capi._secret_generating(rid, "", hash_key)

    headers = {
        "X-appKey": "HA_3y9q4ak7g4ephrvke",
        "X-requestId": rid,
        "X-sid": "",
        "X-time": "1758600000000",
    }
    if c["accessToken"]:
        headers["X-token"] = c["accessToken"]

    query_enc = ""
    if c["params"]:
        query_enc = capi._aes_gcm_encrypt(
            capi._form_to_json(c["params"]), secret
        ).decode("utf-8")
    body_enc = ""
    if c["body"]:
        body_enc = capi._aes_gcm_encrypt(
            capi._form_to_json(c["body"]), secret
        ).decode("utf-8")

    sign = capi._restful_sign(hash_key, query_enc, body_enc, headers)

    # 反解一遍，确认密文里确实是那份紧凑 JSON
    if query_enc:
        assert capi._aex_gcm_decrypt(query_enc, secret) == capi._form_to_json(c["params"])
    if body_enc:
        assert capi._aex_gcm_decrypt(body_enc, secret) == capi._form_to_json(c["body"])

    out = dict(c)
    out.update(
        {
            "rid": rid,
            "nonce": FIXED_NONCE,
            "headers": headers,
            "hashKey": hash_key,
            "secret": secret,
            "queryEnc": query_enc,
            "bodyEnc": body_enc,
            "sign": sign,
        }
    )
    return out


# ------------------------------------------------------ 捕获二维码请求 URL


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, sink):
        self._sink = sink

    def request(self, method, url, **kwargs):
        self._sink.append({"method": method, "url": url})
        return _FakeResp({"success": True, "result": {"qrcode": "QRTOKEN-abc123"}, "t": 1758600000000})


qr_requests = []
from tuya_sharing.user import LoginControl  # noqa: E402

lc = LoginControl()
lc.session = _FakeSession(qr_requests)
lc.qr_code("HA_3y9q4ak7g4ephrvke", "haauthorize", "usercode-01")
lc.login_result("QRTOKEN-abc123", "HA_3y9q4ak7g4ephrvke", "usercode-01")

payload = {
    # ⚠️ 必须真的进到固定 nonce 的上下文里 —— 忘了这一步，SDK 每次用随机 nonce，
    #    密文就不可复现，比对必然全挂（第一版就是这么翻车的）。
    "cases": [],
    "qrRequests": qr_requests,
    "appKey": "HA_3y9q4ak7g4ephrvke",
    "schema": "haauthorize",
}

with _FixedNonce():
    payload["cases"] = [build_case(c) for c in CASES]

json.dump(payload, sys.stdout, ensure_ascii=False, indent=1)
print("", file=sys.stderr)
print(
    "生成 %d 组签名用例 + %d 个二维码请求 URL"
    % (len(payload["cases"]), len(qr_requests)),
    file=sys.stderr,
)
