#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""digitize-fig.py —— 把论文里的曲线图（位图）取成数据表。

为什么要脚本化（2026-09-15）：从曲线图上读数字**不该靠模型视觉** ✗——
那是图像处理问题，脚本更快、更准，而且结果可复核（会输出 overlay 图）。
DSH 里的 AI 遇到"Fig. X 的数据是多少"这类问题，直接跑本工具即可，不必找人代读。

依赖：numpy + Pillow（WSL 的 ml 环境里都有：/home/solanine/envs/ml/bin/python）

用法：
  python digitize-fig.py fig.png --x 50:1600 --y 1:0 --curves red,black \\
         --sample 200:1600:25 --out fig12

参数：
  --x a:b        坐标框左/右边界对应的横轴值（图上目测即可，比如 50:1600）
  --y hi:lo      坐标框上/下边界对应的纵轴值（比如 1:0）
  --curves       曲线颜色族，逗号分隔（red,black,blue,green,…）；按此顺序输出列
  --sample a:b:s 取样范围与步长（不填则用坐标框整段）
  --frame x0,x1,y0,y1  手动指定坐标框像素位置（自动识别失败时用）
  --out PREFIX   输出 PREFIX.csv / PREFIX.npz / PREFIX-overlay.png

输出：
  PREFIX.csv       每个取样点的各条曲线数值
  PREFIX.npz       numpy 版（freq + 各曲线）
  PREFIX-overlay.png  把取样点画回原图（人眼复核：点应压在曲线上）

