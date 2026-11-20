#!/usr/bin/env python3
"""
Re-lays out every DYMO label template the app uses (labels/*.dymo) on one clean grid, from the ORIGINAL templates in ./original.

    python3 scripts/label-design/relayout.py            # writes labels/*.dymo and docs/label-design/preview.html
    python3 scripts/label-design/relayout.py --check    # only prints the audit (bounds, overlaps, minimum sizes)

What it changes: only GEOMETRY and TYPE of the objects the app already fills (position, size, font size, alignment, rotation), the page of the
70x54 designs 1, 3 and 4, and a few thin divider lines. Object NAMES, kinds, barcode/QR settings and the fit mode (AlwaysFit) are untouched, so the
plan in src/main/printing/dymo/plan.js fills exactly the same objects as before (tests/dymo/templates.test.js proves it).
All coordinates below are millimetres from the top-left corner of the printable page. DYMO stores inches, relative to the page rectangle.

The preview (docs/label-design/preview.html) is drawn from the .dymo files with an approximation of DYMO's "always fit" text; it is a design aid,
not a printer: print one label of every design on a real DYMO before using a new layout in a shop.
"""
import html
import math
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ORIG = os.path.join(HERE, 'original')
OUT = os.path.join(ROOT, 'labels')
MM = 25.4

# ----------------------------------------------------------------------------------------------------------------------------------
# the layout of every template: name -> (x, y, w, h, font pt, horizontal L|C|R, vertical T|M|B)         lines: ('H'|'V', x, y, length)
# ----------------------------------------------------------------------------------------------------------------------------------
def t(x, y, w, h, fs, ha='L', va='M'):
    return (x, y, w, h, fs, ha, va)

def box(x, y, w, h):  # barcode, QR, shapes: no type
    return (x, y, w, h, None, None, None)

M32 = 1.5  # side margin of the 32x57 labels
W32 = 55.1 - 2 * M32
TITLE32 = t(M32, 0.4, W32, 6.9, 15, 'C', 'M')
FOOT32 = {'BARCODE': box(4.0, 22.4, 47.1, 3.4), 'TextObject1': t(9.5, 25.9, 36.1, 2.6, 6, 'C', 'M')}

M70 = 2.0
W70 = 62.7 - 2 * M70
TITLE70 = t(M70, 1.8, W70, 10.4, 20, 'C', 'M')

def rows(names, x, y0, w, h, pitch, fs, ha='L'):
    return {n: t(x, y0 + i * pitch, w, h, fs, ha, 'M') for i, n in enumerate(names)}

SPEC5 = ['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5', 'TEXT__1']

