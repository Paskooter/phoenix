#!/usr/bin/env python3
"""Reproducible first-party art for the Phoenix Ember and Phoenix Orbit theme packs.

Everything here is original, drawn from code: no downloaded images, fonts or
third-party artwork. Pictograms are vector paths rendered with Pillow at 8x
supersampling and box-filtered down, so the output is anti-aliased, exact and
the same on every run. Nothing depicts Jibo (owner rule): no robot, shell,
face or single-circle "screen" motifs anywhere, previews show abstract menu
tiles only.

    python3 build-art.py             write ember/assets and orbit/assets
    python3 build-art.py --check     re-render in memory, compare decoded pixels
                                     with the committed PNGs, validate limits
    python3 build-art.py --sheets D  also write icon contact sheets and copies
                                     of the backgrounds/previews to D (review)

Needs Python 3 with Pillow and NumPy. See themes/README.md for dependencies.
"""
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, pasketti and the Phoenix project.
# See the repository LICENSE for redistribution conditions and disclaimer.
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SS = 8            # icon supersampling
ICON = 256        # icon canvas (docs/THEMES.md)
BOX = 160         # centered drawing area inside the canvas
BG_W, BG_H = 1280, 720
PREVIEW = 720

# The 38 icon stems of docs/THEMES.md, in table order.
STEMS = ['introduction', 'things-to-do', 'fun', 'clock', 'report', 'music', 'camera', 'gallery', 'photobooth', 'yoga',
         'tutorial', 'settings', 'agent', 'spotify', 'tic-tac-toe', 'app', 'circuit-saver', 'word-of-day', 'joke', 'dance',
         'surprise', 'weather', 'calendar', 'commute', 'news', 'time', 'date', 'timer', 'alarm', 'yoga-sun', 'yoga-warrior',
         'volume', 'wifi', 'battery', 'about', 'updates', 'home-assistant', 'themes']


def hexrgb(value):
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


# Example palettes, copied verbatim into each theme.json.
PALETTES = {
    'ember': {'background': '#10151D', 'surface': '#5B2F1B', 'surfaceSecondary': '#36251F', 'text': '#FFF4E5', 'mutedText': '#E6D5BE', 'accent': '#FFB15C'},
    'orbit': {'background': '#0B1420', 'surface': '#15313F', 'surfaceSecondary': '#102633', 'text': '#F3FBFF', 'mutedText': '#C3DCE8', 'accent': '#71E4D2'},
}
OPACITY = {'ember': 0.22, 'orbit': 0.18}
# Ember: single-weight ivory line pictograms with a tiny amber accent.
# Orbit: heavier white strokes over a translucent teal fill (duotone glyphs).
STYLES = {
    'ember': {'line': hexrgb(PALETTES['ember']['text']), 'accent': hexrgb(PALETTES['ember']['accent']), 'tone': None, 'width': 8.5},
    'orbit': {'line': hexrgb(PALETTES['orbit']['text']), 'accent': hexrgb(PALETTES['orbit']['accent']),
              'tone': (hexrgb(PALETTES['orbit']['accent']), 0.30), 'width': 10.5},
}

# ---------------------------------------------------------------------------
# Geometry helpers (160-unit icon space, y down, angles in degrees, 0 = +x)
# ---------------------------------------------------------------------------


def arc(cx, cy, r, a0, a1, step=3.0, ry=None, rot=0.0):
    ry = r if ry is None else ry
    n = max(2, int(math.ceil(abs(a1 - a0) / step)))
    c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    out = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        x, y = r * math.cos(a), ry * math.sin(a)
        out.append((cx + x * c - y * s, cy + x * s + y * c))
    return out


def circle(cx, cy, r):
    return arc(cx, cy, r, 0, 360)[:-1]


def rrect(x0, y0, x1, y1, r):
    pts = []
    for cx, cy, a0 in ((x1 - r, y0 + r, 270), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
        pts += arc(cx, cy, r, a0, a0 + 90, step=6)
    return pts


def bez(p0, p1, p2, p3, n=28):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return out


def bubble(x0, y0, x1, y1, r, tail):
    """Rounded speech bubble; tail = (xa, xb, tip_x, tip_y) on the bottom edge."""
    xa, xb, tx, ty = tail
    return (arc(x1 - r, y0 + r, r, 270, 360, 6) + arc(x1 - r, y1 - r, r, 0, 90, 6) + [(xb, y1), (tx, ty), (xa, y1)]
            + arc(x0 + r, y1 - r, r, 90, 180, 6) + arc(x0 + r, y0 + r, r, 180, 270, 6))


def rotate(points, cx, cy, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c) for x, y in points]


def sparkle(cx, cy, r, pinch=0.16):
    """Four-point star with concave sides."""
    tips = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
    pts = []
    for i in range(4):
        a, b = tips[i], tips[(i + 1) % 4]
        ctrl = (cx + (a[0] + b[0] - 2 * cx) * pinch, cy + (a[1] + b[1] - 2 * cy) * pinch)
        pts += bez(a, ctrl, ctrl, b, 14)[:-1]
    return pts


class Pen:
    """Draws one coverage layer (mode L) in icon units."""

    def __init__(self, image, scale, offset, width):
        self.image, self.draw = image, ImageDraw.Draw(image)
        self.s, self.o, self.w = scale, offset, width

    def _xy(self, p):
        return (self.o[0] + p[0] * self.s, self.o[1] + p[1] * self.s)

    def _stroke(self, pts, closed, width, value):
        r = width * self.s / 2
        P = [self._xy(p) for p in pts]
        pairs = list(zip(P, P[1:])) + ([(P[-1], P[0])] if closed else [])
        for (x0, y0), (x1, y1) in pairs:
            length = math.hypot(x1 - x0, y1 - y0)
            if length < 1e-9:
                continue
            nx, ny = -(y1 - y0) / length * r, (x1 - x0) / length * r
            self.draw.polygon([(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)], fill=value)
        for x, y in P:
            self.draw.ellipse([x - r, y - r, x + r, y + r], fill=value)

    # strokes ---------------------------------------------------------------
    def path(self, pts, closed=False, width=None):
        self._stroke(pts, closed, self.w if width is None else width, 255)

    def ring(self, cx, cy, r, width=None):
        self.path(circle(cx, cy, r), True, width)

    def box(self, x0, y0, x1, y1, r, width=None):
        self.path(rrect(x0, y0, x1, y1, r), True, width)

    def line(self, x0, y0, x1, y1, width=None):
        self.path([(x0, y0), (x1, y1)], False, width)

    # fills -----------------------------------------------------------------
    def fill(self, pts, value=255):
        self.draw.polygon([self._xy(p) for p in pts], fill=value)

    def dot(self, cx, cy, r):
        self.fill(circle(cx, cy, r))

    def erase(self, pts, grow=0.0):
        """Clear a filled region, optionally grown by `grow` units."""
        self.fill(pts, 0)
        if grow > 0:
            self._stroke(pts, True, grow * 2, 0)