做法：找坐标框 → 按颜色分离曲线 → 逐列"连续性跟踪"（每列取离上一列最近的线段中心，
避免交叉处串线）→ 线性标定回数据坐标 → 取样。工具会打印几何标定结果与自检，
若 overlay 上有点没压在曲线上，请调 --frame 或 --curves 后重跑。
"""
import argparse
import csv
import os
import sys

import numpy as np
from PIL import Image, ImageDraw


def longest_run(m):
    idx = np.flatnonzero(m)
    if idx.size == 0:
        return 0, -1, -1
    best = max(np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1), key=len)
    return len(best), int(best[0]), int(best[-1])


COLOR_RULES = {
    'red': lambda R, G, B: (R > 110) & ((R - G) > 35) & ((R - B) > 35),
    'blue': lambda R, G, B: (B > 110) & ((B - R) > 35) & ((B - G) > 25),
    'green': lambda R, G, B: (G > 90) & ((G - R) > 30) & ((G - B) > 20),
    'black': lambda R, G, B: (R < 110) & (G < 110) & (B < 110),
}


def find_frame(a):
    """自动找坐标框：窗口内暗像素计数最高的两列/两行（先用整图中部的横竖分布定位）。"""
    lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]
    dark = lum < 160
    H, W = dark.shape
    col = dark.sum(axis=0)
    row = dark.sum(axis=1)
    # 竖线：暗像素超过图高 25% 的列
    vc = np.flatnonzero(col > 0.25 * H)
    hc = np.flatnonzero(row > 0.20 * W)
    if vc.size < 2 or hc.size < 2:
        return None
    x_left, x_right = int(vc.min()), int(vc.max())
    y_top, y_bot = int(hc.min()), int(hc.max())
    return x_left, x_right, y_top, y_bot, dark


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--x', required=True, help='左:右边界对应的横轴值，如 50:1600')
    ap.add_argument('--y', required=True, help='上:下边界对应的纵轴值，如 1:0')
    ap.add_argument('--curves', default='red,black')
    ap.add_argument('--sample', default='')
    ap.add_argument('--frame', default='')
    ap.add_argument('--out', default='digitized')
    args = ap.parse_args()

    x0v, x1v = (float(v) for v in args.x.split(':'))
    yhv, ylv = (float(v) for v in args.y.split(':'))
    curves = [c.strip() for c in args.curves.split(',') if c.strip()]

    im = Image.open(args.image).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    found = find_frame(a)
    if args.frame:
        X_L, X_R, Y_T, Y_B = (int(v) for v in args.frame.split(','))
        lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]
        dark = lum < 160
    elif found:
        X_L, X_R, Y_T, Y_B, dark = found
    else:
        sys.exit('自动找坐标框失败，请用 --frame x0,x1,y0,y1 手动指定')
    print(f'坐标框: x∈[{X_L},{X_R}] y∈[{Y_T},{Y_B}]')
    for nm, col_hits in (('left', dark[Y_T:Y_B, X_L]), ('right', dark[Y_T:Y_B, X_R - 1]),
                         ('top', dark[Y_T + 1, X_L:X_R]), ('bottom', dark[Y_B - 1, X_L:X_R])):
        frac = col_hits.mean()
        print(f'   自检 {nm}: 暗像素占比 {frac:.2f}' + ('' if frac > 0.8 else '  ← 偏低，建议 --frame'))
    kx = (x1v - x0v) / (X_R - X_L)
    ky = (ylv - yhv) / (Y_B - Y_T)
    hz = lambda xp: x0v + (xp - X_L) * kx
    val = lambda yp: yhv + (yp - Y_T) * ky
    print(f'标定: f = {kx:.4f}*x + {x0v - X_L * kx:.1f} ; R = {ky:.6f}*y + {yhv - Y_T * ky:.4f}')

    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    zone = np.zeros(dark.shape, bool)
    zone[Y_T + 4:Y_B - 3, X_L + 4:X_R - 3] = True
    # 图例框（框内左下角的连续长水平线）：屏蔽掉，否则图例里的示例线会被当成数据
    inner = dark[Y_T + 3:Y_B - 2, X_L + 3:X_R - 2]
    rows = []
    for yy in range(inner.shape[0]):
        n, a0, b0 = longest_run(inner[yy, :])
        if n > 0.22 * (X_R - X_L) and a0 < 0.45 * (X_R - X_L) and yy > 0.45 * inner.shape[0]:
            rows.append((Y_T + 3 + yy, a0 + X_L + 3, b0 + X_L + 3))
    if rows:
        y0, y1 = rows[0][0], rows[-1][0]
        bx0 = min(r[1] for r in rows); bx1 = max(r[2] for r in rows)
        if 8 < y1 - y0 < 0.4 * (Y_B - Y_T):
            zone[y0 - 2:y1 + 3, bx0 - 2:bx1 + 3] = False
            print(f'   屏蔽图例区: y∈[{y0},{y1}] x∈[{bx0},{bx1}]')

    def trace(mask):
        xs, ys, prev = [], [], None
        for x in range(X_L + 4, X_R - 3):
            col = np.flatnonzero(mask[:, x])
            if col.size == 0:
                continue
            centers = [float(g.mean()) for g in np.split(col, np.flatnonzero(np.diff(col) > 1) + 1)]
            pick = (min(centers, key=lambda c: abs(c - np.median(col))) if prev is None
                    else (min([c for c in centers if abs(c - prev) <= 28] or centers, key=lambda c: abs(c - prev))))
            xs.append(x); ys.append(pick); prev = pick
        return np.array(xs, float), np.array(ys, float)

    gx = np.arange(X_L + 4, X_R - 3)
    series = {}
    for c in curves:
        rule = COLOR_RULES.get(c)
        if not rule:
            sys.exit(f'不认识的颜色：{c}（可选 {", ".join(COLOR_RULES)}）')
        tx, ty = trace(rule(R, G, B) & zone)
        if tx.size < 2:
            print(f'   ⚠️ {c}: 找到的像素太少（{tx.size} 列），该条曲线可能不存在或是别的颜色')
            continue
        series[c] = np.interp(gx, tx, ty)
        print(f'   {c}: 跟踪到 {tx.size} 列')

    if args.sample:
        s0, s1, st = (float(v) for v in args.sample.split(':'))
        xs_v = np.arange(s0, s1 + 1e-9, st)
    else:
        xs_v = hz(gx[::max(1, gx.size // 200)]).round(2)

    rows_out = []
    for f in xs_v:
        row = [f]
        for c in curves:
            if c not in series:
                row.append(float('nan')); continue
            px = int(np.clip((f - (x0v - X_L * kx)) / kx, gx[0], gx[-1]))
            row.append(round(float(val(series[c][np.clip(np.searchsorted(gx, px), 0, gx.size - 1)])), 4))
        rows_out.append(row)

    with open(args.out + '.csv', 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['x'] + curves)
        w.writerows(rows_out)
    np.savez(args.out + '.npz', x=np.array([r[0] for r in rows_out]),
             **{c: np.array([r[i + 1] for r in rows_out]) for i, c in enumerate(curves)})
    ov = im.copy(); dr = ImageDraw.Draw(ov)
    palette = [(0, 160, 0), (0, 0, 255), (255, 0, 255), (0, 160, 160)]
    for i, c in enumerate(curves):
        if c not in series:
            continue
        for r in rows_out:
            px = (r[0] - (x0v - X_L * kx)) / kx
            py = (r[i + 1] - (yhv - Y_T * ky)) / ky
            dr.ellipse([px - 3, py - 3, px + 3, py + 3], outline=palette[i % 4], width=2)
    ov.crop((X_L - 90, Y_T - 40, X_R + 40, Y_B + 60)).save(args.out + '-overlay.png')
    print(f'\n写出 {args.out}.csv / .npz / -overlay.png（{len(rows_out)} 个取样点）')
    print('请看一眼 overlay：取样点应压在各自曲线上；有点飘就调 --frame 或 --curves 后重跑。')


if __name__ == '__main__':
    main()