LAYOUTS = {
    # ------------------------------------------------------------------------------------------------ 25 x 25
    '25_25_barcode.dymo': {
        'objects': {'TextObject1': t(1.0, 0.8, 20.9, 8.8, 20, 'C', 'M'), 'BarcodeObject0': box(1.2, 10.2, 20.5, 10.3)},
    },
    '25_25_qrcode.dymo': {
        'objects': {'TextObject2': t(1.0, 0.8, 20.9, 7.4, 18, 'C', 'M'), 'QRCodeObject2': box(6.4, 8.3, 10.1, 10.1), 'TextObject3': t(2.5, 18.6, 17.9, 2.4, 6.5, 'C', 'M')},
    },
    # ------------------------------------------------------------------------------------------------ 32 x 57
    'Labeldesign1_1.dymo': {
        'objects': {
            'ItemNameVal': TITLE32,
            **rows(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5'], M32, 8.2, 25.0, 3.3, 3.4, 8.5),
            'TEXT__1': t(27.5, 8.2, 26.1, 3.3, 8.5, 'R', 'M'),
            'TEXT_3': t(27.5, 11.7, 26.1, 6.6, 18, 'R', 'M'),
            'TextObject11': t(27.5, 18.5, 26.1, 3.4, 7.5, 'R', 'M'),
            **FOOT32,
        },
        'lines': {'LineTitle': ('H', M32, 7.75, W32)},
    },
    'Labeldesign_sale.dymo': {
        'objects': {
            'ItemNameVal': TITLE32,
            **rows(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5'], M32, 8.2, 25.0, 3.3, 3.4, 8.5),
            'Text_was': t(27.5, 8.2, 11.5, 3.3, 8.5, 'L', 'M'),
            'TEXT__1': t(39.5, 8.2, 14.1, 3.3, 8, 'R', 'M'),
            'TEXT_3': t(27.5, 11.7, 26.1, 6.6, 18, 'R', 'M'),
            'TextObject11': t(27.5, 18.5, 26.1, 3.4, 7.5, 'R', 'M'),
            **FOOT32,
        },
        'lines': {'LineTitle': ('H', M32, 7.75, W32)},
        'strike': {'LineObject0': ('H', 27.5, 8.2 + 1.65, 11.5)},
    },
    'Labeldesign2.dymo': {
        'objects': {
            'ItemNameVal': TITLE32,
            **rows(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5'], M32, 8.2, 17.5, 3.5, 3.7, 8.5),
            'TEXT_3': t(19.8, 8.2, 20.9, 8.8, 22, 'C', 'M'),
            'TEXT__1': t(19.8, 17.3, 20.9, 4.0, 10, 'C', 'M'),
            'QRCodeObject0': box(42.4, 8.6, 11.2, 11.2),
            'Text_barcode': t(41.0, 20.0, 13.6, 3.0, 6.5, 'C', 'M'),
            'TextObject11': t(M32, 24.6, W32, 3.6, 8.5, 'L', 'M'),
        },
        'lines': {'LineTitle': ('H', M32, 7.75, W32)},
    },
    'Labeldesign3.dymo': {
        'objects': {
            'ItemNameVal': TITLE32,
            **rows(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5'], M32, 8.2, 17.5, 3.5, 3.7, 8.5),
            'TextObject9': t(19.8, 8.2, 12.6, 3.5, 9, 'L', 'M'),
            'TextObject1': t(33.0, 8.2, 20.6, 3.5, 8, 'R', 'M'),
            'TEXT_3': t(19.8, 11.9, 20.9, 7.2, 20, 'C', 'M'),
            'TEXT__1': t(19.8, 19.3, 20.9, 3.8, 9.5, 'C', 'M'),
            'QRCodeObject0': box(42.4, 12.0, 11.2, 11.2),
            'Text_barcode': t(41.0, 23.4, 13.6, 2.8, 6.5, 'C', 'M'),
            'TextObject11': t(M32, 24.6, 38.0, 3.6, 8.5, 'L', 'M'),
        },
        'lines': {'LineTitle': ('H', M32, 7.75, W32)},
        'strike': {'LineObject0': ('H', 19.8, 8.2 + 1.75, 12.6)},
    },
    'mukltipleBarcode.dymo': {
        'objects': {
            'BarcodeObject0': box(6.0, 0.8, 43.1, 8.2), 'TextObject1': t(M32, 9.2, W32, 4.0, 10, 'C', 'M'),
            'BarcodeObject1': box(6.0, 15.6, 43.1, 8.2), 'TextObject12': t(M32, 24.0, W32, 4.0, 10, 'C', 'M'),
        },
        'cut': {'LineObject0': ('H', 1.0, 14.4, 53.1)},
    },
    'multipleQRCODE.dymo': {
        'objects': {
            'QRCodeObject0': box(1.5 + (16.8 - 11) / 2, 1.2, 11, 11), 'TextObject3': t(1.5, 12.4, 16.8, 2.8, 7, 'C', 'M'), 'TextObject12': t(1.5, 15.6, 16.8, 9.0, 18, 'C', 'M'),
            'QRCodeObject1': box(19.15 + (16.8 - 11) / 2, 1.2, 11, 11), 'TextObject4': t(19.15, 12.4, 16.8, 2.8, 7, 'C', 'M'), 'TextObject1': t(19.15, 15.6, 16.8, 9.0, 18, 'C', 'M'),
            'QRCodeObject2': box(36.8 + (16.8 - 11) / 2, 1.2, 11, 11), 'TextObject5': t(36.8, 12.4, 16.8, 2.8, 7, 'C', 'M'), 'TextObject2': t(36.8, 15.6, 16.8, 9.0, 18, 'C', 'M'),
        },
    },
    'LabeldesignRepair.dymo': {
        'objects': {
            'ItemNameVal': t(M32, 0.5, W32, 4.4, 10, 'L', 'M'),
            'TEXT': t(M32, 5.2, 39.0, 3.2, 8, 'L', 'M'), 'TEXT8': t(M32, 8.5, 39.0, 3.2, 8, 'L', 'M'), 'TEXT9': t(M32, 11.8, 39.0, 3.2, 8, 'L', 'M'),
            'QRCodeObject0': box(43.2, 5.4, 10.4, 10.4), 'TEXT4': t(41.5, 15.9, 13.6, 2.6, 6.5, 'C', 'M'),
            'TextObject5': t(M32, 15.4, 39.0, 3.5, 9, 'L', 'M'), 'TextObject6': t(M32, 18.9, 39.0, 3.8, 10, 'L', 'M'),
            'TextObject7': t(41.5, 19.2, 12.1, 3.5, 9, 'R', 'M'),
            'TEXT_5': t(M32, 22.4, 34.0, 3.1, 8, 'L', 'M'), 'TextObject1': t(M32, 25.6, 34.0, 2.6, 6.5, 'L', 'M'),
            'TextObject10': t(36.5, 23.1, 9.0, 3.2, 7, 'R', 'M'), 'ShapeObject0': box(46.8, 23.1, 3.2, 3.2),
        },
        'lines': {'LineTitle': ('H', M32, 4.95, W32)},
    },
    '25_25_repair.dymo': {
        'base': '25_25_qrcode.dymo',
        'objects': {'TextObject2': t(1.0, 0.6, 20.9, 5.4, 10, 'C', 'M'), 'QRCodeObject2': box(6.2, 6.2, 10.5, 10.5), 'TextObject3': t(1.5, 17.0, 19.9, 3.6, 8, 'C', 'M')},
    },
    'labitemdesign.dymo': {
        'objects': {'TextObject12': t(M32, 1.0, W32, 12.6, 24, 'C', 'M'), 'BarcodeObject1': box(6.0, 15.0, 43.1, 10.8)},
    },
    # ------------------------------------------------------------------------------------------------ 70 x 54 (landscape, 62.7 x 51.6 mm)
    '70_54_Labeldesign1_2_22.dymo': {
        'page': '70_54_Labeldesign2.dymo',
        'objects': {
            'ItemNameVal': TITLE70,
            **rows(SPEC5, M70, 15.2, 32.5, 5.0, 5.4, 13),
            'TEXT_3': t(36.5, 15.6, 24.2, 13.0, 30, 'R', 'M'),
            'TextObject11': t(36.5, 30.5, 24.2, 9.5, 11, 'R', 'T'),
            'BARCODE': box(8.0, 42.6, 46.7, 5.6), 'TextObject1': t(8.0, 48.4, 46.7, 3.0, 8, 'C', 'M'),
        },
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
    },
    '70_54_Labeldesign_sale.dymo': {
        'objects': {
            'ItemNameVal': TITLE70,
            **rows(['TEXT_4', 'TEXT', 'TEXT_1', 'TEXT_5'], M70, 15.2, 32.5, 5.0, 5.4, 13),
            'Text_was': t(36.5, 15.2, 24.2, 5.4, 14, 'R', 'M'),
            'TEXT_3': t(36.5, 21.0, 24.2, 10.5, 26, 'R', 'M'),
            'TEXT__1': t(36.5, 32.0, 24.2, 5.0, 12, 'R', 'M'),
            'TextObject11': t(M70, 38.2, W70, 4.2, 11, 'C', 'M'),
            'BARCODE': box(8.0, 43.2, 46.7, 5.0), 'TextObject1': t(8.0, 48.5, 46.7, 3.0, 8, 'C', 'M'),
        },
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
        'strike': {'LineObject0': ('H', 41.0, 17.9, 19.7)},
    },
    '70_54_Labeldesign2.dymo': {
        'objects': {
            'ItemNameVal': TITLE70,
            **rows(SPEC5, M70, 15.2, 34.0, 4.6, 5.0, 12),
            'QRCodeObject0': box(41.5, 15.2, 19.2, 19.2), 'Text_barcode': t(40.0, 34.8, 22.7, 3.4, 8, 'C', 'M'),
            'TEXT_3': t(M70, 41.2, 36.0, 9.4, 30, 'L', 'M'),
            'TextObject11': t(38.0, 41.4, 22.7, 9.0, 10, 'R', 'M'),
        },
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
    },
    '70_54_Labeldesign3.dymo': {
        'objects': {
            'ItemNameVal': TITLE70,
            **rows(SPEC5, M70, 15.2, 34.0, 4.6, 5.0, 12),
            'QRCodeObject0': box(41.5, 15.2, 19.2, 19.2), 'Text_barcode': t(40.0, 34.8, 22.7, 3.4, 8, 'C', 'M'),
            'TextObject9': t(M70, 40.0, 16.0, 4.4, 12, 'L', 'M'), 'TextObject1': t(18.5, 40.0, 19.0, 4.4, 11, 'L', 'M'),
            'TEXT_3': t(M70, 44.4, 36.0, 7.0, 24, 'L', 'M'),
            'TextObject11': t(38.0, 40.0, 22.7, 11.4, 10, 'R', 'M'),
        },
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
        'strike': {'LineObject0': ('H', M70, 42.2, 14.5)},
    },
    '70_54_LabeldesignRepair.dymo': {
        'page': '70_54_Labeldesign2.dymo', 'base': '70_54_LabeldesignRepair_2.dymo', 'copy': ['TextObject10', 'ShapeObject0'],
        'objects': {
            'ItemNameVal': t(M70, 1.5, W70, 8.0, 16, 'L', 'M'),
            'TEXT': t(M70, 11.2, 40.0, 5.0, 12, 'L', 'M'), 'TEXT8': t(M70, 16.4, 40.0, 5.0, 12, 'L', 'M'), 'TEXT9': t(M70, 21.6, 40.0, 5.0, 12, 'L', 'M'),
            'QRCodeObject0': box(44.5, 11.2, 16.2, 16.2), 'TEXT4': t(43.0, 27.6, 19.2, 3.6, 8, 'C', 'M'),
            'TextObject5': t(M70, 28.4, 40.0, 5.4, 13, 'L', 'M'), 'TextObject6': t(M70, 34.0, 40.0, 5.6, 15, 'L', 'M'),
            'TextObject7': t(44.5, 34.0, 16.2, 5.6, 12, 'R', 'M'),
            'TEXT_5': t(M70, 41.0, 40.0, 4.6, 11, 'L', 'M'), 'TextObject1': t(M70, 45.9, 40.0, 4.0, 9, 'L', 'M'),
            'TextObject10': t(44.5, 41.2, 12.0, 4.4, 10, 'R', 'M'), 'ShapeObject0': box(57.4, 41.4, 3.8, 3.8),
        },
        'lines': {'LineTitle': ('H', M70, 10.2, W70)},
    },
    '70_54_mukltipleBarcode.dymo': {
        'page': '70_54_Labeldesign2.dymo', 'base': 'mukltipleBarcode.dymo',
        'objects': {
            'BarcodeObject0': box(7.0, 2.4, 48.7, 14.6), 'TextObject1': t(M70, 17.4, W70, 6.6, 20, 'C', 'M'),
            'BarcodeObject1': box(7.0, 28.2, 48.7, 14.6), 'TextObject12': t(M70, 43.2, W70, 6.6, 20, 'C', 'M'),
        },
        'cut': {'LineObject0': ('H', 1.0, 26.0, 60.7)},
    },
    '70_54_multipleQRCODE.dymo': {
        'page': '70_54_Labeldesign2.dymo', 'base': 'multipleQRCODE.dymo',
        'objects': {
            'QRCodeObject0': box(1.5 + (19.1 - 18) / 2, 7.0, 18, 18), 'TextObject3': t(1.5, 25.4, 19.1, 4.0, 9, 'C', 'M'), 'TextObject12': t(1.5, 30.4, 19.1, 11.0, 24, 'C', 'M'),
            'QRCodeObject1': box(21.8 + (19.1 - 18) / 2, 7.0, 18, 18), 'TextObject4': t(21.8, 25.4, 19.1, 4.0, 9, 'C', 'M'), 'TextObject1': t(21.8, 30.4, 19.1, 11.0, 24, 'C', 'M'),
            'QRCodeObject2': box(42.1 + (19.1 - 18) / 2, 7.0, 18, 18), 'TextObject5': t(42.1, 25.4, 19.1, 4.0, 9, 'C', 'M'), 'TextObject2': t(42.1, 30.4, 19.1, 11.0, 24, 'C', 'M'),
        },
    },

    # ------------------------------------------------------------------------------------------------ more designs: 5 name+barcode, 6 name+QR, 8 name+price+barcode, 9 name+price+QR
    'Labeldesign5_nameBarcode.dymo': {
        'base': 'Labeldesign1_1.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 1.0, W32, 12.0, 18, 'C', 'M'), 'BARCODE': box(4.0, 14.2, 47.1, 8.2), 'TextObject1': t(9.5, 22.9, 36.1, 4.0, 9, 'C', 'M')},
    },
    'Labeldesign6_nameQr.dymo': {
        'base': 'Labeldesign2.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 0.6, W32, 8.2, 15, 'C', 'M'), 'QRCodeObject0': box(3.0, 10.2, 17.0, 17.0), 'Text_barcode': t(23.0, 14.5, 30.0, 8.0, 14, 'L', 'M')},
        'lines': {'LineTitle': ('H', M32, 9.2, W32)},
    },
    'Labeldesign8_namePriceBarcode.dymo': {
        'base': 'Labeldesign1_1.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 0.6, W32, 7.4, 15, 'C', 'M'), 'TEXT_3': t(M32, 9.0, W32, 8.8, 24, 'C', 'M'), 'BARCODE': box(4.0, 18.6, 47.1, 5.6), 'TextObject1': t(9.5, 24.4, 36.1, 3.6, 7, 'C', 'M')},
        'lines': {'LineTitle': ('H', M32, 8.4, W32)},
    },
    'Labeldesign9_namePriceQr.dymo': {
        'base': 'Labeldesign2.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 0.6, W32, 7.4, 15, 'C', 'M'), 'QRCodeObject0': box(3.0, 9.6, 17.5, 17.5), 'TEXT_3': t(22.0, 10.0, 31.6, 10.5, 26, 'R', 'M'), 'Text_barcode': t(22.0, 21.0, 31.6, 5.5, 10, 'R', 'M')},
        'lines': {'LineTitle': ('H', M32, 8.4, W32)},
    },
    '70_54_Labeldesign5_nameBarcode.dymo': {
        'base': '70_54_Labeldesign_sale.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M70, 2.5, W70, 18.0, 26, 'C', 'M'), 'BARCODE': box(8.0, 24.0, 46.7, 16.0), 'TextObject1': t(8.0, 40.6, 46.7, 6.0, 12, 'C', 'M')},
    },
    '70_54_Labeldesign6_nameQr.dymo': {
        'base': '70_54_Labeldesign2.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': TITLE70, 'QRCodeObject0': box(4.0, 15.4, 32.0, 32.0), 'Text_barcode': t(38.0, 24.0, 22.7, 12.0, 16, 'C', 'M')},
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
    },
    '70_54_Labeldesign8_namePriceBarcode.dymo': {
        'base': '70_54_Labeldesign_sale.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': TITLE70, 'TEXT_3': t(M70, 14.6, W70, 14.0, 36, 'C', 'M'), 'BARCODE': box(8.0, 30.4, 46.7, 12.0), 'TextObject1': t(8.0, 43.0, 46.7, 6.0, 12, 'C', 'M')},
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
    },
    '70_54_Labeldesign9_namePriceQr.dymo': {
        'base': '70_54_Labeldesign2.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': TITLE70, 'QRCodeObject0': box(3.0, 15.0, 26.0, 26.0), 'TEXT_3': t(32.0, 16.0, 28.7, 16.0, 32, 'R', 'M'), 'Text_barcode': t(32.0, 33.0, 28.7, 8.0, 12, 'R', 'M')},
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
    },

    # ------------------------------------------------------------------------------------------------ gadget / repair shop designs: 10 price tag, 11 IMEI/serial, 12 accessory tag, 13 sale tag, repair bag tag
    'Labeldesign10_priceTag.dymo': {
        'base': 'Labeldesign1_1.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 0.6, W32, 9.0, 17, 'C', 'M'), 'TEXT_3': t(M32, 10.6, W32, 11.5, 34, 'C', 'M'),
                    'TEXT_4': t(M32, 22.8, 17.0, 3.8, 9, 'L', 'M'), 'TEXT': t(19.0, 22.8, 17.0, 3.8, 9, 'C', 'M'), 'TextObject11': t(36.5, 22.8, 17.1, 3.8, 8, 'R', 'M')},
        'lines': {'LineTitle': ('H', M32, 9.9, W32)},
    },
    'Labeldesign11_serial.dymo': {
        'base': 'Labeldesign1_1.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 0.6, W32, 6.6, 13, 'L', 'M'), 'TEXT_4': t(M32, 7.4, 26.0, 3.6, 9, 'L', 'M'), 'TEXT': t(28.0, 7.4, 25.6, 3.6, 9, 'R', 'M'),
                    'BARCODE': box(2.5, 11.6, 50.1, 9.6), 'TextObject1': t(2.5, 21.6, 50.1, 5.4, 14, 'C', 'M')},
    },
    'Labeldesign12_accessory.dymo': {
        'base': 'Labeldesign1_1.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 0.6, W32, 7.4, 15, 'C', 'M'), 'TEXT_4': t(M32, 9.2, 27.0, 4.2, 10, 'L', 'M'), 'TEXT': t(M32, 13.6, 27.0, 4.2, 10, 'L', 'M'),
                    'TEXT_3': t(29.0, 9.2, 24.6, 8.6, 22, 'R', 'M'), 'BARCODE': box(4.0, 19.2, 47.1, 5.2), 'TextObject1': t(9.5, 24.6, 36.1, 3.4, 7, 'C', 'M')},
        'lines': {'LineTitle': ('H', M32, 8.4, W32)},
    },
    'Labeldesign13_saleTag.dymo': {
        'base': 'Labeldesign_sale.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 0.6, W32, 7.4, 15, 'C', 'M'), 'Text_was': t(M32, 9.2, 24.0, 5.0, 14, 'L', 'M'), 'TEXT__1': t(28.0, 9.2, 25.6, 5.0, 13, 'R', 'M'),
                    'TEXT_3': t(M32, 14.6, W32, 7.4, 22, 'C', 'M'), 'BARCODE': box(4.0, 22.2, 47.1, 3.4), 'TextObject1': t(9.5, 25.8, 36.1, 2.6, 6, 'C', 'M')},
        'lines': {'LineTitle': ('H', M32, 8.4, W32)},
        'strike': {'LineObject0': ('H', M32, 9.2 + 2.5, 24.0)},
    },
    'LabeldesignRepairBag.dymo': {
        'base': 'LabeldesignRepair.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M32, 0.5, W32, 4.4, 10, 'L', 'M'), 'TextObject5': t(M32, 5.4, 36.0, 6.6, 18, 'L', 'M'), 'TextObject6': t(M32, 12.4, 36.0, 5.2, 15, 'L', 'M'),
                    'QRCodeObject0': box(39.5, 5.4, 14.0, 14.0), 'TEXT4': t(37.5, 19.8, 17.6, 3.2, 8, 'C', 'M'),
                    'TEXT_5': t(M32, 19.6, 34.0, 3.4, 8, 'L', 'M'), 'TextObject1': t(M32, 23.4, 34.0, 3.0, 8, 'L', 'M')},
        'lines': {'LineTitle': ('H', M32, 5.0, W32)},
    },
    '70_54_Labeldesign10_priceTag.dymo': {
        'base': '70_54_Labeldesign2.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': TITLE70, 'TEXT_3': t(M70, 15.0, W70, 19.0, 48, 'C', 'M'),
                    'TEXT_4': t(M70, 38.0, 28.0, 6.0, 14, 'L', 'M'), 'TEXT': t(32.0, 38.0, 28.7, 6.0, 14, 'R', 'M'), 'TextObject11': t(M70, 45.0, W70, 5.5, 12, 'C', 'M')},
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
    },
    '70_54_Labeldesign11_serial.dymo': {
        'base': '70_54_Labeldesign_sale.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M70, 1.5, W70, 9.0, 18, 'L', 'M'), 'TEXT_4': t(M70, 11.0, 28.0, 6.0, 13, 'L', 'M'), 'TEXT': t(32.0, 11.0, 28.7, 6.0, 13, 'R', 'M'),
                    'BARCODE': box(4.0, 19.0, 54.7, 18.0), 'TextObject1': t(M70, 38.0, W70, 9.0, 20, 'C', 'M')},
    },
    '70_54_Labeldesign12_accessory.dymo': {
        'base': '70_54_Labeldesign_sale.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': TITLE70, 'TEXT_4': t(M70, 15.2, 34.0, 6.0, 14, 'L', 'M'), 'TEXT': t(M70, 21.6, 34.0, 6.0, 14, 'L', 'M'),
                    'TEXT_3': t(38.0, 15.2, 22.7, 12.4, 28, 'R', 'M'), 'BARCODE': box(8.0, 30.0, 46.7, 12.5), 'TextObject1': t(8.0, 43.2, 46.7, 5.5, 11, 'C', 'M')},
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
    },
    '70_54_Labeldesign13_saleTag.dymo': {
        'base': '70_54_Labeldesign_sale.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': TITLE70, 'Text_was': t(M70, 15.2, 28.0, 8.0, 18, 'L', 'M'), 'TEXT__1': t(32.0, 15.2, 28.7, 8.0, 16, 'R', 'M'),
                    'TEXT_3': t(M70, 24.4, W70, 14.0, 44, 'C', 'M'), 'BARCODE': box(8.0, 40.0, 46.7, 7.0), 'TextObject1': t(8.0, 47.2, 46.7, 3.8, 9, 'C', 'M')},
        'lines': {'LineTitle': ('H', M70, 13.2, W70)},
        'strike': {'LineObject0': ('H', M70, 15.2 + 4.0, 28.0)},
    },
    '70_54_LabeldesignRepairBag.dymo': {
        'page': '70_54_Labeldesign2.dymo', 'base': '70_54_LabeldesignRepair_2.dymo', 'auto_drop': True,
        'objects': {'ItemNameVal': t(M70, 1.5, W70, 8.0, 16, 'L', 'M'), 'TextObject5': t(M70, 11.5, 38.0, 11.0, 28, 'L', 'M'), 'TextObject6': t(M70, 23.5, 38.0, 8.0, 20, 'L', 'M'),
                    'QRCodeObject0': box(43.0, 11.5, 17.7, 17.7), 'TEXT4': t(41.0, 29.6, 21.7, 4.0, 10, 'C', 'M'),
                    'TEXT_5': t(M70, 36.0, 38.0, 5.0, 12, 'L', 'M'), 'TextObject1': t(M70, 42.0, 38.0, 5.0, 11, 'L', 'M')},
        'lines': {'LineTitle': ('H', M70, 10.2, W70)},
    },
}

