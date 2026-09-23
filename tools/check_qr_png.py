"""
二维码 PNG 端到端验证：把 JS 生成的 PNG 真的解回来。

矩阵对不代表图片对 —— zlib 包装、位深打包、行过滤、静区、缩放，任何一环错了
都是「矩阵正确但图扫不出来」。所以这里做两件事：

  1. 用 Pillow 解 PNG，按缩放网格取样，和参考矩阵逐模块比
  2. 用 OpenCV 的 QRCodeDetector 真的识别一次，确认解出来的**字符串**就是原文

用法：
    node tools/test_qr.js                      # 先生成 tools/qr_selftest.png
    python tools/check_qr_png.py               # 再跑这个
"""

import json
import pathlib
import sys

import cv2
import qrcode
from PIL import Image
from qrcode.util import MODE_8BIT_BYTE, QRData

ROOT = pathlib.Path(__file__).resolve().parent.parent
PNG = ROOT / "tools" / "qr_selftest.png"
META = ROOT / "tools" / "qr_selftest.txt"

LEVELS = {
    "M": qrcode.constants.ERROR_CORRECT_M,
    "Q": qrcode.constants.ERROR_CORRECT_Q,
}

failures: list[str] = []


def report(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"  \u2713 {name}")
    else:
        failures.append(f"{name}  → {detail}")
        print(f"  \u2717 {name}  → {detail}")


if not PNG.exists() or not META.exists():
    print("找不到 tools/qr_selftest.png，请先跑 node tools/test_qr.js")
    sys.exit(1)

meta = json.loads(META.read_text(encoding="utf-8"))
text = meta["text"]
level = meta.get("level", "M")
SCALE = meta.get("scale", 4)
QUIET = meta.get("quiet", 4)
print(f"待验文本：{text}（纠错等级 {level}，缩放 {SCALE}，静区 {QUIET}）\n")

# ---------------------------------------------------------------- 1. 解 PNG

img = Image.open(PNG)
print(f"PNG 模式={img.mode} 尺寸={img.size}")
report("Pillow 能打开", True)
report("是单通道位图（1 位灰度）", img.mode == "1", img.mode)

w, h = img.size
report("宽高相等", w == h, f"{w}x{h}")
report("尺寸 = (模块数 + 2×静区) × 缩放", (w % SCALE) == 0, str(w))

size = w // SCALE - QUIET * 2
report("推得模块数合理", size in range(21, 58), str(size))

px = img.load()

# 按网格取样（取每个模块的中心点）
got = []
for i in range(size):
    row = []
    for j in range(size):
        x = (j + QUIET) * SCALE + SCALE // 2
        y = (i + QUIET) * SCALE + SCALE // 2
        row.append(1 if px[x, y] == 0 else 0)  # 0 = 黑 = 深色模块
    got.append(row)

# ------------------------------------------- 2. 和参考矩阵比（找一个匹配的掩码）

matched_mask = None
best_diff = None
for mask in range(8):
    m = qrcode.QRCode(
        error_correction=LEVELS[level],
        mask_pattern=mask,
        border=0,
    )
    m.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE, check_data=False))
    m.make(fit=True)
    rows = m.modules
    if len(rows) != size:
        continue
    diff = sum(
        1
        for i in range(size)
        for j in range(size)
        if (1 if rows[i][j] else 0) != got[i][j]
    )
    if best_diff is None or diff < best_diff:
        best_diff = diff
        matched_mask = mask

report(
    "PNG 像素与参考矩阵完全一致（匹配掩码 %s）" % matched_mask,
    best_diff == 0,
    f"最少差异 {best_diff} 个模块",
)

# --------------------------------------------------- 3. 真的解码出来

detector = cv2.QRCodeDetector()
decoded, points, _ = detector.detectAndDecode(cv2.imread(str(PNG)))
report("OpenCV 能识别出二维码", bool(points is not None and len(points)), "")
report(
    "解出来的字符串就是原文",
    decoded == text,
    f"got {decoded!r}",
)

# ---------------------------------------------------------------- 汇总

print("\n" + "=" * 56)
if failures:
    print("失败：")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("二维码 PNG 端到端验证通过 ♪")