def render_icon(stem, theme, out=ICON, box=BOX):
    """One pictogram as an RGBA uint8 array of out x out pixels."""
    style = STYLES[theme]
    size = out * SS
    scale = box * SS / 160.0
    offset = ((out - box) / 2.0 * SS, (out - box) / 2.0 * SS)
    layers = {name: Image.new('L', (size, size), 0) for name in ('tone', 'line', 'accent')}
    pens = {name: Pen(img, scale, offset, style['width']) for name, img in layers.items()}
    ICONS[stem](pens['line'], pens['accent'], pens['tone'], style['width'])
    masks = {name: np.asarray(img.reduce(SS), dtype=np.float64) / 255.0 for name, img in layers.items()}
    stack = []
    if style['tone']:
        stack.append((style['tone'][0], masks['tone'] * style['tone'][1]))
    stack.append((style['line'], masks['line']))
    stack.append((style['accent'], masks['accent']))
    premul = np.zeros((out, out, 3))
    alpha = np.zeros((out, out))
    for rgb, m in stack:
        premul = np.asarray(rgb, dtype=np.float64)[None, None, :] / 255.0 * m[..., None] + premul * (1 - m[..., None])
        alpha = m + alpha * (1 - m)
    rgb = np.where(alpha[..., None] > 1e-6, premul / np.maximum(alpha[..., None], 1e-6), np.asarray(style['line']) / 255.0)
    rgba = np.dstack([np.clip(np.rint(rgb * 255), 0, 255), np.clip(np.rint(alpha * 255), 0, 255)]).astype(np.uint8)
    return rgba


# ---------------------------------------------------------------------------
# The 38 pictograms. L = line, A = accent, T = tone (Orbit's duotone fill),
# w = stroke width (gaps scale with it). Coordinates stay within [12, 148].
# ---------------------------------------------------------------------------


def i_introduction(L, A, T, w):
    back = bubble(62, 18, 146, 80, 20, (112, 128, 136, 100))
    front = bubble(14, 50, 112, 124, 22, (32, 58, 24, 146))
    L.path(back, True)
    T.fill(back)
    L.erase(front, w * 1.05)
    T.erase(front, w * 0.5)
    L.path(front, True)
    T.fill(front)
    for x in (40, 63, 86):
        A.dot(x, 87, 6.5)


def i_things_to_do(L, A, T, w):
    for y in (36, 80, 124):
        L.box(16, y - 15, 46, y + 15, 8)
        T.fill(rrect(16, y - 15, 46, y + 15, 8))
    L.line(64, 36, 144, 36)
    L.line(64, 80, 144, 80)
    L.line(64, 124, 118, 124)
    A.path([(23, 35), (31, 44), (50, 20)], width=w * 1.05)


def i_fun(L, A, T, w):
    cone = [(18, 144), (50, 72), (90, 112)]
    L.path(cone, True)
    T.fill(cone)
    L.line(33, 110, 68, 126)
    L.line(104, 54, 124, 34)
    L.line(88, 44, 92, 18)
    L.line(116, 82, 144, 78)
    A.dot(128, 18, 6.5)
    A.dot(144, 52, 5.5)
    A.dot(70, 30, 5)


def i_clock(L, A, T, w):
    L.ring(80, 80, 62)
    T.fill(circle(80, 80, 62))
    for deg in (0, 90, 180, 270):
        a = math.radians(deg)
        L.line(80 + 46 * math.cos(a), 80 + 46 * math.sin(a), 80 + 52 * math.cos(a), 80 + 52 * math.sin(a))
    L.path([(56, 56), (80, 80), (106, 66)])
    A.path(arc(80, 80, 62, 200, 250), width=w * 1.15)


def i_report(L, A, T, w):
    page = rrect(28, 14, 132, 146, 14)
    L.path(page, True)
    T.fill(page)
    L.line(48, 38, 104, 38)
    L.line(56, 122, 56, 96)
    A.line(80, 122, 80, 70)
    L.line(104, 122, 104, 84)


def i_music(L, A, T, w):
    beam = [(56, 40), (130, 24)]
    L.path(beam, width=w * 1.6)
    L.line(56, 40, 56, 112)
    L.line(130, 24, 130, 100)
    head1 = arc(40, 114, 17, 0, 360, 6, ry=13, rot=-22)
    L.fill(head1)
    head2 = arc(114, 102, 17, 0, 360, 6, ry=13, rot=-22)
    A.fill(head2)


def i_camera(L, A, T, w):
    body = rrect(14, 46, 146, 132, 18)
    L.path(body, True)
    T.fill(body)
    L.path([(50, 46), (60, 28), (100, 28), (110, 46)])
    L.ring(80, 89, 26)
    A.dot(124, 66, 6.5)


def i_gallery(L, A, T, w):
    back = rrect(40, 18, 146, 104, 12)
    front = rrect(14, 44, 120, 140, 12)
    L.path(back, True)
    T.fill(back)
    L.erase(front, w * 1.05)
    T.erase(front, w * 0.5)
    L.path(front, True)
    T.fill(front)
    L.path([(28, 124), (52, 96), (70, 114), (86, 100), (106, 124)])
    A.dot(92, 70, 9)


def i_photobooth(L, A, T, w):
    strip = rrect(34, 10, 126, 150, 12)
    L.path(strip, True)
    T.fill(strip)
    L.box(50, 24, 110, 58, 6)
    A.box(50, 63, 110, 97, 6)
    L.box(50, 102, 110, 136, 6)