# which template is the design of which label (for the preview titles) and what it prints (sample values, by object name)
TITLES = {
    'Labeldesign10_priceTag.dymo': '32x57 design 10 (price tag)', 'Labeldesign11_serial.dymo': '32x57 design 11 (IMEI / serial)', 'Labeldesign12_accessory.dymo': '32x57 design 12 (accessory tag)', 'Labeldesign13_saleTag.dymo': '32x57 design 13 (sale tag)', 'LabeldesignRepairBag.dymo': '32x57 repair bag tag',
    '70_54_Labeldesign10_priceTag.dymo': '70x54 design 10 (price tag)', '70_54_Labeldesign11_serial.dymo': '70x54 design 11 (IMEI / serial)', '70_54_Labeldesign12_accessory.dymo': '70x54 design 12 (accessory tag)', '70_54_Labeldesign13_saleTag.dymo': '70x54 design 13 (sale tag)', '70_54_LabeldesignRepairBag.dymo': '70x54 repair bag tag',
    'Labeldesign5_nameBarcode.dymo': '32x57 design 5 (name + barcode)', 'Labeldesign6_nameQr.dymo': '32x57 design 6 (name + QR)', 'Labeldesign8_namePriceBarcode.dymo': '32x57 design 8 (name + price + barcode)', 'Labeldesign9_namePriceQr.dymo': '32x57 design 9 (name + price + QR)',
    '70_54_Labeldesign5_nameBarcode.dymo': '70x54 design 5 (name + barcode)', '70_54_Labeldesign6_nameQr.dymo': '70x54 design 6 (name + QR)', '70_54_Labeldesign8_namePriceBarcode.dymo': '70x54 design 8 (name + price + barcode)', '70_54_Labeldesign9_namePriceQr.dymo': '70x54 design 9 (name + price + QR)',
    '25_25_barcode.dymo': '25x25 barcode', '25_25_qrcode.dymo': '25x25 QR',
    'Labeldesign1_1.dymo': '32x57 design 1', 'Labeldesign_sale.dymo': '32x57 design 1 on sale', 'Labeldesign2.dymo': '32x57 design 2 (QR)',
    'Labeldesign3.dymo': '32x57 design 2 on sale', 'mukltipleBarcode.dymo': '32x57 design 3 (2 barcodes)', 'multipleQRCODE.dymo': '32x57 design 4 (3 QR)',
    'LabeldesignRepair.dymo': '32x57 repair label', 'labitemdesign.dymo': 'Lab item label', '25_25_repair.dymo': '25x25 repair label', '70_54_LabeldesignRepair.dymo': '70x54 repair label',
    '70_54_Labeldesign1_2_22.dymo': '70x54 design 1', '70_54_Labeldesign_sale.dymo': '70x54 design 1 on sale', '70_54_Labeldesign2.dymo': '70x54 design 2 (QR)',
    '70_54_Labeldesign3.dymo': '70x54 design 2 on sale', '70_54_mukltipleBarcode.dymo': '70x54 design 3 (2 barcodes)', '70_54_multipleQRCODE.dymo': '70x54 design 4 (3 QR)',
}
SAMPLE = {
    'ItemNameVal': 'Apple iPhone 14 Pro Max 256GB Deep Purple', 'TEXT_4': 'GRADE A', 'TEXT': '256GB', 'TEXT_1': 'UNLOCKED', 'TEXT_5': '6GB RAM', 'TEXT__1': 'DEEP PURPLE',
    'TEXT_3': '£649.99', 'TextObject11': '12 MONTHS WARRANTY', 'BARCODE': '1002345678', 'TextObject1': '1002345678', 'Text_barcode': '1002345678', 'Text_was': '£749.99',
    'TextObject9': '£749.99',
}
SAMPLE_BY_TEMPLATE = {
    'Labeldesign13_saleTag.dymo': {'TEXT__1': '£100.00 OFF', 'TEXT_3': '£549.99'}, '70_54_Labeldesign13_saleTag.dymo': {'TEXT__1': '£100.00 OFF', 'TEXT_3': '£549.99'},
    'Labeldesign11_serial.dymo': {'TEXT_4': 'GRADE A', 'TEXT': '256GB', 'TextObject1': '357771570289459', 'BARCODE': '357771570289459'},
    '70_54_Labeldesign11_serial.dymo': {'TEXT_4': 'GRADE A', 'TEXT': '256GB', 'TextObject1': '357771570289459', 'BARCODE': '357771570289459'},
    'Labeldesign12_accessory.dymo': {'ItemNameVal': 'USB-C Fast Charger 20W', 'TEXT_4': 'NEW', 'TEXT': 'WHITE', 'TEXT_3': '£14.99'}, '70_54_Labeldesign12_accessory.dymo': {'ItemNameVal': 'USB-C Fast Charger 20W', 'TEXT_4': 'NEW', 'TEXT': 'WHITE', 'TEXT_3': '£14.99'},
    'LabeldesignRepairBag.dymo': {'ItemNameVal': 'iPhone 13 Screen repair', 'TextObject5': 'Muhammad Qaisar', 'TextObject6': '07911 123456', 'TEXT_5': 'Gadgets Shop Leeds', 'TextObject1': '20/11/2026', 'TEXT4': 'R-1042'},
    '70_54_LabeldesignRepairBag.dymo': {'ItemNameVal': 'iPhone 13 Screen repair', 'TextObject5': 'Muhammad Qaisar', 'TextObject6': '07911 123456', 'TEXT_5': 'Gadgets Shop Leeds', 'TextObject1': '20/11/2026', 'TEXT4': 'R-1042'},
    'Labeldesign_sale.dymo': {'TEXT__1': '£100.00 OFF'}, '70_54_Labeldesign_sale.dymo': {'TEXT__1': '£100.00 OFF'},
    'Labeldesign3.dymo': {'TextObject1': '£100.00 OFF', 'TEXT__1': 'DEEP PURPLE'}, '70_54_Labeldesign3.dymo': {'TextObject1': '£100.00 OFF'},
    'mukltipleBarcode.dymo': {'TextObject1': '£649.99', 'TextObject12': '£649.99'}, '70_54_mukltipleBarcode.dymo': {'TextObject1': '£649.99', 'TextObject12': '£649.99'},
    'multipleQRCODE.dymo': {'TextObject12': '£649.99', 'TextObject1': '£649.99', 'TextObject2': '£649.99', 'TextObject3': '5678', 'TextObject4': '5678', 'TextObject5': '5678'},
    '70_54_multipleQRCODE.dymo': {'TextObject12': '£649.99', 'TextObject1': '£649.99', 'TextObject2': '£649.99', 'TextObject3': '5678', 'TextObject4': '5678', 'TextObject5': '5678'},
    '25_25_barcode.dymo': {'TextObject1': '£49.99'}, '25_25_qrcode.dymo': {'TextObject2': '£49.99', 'TextObject3': '5678'},
    'labitemdesign.dymo': {'TextObject12': 'LAB-2231 Samsung S23 board'},
    '25_25_repair.dymo': {'TextObject2': 'Muhammad Q', 'TextObject3': 'R-1042'},
    '70_54_LabeldesignRepair.dymo': {'ItemNameVal': 'iPhone 13 Screen repair', 'TEXT': 'IMEI 356938035643809', 'TEXT8': 'Passcode 4821', 'TEXT9': 'Cracked back glass too', 'TextObject5': 'Muhammad Qaisar', 'TextObject6': '07911 123456',
                               'TEXT_5': 'Gadgets Shop Leeds', 'TextObject1': '20/11/2026', 'TEXT4': '1002345678', 'TextObject7': '', 'TextObject10': 'Tested'},
    'LabeldesignRepair.dymo': {'ItemNameVal': 'iPhone 13 Screen repair', 'TEXT': 'IMEI 356938035643809', 'TEXT8': 'Passcode 4821', 'TEXT9': 'Cracked back glass too', 'TextObject5': 'Muhammad Qaisar', 'TextObject6': '07911 123456',
                               'TEXT_5': 'Gadgets Shop Leeds', 'TextObject1': '20/11/2026', 'TEXT4': '1002345678', 'TextObject7': '', 'TextObject10': 'Tested'},
}

