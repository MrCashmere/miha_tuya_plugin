# -*- coding: utf-8 -*-
"""
用真实的 tinytuya 生成「标准答案」帧，供 JS 实现逐字节比对。

我们没有真机可验证，但可以验证「与 Python 参考实现逐字节一致」——
这是没有硬件时能达到的最高置信度。

注意：v3.2 的 set_version 会触发 detect_available_dps()（真去连网络），
所以这里只覆盖 3.1 / 3.3 / 3.4 / 3.5。

v3.5 的 GCM IV 平时是随机的；crypto_helper 在 DEBUG 级别下会退化成固定
b'0123456789ab'，这里就利用这一点让帧可复现。
"""
import json
import logging
import sys

logging.getLogger("tinytuya.core.crypto_helper").setLevel(logging.DEBUG)
logging.getLogger("tinytuya.core.crypto_helper").propagate = False
logging.getLogger("tinytuya.core.crypto_helper").addHandler(logging.NullHandler())

import tinytuya
from tinytuya.core.XenonDevice import XenonDevice
from tinytuya.core.message_helper import MessagePayload

KEY = "0123456789abcdef"
SESSION_KEY = b"fedcba9876543210"
DEV_ID = "bf1234567890abcdefghij"
FIXED_IV = b"0123456789ab"


def make_device(version, session_key=None, seqno=1):
    d = XenonDevice(DEV_ID, address="127.0.0.1", local_key=KEY, version=version, persist=False)
    d.seqno = seqno
    if session_key is not None:
        d.local_key = session_key
        d.real_local_key = session_key
    return d


CASES = [
    ("v31_control", 3.1, tinytuya.CONTROL,
     '{"devId":"bf1234","uid":"bf1234","t":"1700000000","dps":{"1":true}}', False),
    ("v33_dpquery", 3.3, tinytuya.DP_QUERY,
     '{"gwId":"bf1234","devId":"bf1234","uid":"bf1234","t":"1700000000"}', False),
    ("v33_control", 3.3, tinytuya.CONTROL,
     '{"devId":"bf1234","uid":"bf1234","t":"1700000000","dps":{"1":true,"2":100}}', False),
    ("v33_heartbeat", 3.3, tinytuya.HEART_BEAT, '{"gwId":"bf1234","devId":"bf1234"}', False),
    ("v34_dpquery_new", 3.4, tinytuya.DP_QUERY_NEW, '{}', True),
    ("v34_control_new", 3.4, tinytuya.CONTROL_NEW,
     '{"protocol":5,"t":1700000000,"data":{"dps":{"1":true}}}', True),
    ("v35_dpquery_new", 3.5, tinytuya.DP_QUERY_NEW, '{}', True),
    ("v35_control_new", 3.5, tinytuya.CONTROL_NEW,
     '{"protocol":5,"t":1700000000,"data":{"dps":{"1":true}}}', True),
    ("v35_heartbeat", 3.5, tinytuya.HEART_BEAT, '{"gwId":"bf1234","devId":"bf1234"}', True),
]

out = {}
for name, version, cmd, payload_json, use_session in CASES:
    d = make_device(version, SESSION_KEY if use_session else None, seqno=1)
    frame = d._encode_message(MessagePayload(cmd, payload_json.encode("utf-8")))
    out[name] = {
        "version": version,
        "cmd": cmd,
        "payloadJson": payload_json,
        "useSessionKey": use_session,
        "frameHex": frame.hex(),
    }

out["_meta"] = {
    "key": KEY,
    "sessionKeyHex": SESSION_KEY.hex(),
    "devId": DEV_ID,
    "gcmFixedIvHex": FIXED_IV.hex(),
}

# ---------------------------------------------------------------------------
# 附加验证 1：v3.4 / v3.5 的会话密钥派生
#   会话密钥 = AES(realKey, localNonce XOR remoteNonce)
#   3.4 用 ECB（不打填充）；3.5 用 GCM 的 CTR 部分，取密文前 16 字节
# ---------------------------------------------------------------------------
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

local_nonce = bytes(range(16))
remote_nonce = bytes(range(16, 32))
xored = bytes(a ^ b for a, b in zip(local_nonce, remote_nonce))

enc34 = Cipher(algorithms.AES(KEY.encode("latin1")), modes.ECB()).encryptor()
session34 = enc34.update(xored) + enc34.finalize()

enc35 = Cipher(algorithms.AES(KEY.encode("latin1")), modes.GCM(local_nonce[:12])).encryptor()
ct35 = enc35.update(xored) + enc35.finalize()
session35 = ct35[:16]

# ---------------------------------------------------------------------------
# 附加验证 2：UDP 主动探测包（7000 端口，REQ_DEVINFO）
# ---------------------------------------------------------------------------
from tinytuya.core.message_helper import pack_message, TuyaMessage

probe_plain = json.dumps({"from": "app", "ip": "192.168.1.100"}).encode()
probe_msg = TuyaMessage(0, 0x25, None, probe_plain, 0, True, 0x00006699, True)
probe_frame = pack_message(probe_msg, hmac_key=tinytuya.udpkey)

out["_derivations"] = {
    "localNonceHex": local_nonce.hex(),
    "remoteNonceHex": remote_nonce.hex(),
    "xorHex": xored.hex(),
    "sessionKey34Hex": session34.hex(),
    "sessionKey35Hex": session35.hex(),
    "udpProbePlain": probe_plain.decode(),  # 注意：json.dumps 默认带空格，字节要跟它对齐
    "udpProbeFrameHex": probe_frame.hex(),
}

dest = sys.argv[1] if len(sys.argv) > 1 else "expected_frames.json"
with open(dest, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2, ensure_ascii=False)

print("已生成 %d 个用例 -> %s" % (len(CASES), dest))
for name in out:
    if name.startswith("_"):
        continue
    print("  %-20s %s" % (name, out[name]["frameHex"]))