def i_yoga(L, A, T, w):
    center = bez((80, 128), (54, 104), (60, 62), (80, 40)) + bez((80, 40), (100, 62), (106, 104), (80, 128))[1:]
    left = bez((80, 128), (52, 126), (26, 106), (22, 70)) + bez((22, 70), (46, 74), (62, 90), (70, 104))[1:]
    right = [(160 - x, y) for x, y in left]
    L.path(left)
    L.path(right)
    L.path(center, True)
    T.fill(center)
    L.path(bez((28, 136), (60, 146), (100, 146), (132, 136)))
    A.dot(80, 20, 7)


def i_tutorial(L, A, T, w):
    board = [(80, 26), (146, 56), (80, 86), (14, 56)]
    cap = [(42, 72), (42, 104)] + bez((42, 104), (58, 122), (102, 122), (118, 104))[1:] + [(118, 72)]
    L.path(cap)
    T.fill(cap)
    L.erase(board, w * 0.6)
    L.path(board, True)
    T.fill(board)
    L.path([(80, 56), (134, 66), (134, 104)])
    A.fill(rrect(127, 104, 141, 124, 5))


def gear_points(cx, cy, r1, r2, teeth=8, tip=9, base=15):
    pts = []
    step = 360.0 / teeth
    for i in range(teeth):
        th = -90 + step * i
        pts += [(cx + r1 * math.cos(math.radians(th - base)), cy + r1 * math.sin(math.radians(th - base))),
                (cx + r2 * math.cos(math.radians(th - tip)), cy + r2 * math.sin(math.radians(th - tip))),
                (cx + r2 * math.cos(math.radians(th + tip)), cy + r2 * math.sin(math.radians(th + tip)))]
        pts += arc(cx, cy, r1, th + base, th + step - base, 3)
    return pts


def i_settings(L, A, T, w):
    g = gear_points(80, 80, 48, 64)
    L.path(g, True)
    T.fill(g)
    T.erase(circle(80, 80, 20))
    A.ring(80, 80, 20, width=w * 1.05)


def i_agent(L, A, T, w):
    big = sparkle(68, 90, 56)
    L.path(big, True)
    T.fill(big)
    A.fill(sparkle(126, 32, 20, 0.2))


def i_spotify(L, A, T, w):
    L.path(arc(80, 92, 58, 192, 348))
    left, right = rrect(14, 94, 46, 142, 12), rrect(114, 94, 146, 142, 12)
    L.line(23.3, 80, 23.3, 94)
    L.line(136.7, 80, 136.7, 94)
    L.path(left, True)
    L.path(right, True)
    T.fill(left)
    T.fill(right)
    A.fill(rrect(124, 106, 136, 130, 5))


def i_tic_tac_toe(L, A, T, w):
    for v in (58, 102):
        L.line(v, 16, v, 144)
        L.line(16, v, 144, v)
    for cx, cy in ((36, 36), (124, 124)):
        L.line(cx - 10, cy - 10, cx + 10, cy + 10)
        L.line(cx + 10, cy - 10, cx - 10, cy + 10)
    A.ring(124, 36, 12)


def i_app(L, A, T, w):
    for x0, y0 in ((16, 16), (16, 88), (88, 88)):
        L.box(x0, y0, x0 + 56, y0 + 56, 15)
        T.fill(rrect(x0, y0, x0 + 56, y0 + 56, 15))
    A.ring(116, 44, 26)


def i_circuit_saver(L, A, T, w):
    chip = rrect(54, 54, 106, 106, 10)
    L.path(chip, True)
    T.fill(chip)
    L.path([(70, 54), (70, 32), (48, 32)])
    L.ring(36, 32, 9)
    L.path([(106, 70), (128, 70), (128, 48)])
    L.ring(128, 36, 9)
    L.path([(54, 90), (32, 90), (32, 112)])
    L.ring(32, 124, 9)
    L.path([(90, 106), (90, 126), (114, 126)])
    A.dot(128, 126, 10)


def i_word_of_day(L, A, T, w):
    left = bez((80, 52), (60, 40), (36, 38), (16, 44)) + [(16, 124)] + bez((16, 124), (36, 118), (60, 120), (80, 132))[1:]
    right = [(160 - x, y) for x, y in left]
    L.path(left, True)
    L.path(right, True)
    T.fill(left)
    T.fill(right)
    A.fill(sparkle(80, 22, 12, 0.2))


def i_joke(L, A, T, w):
    hat = ([(30, 112)] + bez((30, 112), (26, 84), (20, 66), (18, 50))[1:] + bez((18, 50), (36, 60), (48, 72), (54, 86))[1:]
           + bez((54, 86), (62, 64), (72, 46), (80, 30))[1:] + bez((80, 30), (88, 46), (98, 64), (106, 86))[1:]
           + bez((106, 86), (112, 72), (124, 60), (142, 50))[1:] + bez((142, 50), (140, 66), (134, 84), (130, 112))[1:])
    L.path(hat, True)
    T.fill(hat)
    L.box(26, 112, 134, 136, 10)
    L.ring(16, 40, 7)
    L.ring(144, 40, 7)
    A.dot(80, 18, 8)


def i_dance(L, A, T, w):
    L.line(80, 14, 80, 40)
    ball = circle(80, 92, 52)
    L.path(ball, True)
    T.fill(ball)
    for x in (58, 102):
        h = math.sqrt(52 ** 2 - (x - 80) ** 2)
        L.line(x, 92 - h + 3, x, 92 + h - 3)
    for y in (70, 114):
        h = math.sqrt(52 ** 2 - (y - 92) ** 2)
        L.line(80 - h + 3, y, 80 + h - 3, y)
    A.fill(sparkle(136, 36, 14, 0.2))


def i_surprise(L, A, T, w):
    box = rrect(26, 78, 134, 144, 8)
    lid = rrect(16, 56, 144, 80, 8)
    L.path(box, True)
    L.path(lid, True)
    T.fill(box)
    T.fill(lid)
    L.line(80, 80, 80, 144)
    A.path(bez((80, 54), (62, 14), (34, 40), (80, 54)), True)
    A.path(bez((80, 54), (98, 14), (126, 40), (80, 54)), True)