# ----------------------------------------------------------------------------------------------------------------------------------
# reading and writing the .dymo XML (kept as text: the files keep their byte-for-byte shape apart from what is changed here)
# ----------------------------------------------------------------------------------------------------------------------------------
OBJ_TAGS = ('TextObject', 'BarcodeObject', 'QRCodeObject', 'LineObject', 'ShapeObject')
OBJ_RE = re.compile(r'<(' + '|'.join(OBJ_TAGS) + r')>.*?</\1>', re.S)

def read(path):
    return open(path, encoding='utf-8-sig', newline='').read()

def write(path, text):
    open(path, 'w', encoding='utf-8-sig', newline='').write(text)

def name_of(block):
    return re.search(r'<Name>([^<]*)</Name>', block).group(1)

def page_of(xml):
    m = re.search(r'<DYMORect>\s*<DYMOPoint>\s*<X>([^<]*)</X>\s*<Y>([^<]*)</Y>\s*</DYMOPoint>\s*<Size>\s*<Width>([^<]*)</Width>\s*<Height>([^<]*)</Height>', xml)
    return [float(m.group(i)) for i in range(1, 5)], m.group(0)

def set_tag(block, tag, value, count=0):
    return re.sub(rf'(<{tag}>)[^<]*(</{tag}>)', lambda m: f'{m.group(1)}{value}{m.group(2)}', block, count=count)

