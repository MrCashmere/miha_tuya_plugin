"""
用 Python 的 qrcode 库生成「标准答案」二维码矩阵，供 JS 编码器逐模块比对。

参照物只在生成向量时用，不进插件、不在运行期依赖。

覆盖范围：纠错等级 M 与 Q × 版本 1–10 × 全部 8 种掩码。
每个版本的用例长度都取「刚好装得下该版本的最长内容」，保证真的打到了那个版本。

用法：
    python tools/gen_expected_qr.py > tools/expected_qr.json
"""

import json
import sys

import qrcode
from qrcode.util import MODE_8BIT_BYTE, QRData

LEVELS = {
    "M": qrcode.constants.ERROR_CORRECT_M,
    "Q": qrcode.constants.ERROR_CORRECT_Q,
}


def build(text: str, mask: int, level: str):
    q = qrcode.QRCode(
        error_correction=LEVELS[level],
        mask_pattern=mask,
        border=0,
    )
    # 强制字节模式：不传 mode 的话库会对纯数字/大写字母的串选数字或字母数字模式，
    # 那就和我们的实现不是一个东西了。
    q.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE, check_data=False))
    q.make(fit=True)
    return q.version, q.modules


def max_len_for_version(level: str, version: int) -> int:
    """二分出「仍落在该版本内」的最长内容长度。"""
    lo, hi, best = 0, 1200, 0
    while lo <= hi:
        mid = (lo + hi) // 2
        try:
            got, _ = build("x" * mid, 0, level)
        except Exception:
            got = 99
        if got <= version:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return best


out = []
for level in LEVELS:
    for version in range(1, 11):
        n = max_len_for_version(level, version)
        # 用 'a' + 'x'*(n-1) 之类，避免全同字符影响可读性；长度不变即可
        text = "tuyaSmart--qrLogin?token=" + "x" * max(0, n - 23) if n >= 23 else "x" * n
        text = text[:n]
        for mask in range(8):
            got_version, modules = build(text, mask, level)
            assert got_version == version, (level, version, got_version, n)
            rows = ["".join("1" if v else "0" for v in row) for row in modules]
            out.append(
                {
                    "level": level,
                    "text": text,
                    "len": n,
                    "mask": mask,
                    "version": version,
                    "size": len(modules),
                    "rows": rows,
                }
            )

json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
print("", file=sys.stderr)
covered = sorted({(c["level"], c["version"]) for c in out})
print(
    "生成 %d 组用例，覆盖 %s" % (len(out), covered),
    file=sys.stderr,
)