def cloud_parts():
    return [circle(48, 106, 22), circle(82, 88, 32), circle(118, 106, 22)], rrect(30, 96, 136, 130, 17)


def i_weather(L, A, T, w):
    sun = (54, 54)
    A.ring(sun[0], sun[1], 22)
    for deg in range(0, 360, 45):
        a = math.radians(deg)
        A.line(sun[0] + 32 * math.cos(a), sun[1] + 32 * math.sin(a), sun[0] + 42 * math.cos(a), sun[1] + 42 * math.sin(a))
    bumps, base = cloud_parts()
    for shape in bumps + [base]:
        A.erase(shape, w * 1.05)
        T.fill(shape)
        L.path(shape, True)
    # Keep only the outer outline: clear the inner parts of every outline.
    inner_bumps = [circle(48, 106, 22 - w * 0.5), circle(82, 88, 32 - w * 0.5), circle(118, 106, 22 - w * 0.5)]
    for shape in inner_bumps + [rrect(30 + w * 0.5, 96 + w * 0.5, 136 - w * 0.5, 130 - w * 0.5, 17 - w * 0.5)]:
        L.erase(shape)


def i_calendar(L, A, T, w):
    page = rrect(16, 30, 144, 142, 14)
    L.path(page, True)
    T.fill(page)
    L.line(16, 60, 144, 60)
    L.line(48, 18, 48, 42)
    L.line(112, 18, 112, 42)
    for x in (48, 80):
        for y in (86, 116):
            L.dot(x, y, 6)
    L.dot(112, 86, 6)
    A.fill(rrect(102, 106, 122, 126, 5))


def i_commute(L, A, T, w):
    body = rrect(14, 80, 146, 118, 14)
    cabin = [(38, 80), (56, 50), (108, 50), (128, 80)]
    L.path(cabin)
    L.path(body, True)
    T.fill(body)
    T.fill(cabin)
    for cx in (46, 114):
        L.erase(circle(cx, 120, 19), w * 0.6)
        T.erase(circle(cx, 120, 19), w * 0.5)
        L.ring(cx, 120, 16)
    L.line(82, 50, 82, 80)
    A.dot(136, 94, 5.5)


def i_news(L, A, T, w):
    page = rrect(34, 16, 146, 144, 12)
    L.path(page, True)
    T.fill(page)
    L.path([(34, 50), (14, 50), (14, 126)] + bez((14, 126), (14, 138), (22, 144), (34, 144))[1:])
    A.line(54, 42, 126, 42, width=w * 1.5)
    L.line(54, 74, 126, 74)
    L.line(54, 98, 126, 98)
    L.line(54, 122, 100, 122)


def i_time(L, A, T, w):
    L.path([(58, 46), (64, 14), (96, 14), (102, 46)])
    L.path([(58, 114), (64, 146), (96, 146), (102, 114)])
    L.ring(80, 80, 40)
    T.fill(circle(80, 80, 40))
    L.path([(80, 58), (80, 80), (98, 92)])
    A.fill(rrect(121, 70, 133, 90, 4))


def i_date(L, A, T, w):
    page = [(24, 30), (136, 30), (136, 112), (108, 142), (24, 142)]
    L.path(page, True)
    T.fill(page)
    L.line(54, 18, 54, 42)
    L.line(106, 18, 106, 42)
    L.line(24, 58, 136, 58)
    L.line(46, 84, 92, 84)
    L.line(46, 110, 76, 110)
    A.fill([(112, 116), (132, 116), (112, 136)])


def i_timer(L, A, T, w):
    L.line(34, 16, 126, 16)
    L.line(34, 144, 126, 144)
    left = bez((46, 16), (46, 56), (76, 62), (76, 80)) + bez((76, 80), (76, 98), (46, 104), (46, 144))[1:]
    right = [(160 - x, y) for x, y in left]
    L.path(left)
    L.path(right)
    T.fill(left + right[::-1])
    A.fill([(58, 136), (102, 136), (80, 114)])
    A.line(80, 92, 80, 106, width=w * 0.7)


def i_alarm(L, A, T, w):
    for sx in (-1, 1):
        cx, cy = 80 + sx * 44, 38
        cap = rotate(arc(cx, cy + 6, 20, 180, 360, 6) + [(cx + 20, cy + 6)], cx, cy + 6, sx * 34)
        L.path(cap, True)
        T.fill(cap)
    face = circle(80, 92, 48)
    L.erase(face, w * 0.9)
    T.erase(face, w * 0.5)
    L.path(face, True)
    T.fill(face)
    L.line(50, 130, 40, 146)
    L.line(110, 130, 120, 146)
    L.path([(80, 66), (80, 92), (100, 104)])
    A.dot(80, 92, 6)


def i_yoga_sun(L, A, T, w):
    L.line(14, 118, 146, 118)
    L.line(44, 140, 116, 140)
    half = arc(80, 118, 38, 180, 360)
    L.path(half)
    T.fill(half)
    for deg in (210, 240, 270, 300, 330):
        a = math.radians(deg)
        A.line(80 + 52 * math.cos(a), 118 + 52 * math.sin(a), 80 + 66 * math.cos(a), 118 + 66 * math.sin(a))


def i_yoga_warrior(L, A, T, w):
    shield = ([(30, 28)] + bez((30, 28), (54, 20), (106, 20), (130, 28))[1:] + bez((130, 28), (132, 92), (110, 128), (80, 146))[1:]
              + bez((80, 146), (50, 128), (28, 92), (30, 28))[1:])
    L.path(shield, True)
    T.fill(shield)
    A.path([(56, 66), (80, 90), (104, 66)], width=w * 1.1)
    L.line(80, 102, 80, 118)


def i_volume(L, A, T, w):
    speaker = [(18, 62), (44, 62), (76, 34), (76, 126), (44, 98), (18, 98)]
    L.path(speaker, True)
    T.fill(speaker)
    A.path(arc(78, 80, 26, -45, 45))
    L.path(arc(78, 80, 50, -50, 50))