def layout(block, x, y, w, h, rx, ry):
    def fix(m):
        s = m.group(0)
        for tag, val in (('X', rx + x / MM), ('Y', ry + y / MM), ('Width', w / MM), ('Height', h / MM)):
            s = set_tag(s, tag, f'{val:.6f}', 1)
        return s
    return re.sub(r'<ObjectLayout>.*?</ObjectLayout>', fix, block, count=1, flags=re.S)

H_NAMES = {'L': 'Left', 'C': 'Center', 'R': 'Right'}
V_NAMES = {'T': 'Top', 'M': 'Middle', 'B': 'Bottom'}

def style_text(block, fs, ha, va):
    block = set_tag(block, 'FontSize', f'{fs:g}')
    block = set_tag(block, 'IsBold', 'True')
    block = set_tag(block, 'HorizontalAlignment', H_NAMES[ha])
    block = set_tag(block, 'VerticalAlignment', V_NAMES[va])
    return block

def line_block(template_block, name, kind, x, y, length, rx, ry):
    """A horizontal (or vertical) rule built from an existing LineObject of the templates. The line is drawn through the middle of its rectangle."""
    block = set_tag(template_block, 'Name', name, 1)
    block = set_tag(block, 'LineType', 'Horizontal' if kind == 'H' else 'Vertical', 1)
    if kind == 'H':
        return layout(block, x, y - 0.15, length, 0.3, rx, ry)
    return layout(block, x - 0.15, y, 0.3, length, rx, ry)

def build(target):
    spec = LAYOUTS[target]
    xml = read(os.path.join(ORIG, spec.get('base', target)))
    # the page: label type, orientation and printable rectangle come from the reference template of that label size
    if 'page' in spec:
        ref = read(os.path.join(ORIG, spec['page']))
        for tag in ('LabelName', 'Orientation'):
            xml = set_tag(xml, tag, re.search(rf'<{tag}>([^<]*)</{tag}>', ref).group(1), 1)
        (rx, ry, w, h), old = page_of(ref)
        xml = xml.replace(page_of(xml)[1], old, 1)
    (rx, ry, pw, ph), _ = page_of(xml)
    line_source = None
    for m in OBJ_RE.finditer(read(os.path.join(ORIG, 'mukltipleBarcode.dymo'))):
        if m.group(1) == 'LineObject':
            line_source = m.group(0)
    if spec.get('copy'):
        donor = read(os.path.join(ORIG, 'LabeldesignRepair.dymo'))
        blocks = [m.group(0) for m in OBJ_RE.finditer(donor) if name_of(m.group(0)) in spec['copy']]
        xml = xml.replace('</LabelObjects>', ''.join(blocks) + '</LabelObjects>', 1)
    objects, seen = spec['objects'], set()
    strike = {**spec.get('strike', {}), **spec.get('cut', {})}

    def rewrite(m):
        block, tag, name = m.group(0), m.group(1), name_of(m.group(0))
        if name in strike:
            kind, x, y, length = strike[name]
            return line_block(block, name, kind, x, y, length, rx, ry)
        if name not in objects and spec.get('auto_drop'):
            return ''  # this design does not use the object: it is removed from the template (it would print its placeholder text)
        if name not in objects:
            raise SystemExit(f'{target}: object {name} has no layout (it would keep its old place)')
        seen.add(name)
        x, y, w, h, fs, ha, va = objects[name]
        block = set_tag(block, 'Rotation', 'Rotation0', 1)
        block = layout(block, x, y, w, h, rx, ry)
        if tag == 'TextObject':
            block = style_text(block, fs, ha, va)
        return block
    xml = OBJ_RE.sub(rewrite, xml)
    missing = set(objects) - seen
    if missing:
        raise SystemExit(f'{target}: layout names objects the template does not have: {sorted(missing)}')
    extra = ''.join(line_block(line_source, name, kind, x, y, length, rx, ry) for name, (kind, x, y, length) in spec.get('lines', {}).items())
    if extra:
        xml = xml.replace('</LabelObjects>', extra + '</LabelObjects>', 1)
    return xml