def i_wifi(L, A, T, w):
    for r in (92, 62, 32):
        L.path(arc(80, 124, r, 228, 312))
    T.fill([(80, 124)] + arc(80, 124, 92, 228, 312))
    A.dot(80, 124, 9.5)


def i_battery(L, A, T, w):
    body = rrect(14, 46, 132, 114, 14)
    L.path(body, True)
    T.fill(body)
    L.line(144, 68, 144, 92, width=w * 1.2)
    A.fill([(82, 54), (54, 86), (74, 86), (66, 108), (98, 74), (78, 74), (88, 54)])


def i_about(L, A, T, w):
    L.ring(80, 80, 62)
    T.fill(circle(80, 80, 62))
    L.line(80, 74, 80, 114)
    A.dot(80, 48, 8)


def i_updates(L, A, T, w):
    L.path(arc(80, 80, 56, 200, 330))
    end = (80 + 56 * math.cos(math.radians(330)), 80 + 56 * math.sin(math.radians(330)))
    L.path([(end[0] - 20, end[1] - 4), end, (end[0] + 2, end[1] - 22)])
    L.path(arc(80, 80, 56, 20, 150))
    end = (80 + 56 * math.cos(math.radians(150)), 80 + 56 * math.sin(math.radians(150)))
    L.path([(end[0] + 20, end[1] + 4), end, (end[0] - 2, end[1] + 22)])
    T.fill(circle(80, 80, 44))
    A.line(80, 58, 80, 100)
    A.path([(66, 86), (80, 100), (94, 86)])


def i_home_assistant(L, A, T, w):
    L.path([(14, 80), (80, 22), (146, 80)])
    walls = [(32, 64), (32, 142), (128, 142), (128, 64)]
    L.path(walls)
    T.fill([(32, 64), (80, 22), (128, 64), (128, 142), (32, 142)])
    A.dot(80, 120, 7.5)
    A.path(arc(80, 120, 22, 228, 312))
    A.path(arc(80, 120, 40, 232, 308))


def i_themes(L, A, T, w):
    def swatch(deg):
        return rotate(rrect(58, 26, 102, 136, 12), 80, 128, deg)
    back_left, back_right, front = swatch(-26), swatch(26), swatch(0)
    for shape in (back_left, back_right):
        L.path(shape, True)
        T.fill(shape)
    L.erase(front, w * 1.05)
    T.erase(front, w * 0.5)
    L.path(front, True)
    T.fill(front)
    A.fill(rrect(66, 34, 94, 58, 6))
    L.line(68, 110, 92, 110)


ICONS = {
    'introduction': i_introduction, 'things-to-do': i_things_to_do, 'fun': i_fun, 'clock': i_clock, 'report': i_report,
    'music': i_music, 'camera': i_camera, 'gallery': i_gallery, 'photobooth': i_photobooth, 'yoga': i_yoga,
    'tutorial': i_tutorial, 'settings': i_settings, 'agent': i_agent, 'spotify': i_spotify, 'tic-tac-toe': i_tic_tac_toe,
    'app': i_app, 'circuit-saver': i_circuit_saver, 'word-of-day': i_word_of_day, 'joke': i_joke, 'dance': i_dance,
    'surprise': i_surprise, 'weather': i_weather, 'calendar': i_calendar, 'commute': i_commute, 'news': i_news,
    'time': i_time, 'date': i_date, 'timer': i_timer, 'alarm': i_alarm, 'yoga-sun': i_yoga_sun,
    'yoga-warrior': i_yoga_warrior, 'volume': i_volume, 'wifi': i_wifi, 'battery': i_battery, 'about': i_about,
    'updates': i_updates, 'home-assistant': i_home_assistant, 'themes': i_themes,
}
assert sorted(ICONS) == sorted(STEMS) and len(STEMS) == 38

# ---------------------------------------------------------------------------
# Raster helpers for backgrounds and previews (float RGB canvases)
# ---------------------------------------------------------------------------

BAYER = np.array([[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38],
                  [60, 28, 52, 20, 62, 30, 54, 22], [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
                  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]], dtype=np.float64) / 64.0 - 0.5 + 1 / 128.0