# ----------------------------------------------------------------------------------------------------------------------------------
# a model of a label (for the audit and the preview), read from any .dymo text
# ----------------------------------------------------------------------------------------------------------------------------------
def model(xml):
    (rx, ry, pw, ph), _ = page_of(xml)
    objs = []
    for m in OBJ_RE.finditer(xml):
        b = m.group(0)
        g = lambda tag: float(re.search(rf'<{tag}>([^<]*)</{tag}>', re.search(r'<ObjectLayout>.*?</ObjectLayout>', b, re.S).group(0)).group(1))
        o = {'type': m.group(1), 'name': name_of(b), 'x': (g('X') - rx) * MM, 'y': (g('Y') - ry) * MM, 'w': g('Width') * MM, 'h': g('Height') * MM,
             'rot': re.search(r'<Rotation>([^<]*)</Rotation>', b).group(1)}
        if m.group(1) == 'TextObject':
            o['fs'] = float(re.search(r'<FontSize>([^<]*)</FontSize>', b).group(1))
            o['ha'] = re.search(r'<HorizontalAlignment>([^<]*)</HorizontalAlignment>', b).group(1)
            o['va'] = re.search(r'<VerticalAlignment>([^<]*)</VerticalAlignment>', b).group(1)
        if m.group(1) == 'LineObject':
            o['line'] = re.search(r'<LineType>([^<]*)</LineType>', b).group(1)
        objs.append(o)
    return {'W': pw * MM, 'H': ph * MM, 'orient': re.search(r'<Orientation>([^<]*)</Orientation>', xml).group(1), 'label': re.search(r'<LabelName>([^<]*)</LabelName>', xml).group(1), 'objs': objs}

def fit(text, w, h, cap=40):
    """DYMO 'always fit': the largest font (pt) at which the text, wrapped on words, fits the box. 0.57 em per bold character, 1.15 line height."""
    words = text.split() or ['']
    best = (4.0, [text])
    for f in [x / 2 for x in range(8, cap * 2 + 1)]:
        cw, lh = 0.57 * f * 25.4 / 72, 1.15 * f * 25.4 / 72
        lines, cur = [], ''
        for word in words:
            trial = (cur + ' ' + word).strip()
            if len(trial) * cw <= w or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
        if len(lines) * lh <= h and max(len(l) for l in lines) * cw <= w:
            best = (f, lines)
    return best

def audit(m, title):
    flags = []
    for o in m['objs']:
        if o['x'] < -0.2 or o['y'] < -0.2 or o['x'] + o['w'] > m['W'] + 0.2 or o['y'] + o['h'] > m['H'] + 0.2:
            flags.append(f'{o["name"]} leaves the label')
    body = [o for o in m['objs'] if o['type'] in ('TextObject', 'BarcodeObject', 'QRCodeObject') and o.get('rot') == 'Rotation0']
    for i, a in enumerate(body):
        for b in body[i + 1:]:
            ix, iy = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x']), min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y'])
            if ix > 0.3 and iy > 0.3:
                flags.append(f'{a["name"]} overlaps {b["name"]} ({ix:.1f} x {iy:.1f} mm)')
    return flags