def quantize(rgb, dither=True):
    """Float RGB 0..255 to uint8, with an ordered dither against banding."""
    if dither:
        h, w = rgb.shape[:2]
        tile = np.tile(BAYER, (h // 8 + 1, w // 8 + 1))[:h, :w]
        rgb = rgb + tile[..., None]
    return np.clip(np.rint(rgb), 0, 255).astype(np.uint8)


def mask(width, height, draw_fn, ss=4):
    """Anti-aliased coverage (0..1) of shapes drawn by draw_fn(draw, k)."""
    img = Image.new('L', (width * ss, height * ss), 0)
    draw_fn(ImageDraw.Draw(img), ss)
    return np.asarray(img.reduce(ss), dtype=np.float64) / 255.0


def paint(canvas, m, fill, opacity=1.0):
    fill = np.asarray(fill, dtype=np.float64)
    if fill.ndim == 1:
        fill = fill[None, None, :]
    a = (m * opacity)[..., None]
    canvas *= (1 - a)
    canvas += fill * a


def solid(width, height, rgb):
    return np.ones((height, width, 3)) * np.asarray(rgb, dtype=np.float64)[None, None, :]


def thick_polyline(draw, pts, width, k, closed=False):
    r = width * k / 2
    P = [(x * k, y * k) for x, y in pts]
    pairs = list(zip(P, P[1:])) + ([(P[-1], P[0])] if closed else [])
    for (x0, y0), (x1, y1) in pairs:
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 1e-9:
            continue
        nx, ny = -(y1 - y0) / length * r, (x1 - x0) / length * r
        draw.polygon([(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)], fill=255)
    for x, y in P:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=255)


class Lcg:
    """Tiny deterministic generator (no global random state)."""

    def __init__(self, seed):
        self.state = seed & 0xFFFFFFFF

    def next(self):
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 4294967296.0


# ---------------------------------------------------------------------------
# Backgrounds (1280 x 720; drawn by the robot at 0.22 / 0.18 opacity)
# ---------------------------------------------------------------------------


def background(theme):
    p = PALETTES[theme]
    ys, xs = np.mgrid[0:BG_H, 0:BG_W].astype(np.float64)
    if theme == 'ember':
        base = np.asarray(hexrgb(p['background']), dtype=np.float64)
        canvas = solid(BG_W, BG_H, base)
        # A low, wide sunrise halo behind the central menu: amber core, copper falloff.
        d2 = ((xs - 640) / 600.0) ** 2 + ((ys - 470) / 330.0) ** 2
        halo = np.exp(-d2 * 2.1)
        copper = np.exp(-d2 * 0.9) * 0.55
        paint(canvas, np.clip(copper, 0, 1), (150, 72, 38))
        paint(canvas, np.clip(halo, 0, 1) * 0.92, hexrgb(p['accent']))

        def rings(draw, k):
            for i, (rx, ry) in enumerate(((430, 236), (520, 290), (610, 344))):
                pts = arc(640, 560, rx, 196, 344, 1.0, ry=ry)
                thick_polyline(draw, pts, 2.4 - i * 0.4, k)
        m = mask(BG_W, BG_H, rings)
        fade = np.clip(1.0 - np.abs(xs - 640) / 640.0, 0, 1) ** 1.4
        paint(canvas, m * fade, hexrgb(p['accent']), 0.55)
        # Edges settle into the field so nothing important sits in the corners.
        vignette = np.clip((((xs - 640) / 700.0) ** 2 + ((ys - 360) / 460.0) ** 2) - 0.55, 0, 1)
        paint(canvas, vignette, base, 0.8)
    else:
        base = np.asarray(hexrgb(p['background']), dtype=np.float64)
        canvas = solid(BG_W, BG_H, base)
        glow = np.exp(-(((xs - 640) / 760.0) ** 2 + ((ys - 640) / 420.0) ** 2) * 1.6)
        paint(canvas, glow, hexrgb(p['surface']), 0.9)
        rng = Lcg(0x0B17)

        def stars(draw, k):
            for _ in range(150):
                x, y = rng.next() * BG_W, rng.next() * BG_H
                r = 0.7 + rng.next() * 1.3
                draw.ellipse([(x - r) * k, (y - r) * k, (x + r) * k, (y + r) * k], fill=int(110 + rng.next() * 145))
        paint(canvas, mask(BG_W, BG_H, stars), (235, 248, 255), 0.85)
        orbits = ((640, 470, 620, 150, -9), (640, 470, 470, 112, -9), (640, 470, 330, 76, -9))

        def ellipses(draw, k):
            for cx, cy, rx, ry, rot in orbits:
                thick_polyline(draw, arc(cx, cy, rx, 0, 360, 0.5, ry=ry, rot=rot), 2.6, k, closed=True)
        m = mask(BG_W, BG_H, ellipses)
        # Fade the far side of each orbit and the outer reaches.
        fade = np.clip(0.35 + (ys - 300) / 300.0, 0.2, 1.0) * np.clip(1.15 - np.abs(xs - 640) / 700.0, 0, 1)
        paint(canvas, m * fade, hexrgb(p['accent']), 0.75)

        def bodies(draw, k):
            for cx, cy, rx, ry, rot, deg, r in ((640, 470, 620, 150, -9, 200, 9), (640, 470, 470, 112, -9, 22, 7), (640, 470, 330, 76, -9, 140, 5)):
                x, y = arc(cx, cy, rx, deg, deg, 1, ry=ry, rot=rot)[0]
                draw.ellipse([(x - r) * k, (y - r) * k, (x + r) * k, (y + r) * k], fill=255)
        paint(canvas, mask(BG_W, BG_H, bodies), hexrgb(p['accent']))
    return quantize(canvas)


# ---------------------------------------------------------------------------
# Previews (720 x 720): Main, Clock and Settings menus in the theme
# ---------------------------------------------------------------------------

LABELS = {'fun': 64, 'clock': 70, 'music': 76, 'things-to-do': 96, 'camera': 80, 'settings': 88, 'time': 52, 'date': 50,
          'timer': 60, 'alarm': 58, 'volume': 72, 'wifi': 50, 'themes': 74}


def place_icon(canvas, stem, theme, cx, cy, box):
    """Composite a pictogram rendered natively at `box` pixels."""
    size = int(math.ceil(box * ICON / BOX))
    size += size % 2
    rgba = render_icon(stem, theme, out=size, box=box).astype(np.float64) / 255.0
    x0, y0 = int(round(cx - size / 2)), int(round(cy - size / 2))
    h, w = canvas.shape[:2]
    sx0, sy0 = max(0, -x0), max(0, -y0)
    ex, ey = min(size, w - x0), min(size, h - y0)
    region = canvas[y0 + sy0:y0 + ey, x0 + sx0:x0 + ex]
    src = rgba[sy0:ey, sx0:ex]
    a = src[..., 3:4]
    region *= (1 - a)
    region += src[..., :3] * 255.0 * a


def screen_layer(theme, bg_image, x0, y0, x1, y1):
    """The robot screen: backing colour plus the background art at its opacity."""
    p = PALETTES[theme]
    w, h = x1 - x0, y1 - y0
    scaled = np.asarray(Image.fromarray(bg_image).resize((w, h), Image.Resampling.LANCZOS), dtype=np.float64)
    backing = solid(w, h, hexrgb(p['background']))
    return backing * (1 - OPACITY[theme] * 1.6) + scaled * OPACITY[theme] * 1.6


def preview(theme, bg_image):
    p = PALETTES[theme]
    acc, text, muted = hexrgb(p['accent']), hexrgb(p['text']), hexrgb(p['mutedText'])
    ys, xs = np.mgrid[0:PREVIEW, 0:PREVIEW].astype(np.float64)
    frame = np.asarray(hexrgb(p['background']), dtype=np.float64) * 0.72
    canvas = solid(PREVIEW, PREVIEW, frame)
    glow = np.exp(-(((xs - 360) / 420.0) ** 2 + ((ys - 300) / 300.0) ** 2) * 1.4)
    paint(canvas, glow, hexrgb(p['surfaceSecondary']), 0.9)
    screens = [('main', 36, 52, 684, 416), ('clock', 36, 440, 352, 618), ('settings', 368, 440, 684, 618)]
    items = {'ember': {'main': ['fun', 'clock', 'music'], 'clock': ['time', 'timer', 'alarm'], 'settings': ['volume', 'wifi', 'themes']},
             'orbit': {'main': ['things-to-do', 'music', 'clock', 'camera', 'settings'], 'clock': ['date', 'time', 'timer', 'alarm', 'clock'],
                       'settings': ['about', 'wifi', 'themes', 'volume', 'updates']}}[theme]
    icon_jobs = []
    for name, x0, y0, x1, y1 in screens:
        w, h = x1 - x0, y1 - y0
        s = w / 1280.0
        radius = 34 if name == 'main' else 24
        shape = mask(PREVIEW, PREVIEW, lambda d, k: d.rounded_rectangle([x0 * k, y0 * k, x1 * k, y1 * k], radius * k, fill=255))
        layer = np.zeros_like(canvas)
        layer[y0:y1, x0:x1] = screen_layer(theme, bg_image, x0, y0, x1, y1)
        # Everything inside a screen is clipped to it.
        inner = canvas.copy()
        inner[y0:y1, x0:x1] = layer[y0:y1, x0:x1]
        title_w = (300 if name == 'main' else 200) * s
        bar = mask(PREVIEW, PREVIEW, lambda d, k: d.rounded_rectangle([(x0 + w / 2 - title_w / 2) * k, (y0 + 70 * s) * k,
                                                                      (x0 + w / 2 + title_w / 2) * k, (y0 + 104 * s) * k], 17 * s * k, fill=255))
        paint(inner, bar, muted, 0.55)
        if theme == 'ember':
            r = 150 * s
            for i, stem in enumerate(items[name]):
                cx, cy = x0 + (240 + 400 * i) * s, y0 + 370 * s
                if i == 1:
                    ring = mask(PREVIEW, PREVIEW, lambda d, k: d.ellipse([(cx - r - 16 * s) * k, (cy - r - 16 * s) * k, (cx + r + 16 * s) * k,
                                                                          (cy + r + 16 * s) * k], outline=255, width=max(1, int(round(9 * s * k)))))
                    paint(inner, ring, acc)
                disc = mask(PREVIEW, PREVIEW, lambda d, k: d.ellipse([(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k], fill=255))
                t = np.clip((ys - (cy - r)) / (2 * r), 0, 1)[..., None]
                grad = np.asarray(hexrgb(p['surface']), dtype=np.float64) * (1 - t) + np.asarray(hexrgb(p['surfaceSecondary']), dtype=np.float64) * t
                paint(inner, disc, grad)
                rise = np.exp(-(((xs - cx) / (r * 0.9)) ** 2 + ((ys - (cy + r * 0.95)) / (r * 0.55)) ** 2) * 1.5)
                paint(inner, disc * rise, acc, 0.45)
                label_w = LABELS[stem] * 2.2 * s
                lab = mask(PREVIEW, PREVIEW, lambda d, k: d.rounded_rectangle([(cx - label_w / 2) * k, (cy + r + 44 * s) * k, (cx + label_w / 2) * k,
                                                                              (cy + r + 78 * s) * k], 17 * s * k, fill=255))
                paint(inner, lab, text, 0.92)
                icon_jobs.append((stem, cx, cy, int(round(r * 1.12))))
            dots = mask(PREVIEW, PREVIEW, lambda d, k: [d.ellipse([(x0 + w / 2 + dx * s - 9 * s) * k, (y0 + 670 * s) * k, (x0 + w / 2 + dx * s + 9 * s) * k,
                                                                  (y0 + 688 * s) * k], fill=255) for dx in (-40, 0, 40)])
            paint(inner, dots, muted, 0.5)
        else:
            cw, ch, gap = 240 * s, 264 * s, 24 * s
            focus = len(items[name]) // 2
            for i, stem in enumerate(items[name]):
                cx, cy = x0 + w / 2 + (i - focus) * (cw + gap), y0 + 392 * s
                bx0, by0, bx1, by1 = cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2
                if i == focus:
                    ring = mask(PREVIEW, PREVIEW, lambda d, k: d.rounded_rectangle([(bx0 - 14 * s) * k, (by0 - 14 * s) * k, (bx1 + 14 * s) * k, (by1 + 14 * s) * k],
                                                                                   44 * s * k, outline=255, width=max(1, int(round(8 * s * k)))))
                    paint(inner, ring, acc)
                card = mask(PREVIEW, PREVIEW, lambda d, k: d.rounded_rectangle([bx0 * k, by0 * k, bx1 * k, by1 * k], 32 * s * k, fill=255))
                paint(inner, card, hexrgb(p['surface']))
                band_top = by1 - 76 * s
                band = mask(PREVIEW, PREVIEW, lambda d, k: d.rounded_rectangle([bx0 * k, band_top * k, bx1 * k, by1 * k], 32 * s * k, fill=255,
                                                                               corners=(False, False, True, True)))
                paint(inner, band, hexrgb(p['surfaceSecondary']))
                label_w = LABELS.get(stem, 70) * 1.9 * s
                lab = mask(PREVIEW, PREVIEW, lambda d, k: d.rounded_rectangle([(cx - label_w / 2) * k, (band_top + 22 * s) * k, (cx + label_w / 2) * k,
                                                                              (band_top + 52 * s) * k], 15 * s * k, fill=255))
                paint(inner, lab, text, 0.92)
                icon_jobs.append((stem, cx, by0 + 100 * s, int(round(150 * s))))
        paint(canvas, shape, inner)
        edge = mask(PREVIEW, PREVIEW, lambda d, k: d.rounded_rectangle([x0 * k, y0 * k, x1 * k, y1 * k], radius * k, outline=255, width=max(1, int(1.5 * k))))
        paint(canvas, edge, muted, 0.16)
        # Icons are clipped to their screen too.
        clip = canvas.copy()
        for stem, cx, cy, box in icon_jobs:
            place_icon(clip, stem, theme, cx, cy, box)
        paint(canvas, shape, clip)
        icon_jobs = []
    swatches = ['background', 'surface', 'surfaceSecondary', 'text', 'mutedText', 'accent']
    for i, key in enumerate(swatches):
        cx = 360 + (i - 2.5) * 34
        sw = mask(PREVIEW, PREVIEW, lambda d, k: d.ellipse([(cx - 11) * k, (668 - 11) * k, (cx + 11) * k, (668 + 11) * k], fill=255))
        rim = mask(PREVIEW, PREVIEW, lambda d, k: d.ellipse([(cx - 12.5) * k, (668 - 12.5) * k, (cx + 12.5) * k, (668 + 12.5) * k], fill=255))
        paint(canvas, rim, muted, 0.35)
        paint(canvas, sw, hexrgb(p[key]))
    return quantize(canvas)


# ---------------------------------------------------------------------------
# Output, checks and review sheets
# ---------------------------------------------------------------------------


def outputs(theme):
    bg = background(theme)
    files = {'assets/background.png': Image.fromarray(bg, 'RGB'), 'assets/preview.png': Image.fromarray(preview(theme, bg), 'RGB')}
    for stem in STEMS:
        files['assets/icons/%s.png' % stem] = Image.fromarray(render_icon(stem, theme), 'RGBA')
    return files


def save_png(image, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    image.save(path, format='PNG', compress_level=9, optimize=False)


def check_icon(rgba):
    alpha = rgba[..., 3]
    lo, hi = (ICON - BOX) // 2, (ICON + BOX) // 2
    outside = alpha.copy()
    outside[lo:hi, lo:hi] = 0
    return {'outside': int(outside.max()), 'opaque': int((alpha >= 250).sum()), 'visible': int((alpha > 0).sum())}


def contrast(a, b):
    def lum(c):
        ch = [x / 255.0 for x in hexrgb(c)]
        ch = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in ch]
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
    x, y = lum(a), lum(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)


def validate(theme, files, sizes):
    problems = []
    manifest = json.load(open(os.path.join(HERE, theme, 'theme.json')))
    paths = {a['path'] for a in manifest['assets']}
    if paths != set(files):
        problems.append('theme.json assets differ from the generated files')
    if manifest['theme']['palette'] != PALETTES[theme]:
        problems.append('palette differs from the example palette')
    pixels = 0
    for rel, image in files.items():
        w, h = image.size
        pixels += w * h
        if sizes.get(rel, 0) > 1048576:
            problems.append('%s is larger than 1 MiB' % rel)
        if rel.startswith('assets/icons/'):
            if image.mode != 'RGBA' or image.size != (ICON, ICON):
                problems.append('%s is not a 256x256 RGBA icon' % rel)
            stats = check_icon(np.asarray(image))
            if stats['outside'] or stats['opaque'] < 600:
                problems.append('%s: drawing leaves the centered 160x160 area or is empty (%r)' % (rel, stats))
    if pixels > 4194304:
        problems.append('total pixels %d exceed 4194304' % pixels)
    p = PALETTES[theme]
    for key in ('surface', 'surfaceSecondary', 'background'):
        for fg in ('text', 'mutedText'):
            if contrast(p[fg], p[key]) < 4.5:
                problems.append('%s on %s below 4.5:1' % (fg, key))
    if contrast(p['accent'], p['surface']) < 3:
        problems.append('accent on surface below 3:1')
    return problems, pixels


def sheet(theme, files, path):
    """Contact sheet: every icon on the theme's own button or card."""
    from PIL import ImageFont
    p = PALETTES[theme]
    cols, cell = 8, 168
    rows = int(math.ceil(len(STEMS) / cols))
    img = Image.new('RGB', (cols * cell, rows * (cell + 26) + 16), hexrgb(p['background']))
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(14)
    for i, stem in enumerate(STEMS):
        x, y = (i % cols) * cell, (i // cols) * (cell + 26) + 8
        if theme == 'ember':
            draw.ellipse([x + 12, y + 8, x + cell - 12, y + cell - 16], fill=hexrgb(p['surface']))
        else:
            draw.rounded_rectangle([x + 14, y + 4, x + cell - 14, y + cell - 12], 22, fill=hexrgb(p['surface']))
        icon = files['assets/icons/%s.png' % stem].resize((150, 150), Image.Resampling.LANCZOS)
        img.paste(icon, (x + (cell - 150) // 2, y + (cell - 150) // 2 - 4), icon)
        draw.text((x + cell / 2, y + cell + 2), stem, fill=hexrgb(p['mutedText']), font=font, anchor='mt')
    img.save(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build the Ember and Orbit theme art.')
    parser.add_argument('--check', action='store_true', help='compare with committed PNGs instead of writing')
    parser.add_argument('--sheets', metavar='DIR', help='write review sheets and copies here')
    parser.add_argument('--theme', choices=sorted(PALETTES), action='append')
    args = parser.parse_args(argv)
    report, failed = {}, False
    for theme in args.theme or sorted(PALETTES):
        files = outputs(theme)
        root = os.path.join(HERE, theme)
        sizes = {}
        mismatched = []
        for rel, image in files.items():
            target = os.path.join(root, rel)
            if args.check:
                if not os.path.exists(target):
                    mismatched.append(rel)
                    continue
                committed = Image.open(target)
                if committed.mode != image.mode or committed.size != image.size or not np.array_equal(np.asarray(committed), np.asarray(image)):
                    mismatched.append(rel)
            else:
                save_png(image, target)
            sizes[rel] = os.path.getsize(target) if os.path.exists(target) else 0
        problems, pixels = validate(theme, files, sizes)
        if mismatched:
            problems.append('pixels differ from the committed files: %s' % ', '.join(sorted(mismatched)))
        failed = failed or bool(problems)
        report[theme] = {'images': len(files), 'icons': len(STEMS), 'pixels': pixels, 'bytes': sum(sizes.values()),
                         'largest': max(sizes.items(), key=lambda kv: kv[1]), 'problems': problems}
        if args.sheets:
            os.makedirs(args.sheets, exist_ok=True)
            sheet(theme, files, os.path.join(args.sheets, '%s-icons.png' % theme))
            files['assets/background.png'].save(os.path.join(args.sheets, '%s-background.png' % theme))
            files['assets/preview.png'].save(os.path.join(args.sheets, '%s-preview.png' % theme))
    print(json.dumps(report, indent=2))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