def svg(m, values, scale=7.0):
    W, H = m['W'], m['H']
    S = scale
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W * S + 4:.0f}" height="{H * S + 4:.0f}" viewBox="-2 -2 {W * S + 4:.1f} {H * S + 4:.1f}">',
         f'<rect x="0" y="0" width="{W * S:.1f}" height="{H * S:.1f}" rx="{2.2 * S:.1f}" fill="#fff" stroke="#9aa" stroke-width="1"/>']
    for b in m['objs']:
        x, y, w, h = b['x'] * S, b['y'] * S, b['w'] * S, b['h'] * S
        if b['type'] == 'TextObject':
            text = values.get(b['name'], '')
            rot = b['rot'] == 'Rotation270'
            bw, bh = (b['h'], b['w']) if rot else (b['w'], b['h'])
            f, lines = fit(text, bw, bh) if text else (b['fs'], [''])
            lh = 1.15 * f * 25.4 / 72 * S
            fsz = f * 25.4 / 72 * S
            n = len(lines)
            ha = {'Left': 'start', 'Center': 'middle', 'Right': 'end'}[b['ha']]
            fx = {'Left': 0, 'Center': bw * S / 2, 'Right': bw * S}[b['ha']]
            top = {'Top': 0, 'Middle': (bh * S - n * lh) / 2, 'Bottom': bh * S - n * lh}[b['va']]
            g = f'<g transform="translate({x:.1f},{y:.1f})">' if not rot else f'<g transform="translate({x:.1f},{y + h:.1f}) rotate(-90)">'
            o.append(g + f'<rect width="{bw * S:.1f}" height="{bh * S:.1f}" fill="none" stroke="rgba(40,110,255,.25)" stroke-width=".6"/>')
            for i, line in enumerate(lines):
                o.append(f'<text x="{fx:.1f}" y="{top + i * lh + fsz * 0.98:.1f}" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="{fsz:.1f}" text-anchor="{ha}">{html.escape(line)}</text>')
            o.append('</g>')
        elif b['type'] == 'BarcodeObject':
            rnd = random.Random(7)
            cx = x
            while cx < x + w - 1.5:
                bw_ = rnd.choice([0.7, 1.1, 1.6, 2.2]) * S / 3.5
                o.append(f'<rect x="{cx:.1f}" y="{y:.1f}" width="{bw_:.1f}" height="{h:.1f}" fill="#000"/>')
                cx += bw_ + rnd.choice([0.8, 1.2, 1.8]) * S / 3.5
        elif b['type'] == 'QRCodeObject':
            side = min(w, h)
            x0, y0 = x + (w - side) / 2, y + (h - side) / 2
            rnd, n = random.Random(3), 15
            o.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{side:.1f}" height="{side:.1f}" fill="#fff"/>')
            for i in range(n):
                for j in range(n):
                    corner = (i < 4 and j < 4) or (i > n - 5 and j < 4) or (i < 4 and j > n - 5)
                    if corner or rnd.random() < .48:
                        o.append(f'<rect x="{x0 + i * side / n:.1f}" y="{y0 + j * side / n:.1f}" width="{side / n:.2f}" height="{side / n:.2f}" fill="#000"/>')
        elif b['type'] == 'LineObject':
            if b['line'] == 'Horizontal':
                o.append(f'<line x1="{x:.1f}" y1="{y + h / 2:.1f}" x2="{x + w:.1f}" y2="{y + h / 2:.1f}" stroke="#000" stroke-width="{0.35 * S:.1f}"/>')
            else:
                o.append(f'<line x1="{x + w / 2:.1f}" y1="{y:.1f}" x2="{x + w / 2:.1f}" y2="{y + h:.1f}" stroke="#000" stroke-width="{0.35 * S:.1f}"/>')
        else:
            o.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="none" stroke="#000" stroke-width="{0.3 * S:.1f}"/>')
    o.append('</svg>')
    return ''.join(o)

def values_for(target, m):
    v = dict(SAMPLE)
    v.update(SAMPLE_BY_TEMPLATE.get(target, {}))
    return v

def main(check_only):
    cards, problems, geometry = [], 0, {}
    for target in LAYOUTS:
        before = model(read(os.path.join(ORIG, target if os.path.exists(os.path.join(ORIG, target)) and 'base' not in LAYOUTS[target] else LAYOUTS[target].get('base', target)))) if True else None
        new_xml = build(target)
        after = model(new_xml)
        flags = audit(after, target)
        problems += len(flags)
        geometry[target] = {'w': round(after['W'], 2), 'h': round(after['H'], 2), 'orientation': after['orient'], 'labelType': after['label'],
                            'objects': [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in o.items() if k in ('type', 'name', 'x', 'y', 'w', 'h', 'fs', 'ha', 'va', 'line')} for o in after['objs']]}
        if not check_only:
            write(os.path.join(OUT, target), new_xml)
        vals = values_for(target, after)
        label = LAYOUTS[target].get('base')
        before_note = '' if not label else '<small>(it was a copy of the small 32x57 label)</small>'
        cards.append(
            f'<section><h3>{html.escape(TITLES[target])} <small>{html.escape(target)} &middot; {after["W"]:.1f}&times;{after["H"]:.1f} mm &middot; {after["orient"]} &middot; {html.escape(after["label"])}</small></h3>'
            f'<div class="pair"><figure>{svg(before, vals)}<figcaption>before {before_note}</figcaption></figure><figure>{svg(after, vals)}<figcaption>after</figcaption></figure></div>'
            + ''.join(f'<p class="flag">&#9888; {html.escape(f)}</p>' for f in flags) + '</section>')
        print(f'{TITLES[target]:32} {target:32} {len(after["objs"]):2} objects  {"OK" if not flags else "; ".join(flags)}')
    if not check_only:
        import json
        os.makedirs(os.path.join(ROOT, 'docs', 'label-design'), exist_ok=True)
        with open(os.path.join(ROOT, 'docs', 'label-design', 'geometry.json'), 'w') as handle:
            json.dump(geometry, handle, indent=1)
        write(os.path.join(ROOT, 'docs', 'label-design', 'preview.html'),
              '<!doctype html><meta charset="utf-8"><title>DYMO label designs</title>'
              '<style>body{font-family:system-ui,Arial;margin:18px;background:#eef0f4;color:#1d2230}h1{font-size:20px}p.n{max-width:900px;color:#445;font-size:13px}'
              'section{background:#fff;border-radius:12px;padding:14px 16px;margin:0 0 16px}h3{margin:0 0 10px;font-size:15px}small{color:#667;font-weight:400;margin-left:8px}'
              '.pair{display:flex;gap:26px;flex-wrap:wrap}figure{margin:0}figcaption{font-size:12px;color:#556;margin-top:4px}.flag{color:#b00;font-size:12px;margin:6px 0 0}</style>'
              '<h1>DYMO label designs: before and after</h1><p class="n">Drawn from the .dymo files (1 mm = 7 px) with sample values and an approximation of DYMO\'s "always fit" text. '
              'It shows layout, not the exact printed result: print one label of every design on a real DYMO before using it in a shop.</p>' + ''.join(cards))
    print(f'\n{problems} problem(s)')
    return 1 if problems else 0

if __name__ == '__main__':
    sys.exit(main('--check' in sys.argv))
